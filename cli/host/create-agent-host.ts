import { join } from "node:path";
import type { AgentConfiguration } from "@agent-harness/configuration/configuration";
import type { AgentRunHandle } from "@agent-harness/core/agent-contract";
import type {
  ModelClientFactory,
  ModelMessage,
  ModelRequest,
} from "@agent-harness/core/model/model-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import { snapshot } from "@agent-harness/core/protocol-values";
import { createSessionHost, type SessionHost } from "@agent-harness/core/session-host";
import { createNodeLogs, type NodeLogs } from "@agent-harness/logs/node-logs";
import type { createModelProvider } from "@agent-harness/models/models";
import {
  type PreparedConfiguredModel,
  prepareConfiguredModel,
} from "./configured-model-factory.js";
import type { HostToolsMode } from "./host-contract.js";
import type { HostSessionBinding } from "./host-session-binding.js";
import { createSqliteAgentStores, type SqliteAgentStores } from "./sqlite-agent-stores.js";
import { createWorkspaceConfiguration } from "./workspace-configuration.js";

export interface AgentHostOptions {
  readonly configuration: AgentConfiguration["runtime"];
  readonly applicationDataRoot: string;
  readonly workspaceRoot: string;
  readonly toolMode?: HostToolsMode;
  readonly modelId: string;
  readonly threadId: string;
  readonly agentId?: string;
  readonly resume?: boolean;
  readonly signal?: AbortSignal;
  readonly requireReadApproval?: boolean;
  readonly createProvider?: typeof createModelProvider;
}
export interface AgentHost extends SessionHost {
  readonly binding: HostSessionBinding;
  selectModel(modelId: string): Promise<void>;
}

