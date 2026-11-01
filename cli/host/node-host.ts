import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  type AgentConfiguration,
  createAgentConfiguration,
} from "@agent-harness/configuration/configuration";
import type { CredentialProtection } from "@agent-harness/configuration/credential-contract";
import { createNodeCredentialProtection } from "@agent-harness/configuration/node-credentials";
import type { AgentRunHandle } from "@agent-harness/core/agent-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import type { InteractionRequest } from "@agent-harness/core/protocol-values";
import type { createModelProvider } from "@agent-harness/models/models";
import { prepareWorkspaceRoot } from "@agent-harness/tools/tools";
import { type AgentHost, createAgentHost } from "./create-agent-host.js";
import type {
  NodeHostOptions,
  TerminalConnectionTarget,
  TerminalHost,
  TerminalHostContext,
  TerminalHostOpenOptions,
  TerminalHostSession,
  TerminalSetupIO,
  TerminalToolsMode,
} from "./host-contract.js";
import { type ConfiguredModelItem, configuredModels } from "./model-catalog.js";
import { configuredConnections, ensureConfiguredModel } from "./model-setup.js";
import { listHostSessions } from "./session-directory.js";
import { parseWorkspaceApproval } from "./workspace-configuration.js";

/** 显式依赖注入仅供真实宿主集成；生产入口不从环境或命令行启用替身。 */
export interface NodeHostIntegrationOptions extends NodeHostOptions {
  readonly configuration?: AgentConfiguration;
  readonly credentialProtection?: CredentialProtection;
  readonly createProvider?: typeof createModelProvider;
  readonly requireReadApproval?: boolean;
}

