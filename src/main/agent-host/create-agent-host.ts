import { join } from "node:path";
import { AgentError } from "@agent-harness/core/protocol-errors";
import { snapshot } from "@agent-harness/core/protocol-values";
import { createSessionHost, type SessionHost } from "@agent-harness/core/session-host";
import { createNodeLogs, type NodeLogs } from "@agent-harness/logs/node-logs";
import type { ToolsMode } from "../../tools/tools";
import type { AgentConfiguration } from "../agent-configuration";
import { type PreparedConfiguredModel, prepareConfiguredModel } from "./configured-model-factory";
import type { HostSessionBinding } from "./host-session-binding";
import { createSqliteAgentStores, type SqliteAgentStores } from "./sqlite-agent-stores";
import { createWorkspaceConfiguration } from "./workspace-configuration";

export interface AgentHostOptions {
  readonly configuration: AgentConfiguration["runtime"];
  readonly applicationDataRoot: string;
  readonly workspaceRoot: string;
  readonly toolMode?: ToolsMode;
  readonly modelId: string;
  readonly threadId: string;
  readonly agentId?: string;
  readonly resume?: boolean;
  readonly signal?: AbortSignal;
}
export interface AgentHost extends SessionHost {
  readonly binding: HostSessionBinding;
}

/** 这个组合根拥有新链路资源；不借用生产 Agent、会话库或 PPT 上下文。 */
export async function createAgentHost(options: AgentHostOptions): Promise<AgentHost> {
  // 创建期间只使用这组固定选项，异步准备不能令绑定与实际装配跟随外部修改。
  const {
    configuration,
    applicationDataRoot,
    workspaceRoot,
    toolMode,
    modelId,
    threadId,
    agentId = "development-agent",
    resume = false,
    signal = new AbortController().signal,
  } = options;
  signal.throwIfAborted();
  if (!threadId.trim() || !modelId.trim() || !agentId.trim()) {
    throw new AgentError("HOST_OPTIONS_INVALID", "需要有效的会话、模型与 Agent 标识。");
  }
  let prepared: PreparedConfiguredModel | undefined;
  let stores: SqliteAgentStores | undefined;
  let session: SessionHost | undefined;
  let closing: Promise<void> | undefined;
  let logs: NodeLogs | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      // 先排空 Agent 执行，再释放模型凭据与存储，避免活动 Run 使用已关闭的依赖。
      for (const resource of [
        session,
        prepared,
        stores,
        logs && { dispose: () => logs!.close() },
      ]) {
        try {
          await resource?.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AgentError("HOST_CLOSE_FAILED", "宿主资源关闭失败，不能确认清理完成。");
    });
    return closing;
  };
  try {
    logs = await createNodeLogs({
      directory: join(applicationDataRoot, "agent-development-logs"),
      terminal: { enabled: false },
      file: { enabled: true },
    });
    const workspace = await createWorkspaceConfiguration({
      workspaceRoot,
      ...(toolMode === undefined ? {} : { toolMode }),
      logger: logs.getLogger("tools"),
    });
    const { definition, plugin, authorizeTool } = workspace;
    signal.throwIfAborted();
    prepared = await prepareConfiguredModel(
      configuration,
      modelId,
      signal,
      logs.getLogger("models"),
    );
    // 工作目录属于宿主权限边界；先固化绑定，禁止同一历史在恢复时换到另一个目录。
    const binding: HostSessionBinding = snapshot({
      schemaVersion: 2,
      agentId,
      threadId,
      workspaceRoot: plugin.workspaceRoot,
      toolMode: plugin.mode,
      model: prepared.selection,
      connectionFingerprint: prepared.connectionFingerprint,
      definition: { id: definition.id, version: definition.version },
      plugins: [{ id: plugin.id, version: plugin.version }],
      maxSteps: prepared.maxSteps,
    });
    stores = createSqliteAgentStores(join(applicationDataRoot, "agent-development.sqlite"));
    const bindings = stores.bindings;
    session = await createSessionHost({
      services: {
        models: prepared.models,
        history: stores.history,
        checkpoints: stores.checkpoints,
        authorizeTool,
      },
      agent: {
        agentId,
        definition,
        model: prepared.selection,
        maxSteps: prepared.maxSteps,
        plugins: [plugin],
        signal,
      },
      threadId,
      binding: {
        async ensure() {
          if (resume && !(await bindings.read(binding.threadId))) {
            throw new AgentError("HOST_SESSION_NOT_FOUND", "找不到已绑定的开发会话，不能恢复。");
          }
          await bindings.ensure(binding);
        },
      },
    });
    signal.throwIfAborted();
    const openedSession = session;
    const ensureOpen = () => {
      if (closing) throw new AgentError("HOST_CLOSED", "开发宿主已经关闭。");
    };
    return {
      get binding() {
        return snapshot(binding);
      },
      async run(input) {
        ensureOpen();
        return openedSession.run(input);
      },
      async resume(input) {
        ensureOpen();
        return openedSession.resume(input);
      },
      close,
      dispose: close,
    };
  } catch (error) {
    try {
      await close();
    } catch {
      throw new AgentError("HOST_START_AND_CLOSE_FAILED", "宿主启动及资源回收失败。");
    }
    throw error;
  }
}