/** 只转换模型传输，不改写规范历史、检查点或工具结果。私有重放不能跨模型签名。 */
function modelHistoryTransport(
  models: ModelClientFactory,
  historyStart: () => number,
): ModelClientFactory {
  function project(request: ModelRequest): ModelRequest {
    const count = historyStart();
    if (count === 0) return request;
    const offset = request.messages[0]?.role === "system" ? 1 : 0;
    const messages: ModelMessage[] = [];
    for (let index = 0; index < request.messages.length; index++) {
      const message = request.messages[index]!;
      if (index >= offset && index < offset + count && message.role === "assistant") {
        const content = message.content.filter((part) => part.type !== "reasoning");
        if (content.length) messages.push({ role: "assistant", content });
      } else {
        messages.push(message);
      }
    }
    return { ...request, messages };
  }
  return {
    async create(selection, signal) {
      const binding = await models.create(selection, signal);
      return {
        dispose: () => binding.dispose(),
        client: {
          selection: binding.client.selection,
          capabilities: binding.client.capabilities,
          generate: (request, signal, context) =>
            binding.client.generate(project(request), signal, context),
          stream: (request, signal, context) =>
            binding.client.stream(project(request), signal, context),
        },
      };
    },
  };
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
    agentId = "cli-agent",
    resume = false,
    signal = new AbortController().signal,
    requireReadApproval,
    createProvider,
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
  let selectedModelId = modelId;
  let active: AgentRunHandle | undefined;
  let operating = false;
  let switching: Promise<void> | undefined;
  let failed: AgentError | undefined;
  const retired: Array<{ dispose(): void | Promise<void> }> = [];
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      await switching;
      const errors: unknown[] = [];
      // 先排空 Agent 执行，再释放模型凭据与存储，避免活动 Run 使用已关闭的依赖。
      for (const resource of [
        session,
        ...retired,
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
      directory: join(applicationDataRoot, "logs"),
      terminal: { enabled: false },
      file: { enabled: true },
    });
    const workspace = await createWorkspaceConfiguration({
      workspaceRoot,
      ...(toolMode === undefined ? {} : { toolMode }),
      logger: logs.getLogger("tools"),
      ...(requireReadApproval === undefined ? {} : { requireReadApproval }),
    });
    const { definition, plugins, authorizeTool } = workspace;
    signal.throwIfAborted();
    prepared = await prepareConfiguredModel(
      configuration,
      modelId,
      signal,
      logs.getLogger("models"),
      createProvider,
    );
    // 工作目录属于宿主权限边界；先固化绑定，禁止同一历史在恢复时换到另一个目录。
    let binding: HostSessionBinding = snapshot({
      schemaVersion: 3,
      generation: 0,
      modelHistoryStart: 0,
      agentId,
      threadId,
      workspaceRoot: workspace.workspaceRoot,
      toolMode: workspace.mode,
      model: prepared.selection,
      connectionFingerprint: prepared.connectionFingerprint,
      definition: { id: definition.id, version: definition.version },
      plugins: plugins.map(({ id, version }) => ({ id, version })),
      maxSteps: prepared.maxSteps,
    });
    stores = createSqliteAgentStores(join(applicationDataRoot, "sessions.sqlite"));
    const bindings = stores.bindings;
    const persisted = await bindings.read(threadId);
    if (resume && !persisted) {
      throw new AgentError("HOST_SESSION_NOT_FOUND", "找不到已绑定的会话，不能恢复。");
    }
    if (persisted) {
      const { generation: _generation, modelHistoryStart: _historyStart, ...identity } = binding;
      binding = snapshot({
        ...identity,
        schemaVersion: persisted.schemaVersion,
        ...(persisted.schemaVersion === 3
          ? { generation: persisted.generation, modelHistoryStart: persisted.modelHistoryStart }
          : {}),
      });
    }
    const assemble = (model: PreparedConfiguredModel): Promise<SessionHost> =>
      createSessionHost({
        services: {
          models: modelHistoryTransport(model.models, () => binding.modelHistoryStart ?? 0),
          history: stores!.history,
          checkpoints: stores!.checkpoints,
          authorizeTool,
        },
        agent: {
          agentId,
          definition,
          model: model.selection,
          maxSteps: model.maxSteps,
          plugins,
          signal,
        },
        threadId,
        binding: { ensure: () => bindings.ensure(binding) },
      });
    session = await assemble(prepared);
    signal.throwIfAborted();
    const ensureOpen = () => {
      if (closing) throw new AgentError("HOST_CLOSED", "宿主已经关闭。");
      if (failed) throw failed;
      if (operating || active) throw new AgentError("HOST_BUSY", "当前执行或模型切换尚未完成。");
    };
    const track = (handle: AgentRunHandle): AgentRunHandle => {
      active = handle;
      void handle.completed.then(
        () => {
          if (active === handle) active = undefined;
        },
        () => {
          if (active === handle) active = undefined;
        },
      );
      return handle;
    };
    return {
      get binding() {
        return snapshot(binding);
      },
      async selectModel(nextModelId) {
        ensureOpen();
        operating = true;
        const settled = Promise.withResolvers<void>();
        switching = settled.promise;
        let nextModel: PreparedConfiguredModel | undefined;
        let nextSession: SessionHost | undefined;
        let retiring = false;
        let oldClosed = false;
        const originalModelId = selectedModelId;
        try {
          await bindings.assertIdle(binding);
          if (nextModelId === selectedModelId) return;
          nextModel = await prepareConfiguredModel(
            configuration,
            nextModelId,
            signal,
            logs!.getLogger("models"),
            createProvider,
          );
          nextSession = await assemble(nextModel);
          // 准备过程中其他窗口可能取得租约；关闭旧实例之前再次检查。
          await bindings.assertIdle(binding);
          signal.throwIfAborted();
          if (closing) throw new AgentError("HOST_CLOSED", "宿主已经关闭。");
          retiring = true;
          await session!.close();
          await prepared!.dispose();
          oldClosed = true;
          signal.throwIfAborted();
          if (closing) throw new AgentError("HOST_CLOSED", "宿主已经关闭。");
          // CAS、空闲校验和历史边界在同一个 SQLite 写事务中提交。
          binding = await bindings.replaceModel(binding, {
            model: nextModel.selection,
            connectionFingerprint: nextModel.connectionFingerprint,
            maxSteps: nextModel.maxSteps,
          });
          session = nextSession;
          prepared = nextModel;
          selectedModelId = nextModelId;
          nextSession = undefined;
          nextModel = undefined;
        } catch (error) {
          const cleanupErrors: unknown[] = [];
          for (const resource of [nextSession, nextModel]) {
            try {
              await resource?.dispose();
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
              retired.push(resource!);
            }
          }
          if (retiring && !closing && !signal.aborted) {
            // close 失败或 CAS 输给另一个写者时，重新取得 A 的资源；不复用已关闭实例。
            const oldSession = session!;
            const oldModel = prepared!;
            let restored: PreparedConfiguredModel | undefined;
            try {
              restored = await prepareConfiguredModel(
                configuration,
                originalModelId,
                signal,
                logs!.getLogger("models"),
                createProvider,
              );
              const restoredSession = await assemble(restored);
              session = restoredSession;
              prepared = restored;
              if (!oldClosed) retired.push(oldSession, oldModel);
            } catch {
              if (restored) retired.push(restored);
              failed = new AgentError(
                "HOST_SWITCH_RECOVERY_FAILED",
                "模型切换失败且原实例无法重新就绪；持久绑定未改写，请重新打开会话。",
              );
              throw failed;
            }
            if (oldClosed) throw error;
            throw new AgentError("HOST_CLOSE_FAILED", "旧实例关闭失败，原模型已重新就绪。");
          }
          if (cleanupErrors.length)
            throw new AgentError("HOST_CLOSE_FAILED", "目标模型准备失败且资源回收失败。");
          throw error;
        } finally {
          operating = false;
          switching = undefined;
          settled.resolve();
        }
      },
      async run(input) {
        ensureOpen();
        operating = true;
        try {
          return track(await session!.run(input));
        } finally {
          operating = false;
        }
      },
      async resume(input) {
        ensureOpen();
        operating = true;
        try {
          return track(await session!.resume(input));
        } finally {
          operating = false;
        }
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