export function createNodeHost(options: NodeHostOptions): TerminalHost;
export function createNodeHost(options: NodeHostIntegrationOptions): TerminalHost;
export function createNodeHost(options: NodeHostIntegrationOptions): TerminalHost {
  const dataRoot = resolve(options.dataRoot);
  const workspacePath = resolve(options.workspaceRoot);
  const lifetime = new AbortController();
  const protection =
    options.credentialProtection ?? createNodeCredentialProtection({ signal: lifetime.signal });
  const configuration =
    options.configuration ??
    createAgentConfiguration({
      applicationDataRoot: dataRoot,
      credentialProtection: protection,
      defaultTemplateId: "none",
      environment: {},
    });
  const createProvider = options.createProvider;
  const requireReadApproval = options.requireReadApproval ?? false;
  let workspaceRoot: string | undefined;
  let current: AgentHost | undefined;
  let context: TerminalHostContext | undefined;
  let active: AgentRunHandle | undefined;
  let transition: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;

  function ensureOpen(): AgentHost {
    if (closing) throw new AgentError("HOST_CLOSED", "Node 宿主已经关闭。");
    if (!current) throw new AgentError("HOST_NOT_OPEN", "请先打开 Node 宿主。");
    return current;
  }
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new AgentError("HOST_CLOSED", "Node 宿主已经关闭。"));
    if (transition || active)
      return Promise.reject(new AgentError("HOST_BUSY", "当前执行或会话切换尚未完成。"));
    const result = Promise.resolve().then(operation);
    transition = result;
    void result.then(
      () => {
        if (transition === result) transition = undefined;
      },
      () => {
        if (transition === result) transition = undefined;
      },
    );
    return result;
  }
  async function canonicalWorkspace(): Promise<string> {
    workspaceRoot ??= await prepareWorkspaceRoot(workspacePath);
    return workspaceRoot;
  }
  async function catalog() {
    return configuredModels(await configuration.management.getSnapshot());
  }
  async function sessionDirectory(): Promise<readonly TerminalHostSession[]> {
    const [summaries, models] = await Promise.all([
      listHostSessions(dataRoot, await canonicalWorkspace()),
      catalog(),
    ]);
    return summaries.map((summary) => {
      const model = models.find(
        (entry) => entry.connectionFingerprint === summary.connectionFingerprint,
      );
      return {
        id: summary.threadId,
        label: `${summary.threadId} / ${model?.label ?? summary.model.modelId}`,
        modelId: model?.id,
        toolsMode: summary.toolMode,
        history: summary.history,
        ...(summary.unfinished ? { unfinished: summary.unfinished } : {}),
      };
    });
  }
  async function install(
    modelId: string,
    toolsMode: TerminalToolsMode,
    threadId: string,
    resume: boolean,
    signal?: AbortSignal,
  ) {
    const activationSignal = signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
    let model: ConfiguredModelItem | undefined;
    let opened: AgentHost;
    try {
      model = (await catalog()).find((entry) => entry.id === modelId && entry.status === "ready");
      if (!model)
        throw new AgentError("CLI_MODEL_UNAVAILABLE", "所选模型没有就绪的受支持连接与凭据。");
      activationSignal.throwIfAborted();
      opened = await createAgentHost({
        configuration: configuration.runtime,
        applicationDataRoot: dataRoot,
        workspaceRoot: await canonicalWorkspace(),
        modelId,
        threadId,
        toolMode: toolsMode,
        resume,
        requireReadApproval,
        ...(createProvider ? { createProvider } : {}),
        signal: activationSignal,
      });
    } catch (error) {
      // 只有旧宿主尚未开始关闭时，终端才可安全继续使用原绑定。
      if (current && !closing)
        throw new AgentError("HOST_SWITCH_REJECTED", "目标会话未能就绪；当前模型与会话保持不变。");
      throw error;
    }
    try {
      await current?.close();
    } catch {
      try {
        await opened.close();
      } catch {
        throw new AgentError("HOST_CLOSE_FAILED", "新旧会话的资源回收失败。");
      }
      throw new AgentError("HOST_CLOSE_FAILED", "旧会话资源回收失败，不能确认会话切换。");
    }
    if (activationSignal.aborted) {
      await opened.close();
      activationSignal.throwIfAborted();
    }
    current = opened;
    context = Object.freeze({
      dataRoot,
      workspaceRoot: opened.binding.workspaceRoot,
      threadId,
      model: Object.freeze({
        id: model.id,
        label: model.label,
        vendor: model.vendor ? Object.freeze({ ...model.vendor }) : undefined,
        modelName: model.modelName,
        availability: model.availability,
      }),
      toolsMode,
    });
  }
  function track(handle: AgentRunHandle): AgentRunHandle {
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
  }
  function supported(request: InteractionRequest): boolean {
    try {
      const approval = parseWorkspaceApproval(request);
      const bound = context;
      if (!bound || bound.toolsMode === "none" || !request.id.trim()) return false;
      if (approval.workspaceId !== createHash("sha256").update(bound.workspaceRoot).digest("hex"))
        return false;
      return (
        bound.toolsMode === "read-write" ||
        approval.tool === "read" ||
        approval.tool === "glob" ||
        approval.tool === "grep"
      );
    } catch {
      return false;
    }
  }
  async function setupInput<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const interruption = Promise.withResolvers<never>();
    const aborted = () => interruption.reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      return await Promise.race([operation(), interruption.promise]);
    } finally {
      signal.removeEventListener("abort", aborted);
    }
  }
  async function configureModel(
    setup: TerminalSetupIO,
    signal: AbortSignal,
    target?: TerminalConnectionTarget,
  ) {
    try {
      return await ensureConfiguredModel(
        configuration.management,
        {
          select: (title, items) => setupInput(() => setup.select(title, items), signal),
          secret: (prompt) => setupInput(() => setup.secret(prompt), signal),
          text: (prompt) => setupInput(() => setup.text(prompt), signal),
          notify: (message) => setupInput(() => setup.notify(message), signal),
          protection,
          signal,
        },
        target,
      );
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AgentError && error.code === "CLI_MODEL_SETUP_FAILED") throw error;
      throw new AgentError(
        "CLI_MODEL_SETUP_FAILED",
        "模型配置未完成；已保存的配置保留，当前模型与会话保持不变。",
      );
    }
  }

  const host: TerminalHost = {
    get context() {
      ensureOpen();
      return context!;
    },
    open(openOptions: TerminalHostOpenOptions) {
      return exclusive(async () => {
        if (current) throw new AgentError("HOST_ALREADY_OPEN", "Node 宿主已经打开。");
        const signal = openOptions.signal
          ? AbortSignal.any([lifetime.signal, openOptions.signal])
          : lifetime.signal;
        signal.throwIfAborted();
        if (openOptions.threadId) {
          const selected = (await sessionDirectory()).find(
            (entry) => entry.id === openOptions.threadId,
          );
          if (!selected)
            throw new AgentError("HOST_SESSION_NOT_FOUND", "找不到当前工作区绑定的会话。");
          if (
            selected.modelId === undefined ||
            (openOptions.modelId !== undefined && openOptions.modelId !== selected.modelId)
          )
            throw new AgentError(
              "HOST_BINDING_CHANGED",
              "会话绑定的模型连接或执行配置已变更，不能恢复。",
            );
          await install(
            openOptions.modelId ?? selected.modelId,
            openOptions.toolsMode ?? selected.toolsMode,
            selected.id,
            true,
            signal,
          );
          return;
        }
        let modelId = openOptions.modelId;
        const snapshot = await configuration.management.getSnapshot();
        modelId ??= snapshot?.settings.cli?.defaultModelId;
        if (
          !modelId ||
          !(await catalog()).some((entry) => entry.id === modelId && entry.status === "ready")
        ) {
          if (openOptions.modelId)
            throw new AgentError("CLI_MODEL_UNAVAILABLE", "指定的模型未就绪。");
          if (!openOptions.setup)
            throw new AgentError(
              "CLI_MODEL_SETUP_REQUIRED",
              "没有可用的 CLI 默认模型；请在安全交互终端完成配置。",
            );
          modelId = await configureModel(openOptions.setup, signal);
          if (!modelId) throw new AgentError("CLI_SETUP_CANCELLED", "模型设置已取消。");
        }
        await install(modelId, openOptions.toolsMode ?? "read-only", randomUUID(), false, signal);
      });
    },
    async models() {
      if (closing) throw new AgentError("HOST_CLOSED", "Node 宿主已经关闭。");
      return (await catalog()).map(({ id, label, vendor, modelName, availability }) => ({
        id,
        label,
        vendor,
        modelName,
        availability,
      }));
    },
    async connections() {
      if (closing) throw new AgentError("HOST_CLOSED", "Node 宿主已经关闭。");
      return configuredConnections(await configuration.management.getSnapshot());
    },
    configureModel(setup, target) {
      return exclusive(async () => {
        ensureOpen();
        try {
          if (!target) throw new AgentError("CLI_MODEL_SETUP_FAILED", "请选择要配置的连接。");
          return await configureModel(setup, lifetime.signal, target);
        } catch {
          lifetime.signal.throwIfAborted();
          throw new AgentError(
            "HOST_CONFIGURATION_REJECTED",
            "模型配置未完成；已保存的配置保留，当前模型与会话保持不变。",
          );
        }
      });
    },
    async sessions() {
      if (closing) throw new AgentError("HOST_CLOSED", "Node 宿主已经关闭。");
      return sessionDirectory();
    },
    newSession(sessionOptions = {}) {
      return exclusive(async () => {
        ensureOpen();
        await install(
          sessionOptions.modelId ?? context!.model.id,
          sessionOptions.toolsMode ?? context!.toolsMode,
          randomUUID(),
          false,
        );
      });
    },
    selectSession(threadId) {
      return exclusive(async () => {
        ensureOpen();
        const selected = (await sessionDirectory()).find((entry) => entry.id === threadId);
        if (!selected)
          throw new AgentError("HOST_SESSION_NOT_FOUND", "找不到当前工作区绑定的会话。");
        if (selected.modelId === undefined)
          throw new AgentError(
            "HOST_BINDING_CHANGED",
            "会话绑定的模型连接或执行配置已变更，不能恢复。",
          );
        await install(selected.modelId, selected.toolsMode, selected.id, true);
        return selected;
      });
    },
    run(text) {
      return exclusive(async () =>
        track(
          await ensureOpen().run({
            queryId: randomUUID(),
            runId: randomUUID(),
            input: [{ role: "user", content: [{ type: "text", text }] }],
          }),
        ),
      );
    },
    resume(queryId, response) {
      return exclusive(async () =>
        track(
          await ensureOpen().resume({
            queryId,
            runId: randomUUID(),
            ...(response ? { response } : {}),
          }),
        ),
      );
    },
    describeInteraction(request) {
      if (!supported(request)) return { support: "unsupported" };
      const approval = parseWorkspaceApproval(request);
      return {
        support: "supported",
        summary: `允许 ${approval.tool}: ${approval.path}？`,
        confirmation:
          approval.tool === "write" || approval.tool === "edit"
            ? "interaction-id"
            : "explicit-choice",
        choices: [
          { id: "allow", label: "允许此次操作", responseType: "answer" },
          { id: "reject", label: "拒绝此次操作", responseType: "reject" },
        ],
      };
    },
    answerInteraction(request, choiceId, confirmationId) {
      if (!supported(request))
        throw new AgentError("CLI_INTERACTION_UNSUPPORTED", "无法解释此宿主交互，等待保持不变。");
      const approval = parseWorkspaceApproval(request);
      const requiresId = approval.tool === "write" || approval.tool === "edit";
      if ((requiresId || confirmationId !== undefined) && confirmationId !== request.id)
        throw new AgentError("STALE_INTERACTION", "确认标识不匹配当前交互。");
      if (choiceId === "allow") return { type: "answer", interactionId: request.id, value: true };
      if (choiceId === "reject") return { type: "reject", interactionId: request.id };
      throw new AgentError("CLI_INTERACTION_CHOICE_INVALID", "必须明确选择当前交互列出的选项。");
    },
    close() {
      if (!closing) {
        closing = Promise.resolve().then(async () => {
          try {
            await transition;
          } catch {
            /* 启动失败由原调用者观察；仍须回收已取得的资源。 */
          }
          await current?.close();
        });
        lifetime.abort(new AgentError("HOST_CLOSED", "Node 宿主已经关闭。"));
      }
      return closing;
    },
  };
  return host;
}
