import { randomUUID } from "node:crypto";
import type { AgentConfiguration } from "@agent-harness/configuration/configuration";
import type { AgentRunHandle } from "@agent-harness/core/agent-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import type { InteractionResponse } from "@agent-harness/core/protocol-values";
import type {
  HostModel,
  HostSession,
  HostToolDisplay,
  HostToolOutcome,
  NodeHost,
} from "../../../cli/host/host-contract";
import { projectHostError, projectHostInteractionDisplay } from "../../../cli/host/host-projection";
import { createNodeHost, type NodeHostIntegrationOptions } from "../../../cli/host/node-host";
import { escapeDisplayControls } from "../../../cli/host/safe-display-text";
import { readHostCheckpoint } from "../../../cli/host/session-directory";
import { projectToolOutcome } from "../../../cli/host/tool-display";
import type {
  HarnessApproval,
  HarnessDesktopEvent,
  HarnessError,
  HarnessIdentity,
  HarnessModel,
  HarnessSession,
  HarnessSnapshot,
  HarnessToolDisplay,
  HarnessToolsMode,
  HarnessWorkspace,
} from "../../shared/harness-ipc";
import type { RecentWorkspaces } from "./workspaces";

export interface DesktopHostOptions {
  readonly dataRoot: string;
  readonly configuration: AgentConfiguration;
  readonly workspaces: RecentWorkspaces;
  readonly chooseDirectory: () => Promise<string | undefined>;
  readonly emit: (event: HarnessDesktopEvent) => void;
  /** 真实宿主消费者测试使用相同 NodeHost，只替换模型提供端口。 */
  readonly createHost?: (options: NodeHostIntegrationOptions) => NodeHost;
}

export function desktopError(error: unknown): HarnessError {
  return projectHostError(error);
}

function desktopModel(model: HostModel): HarnessModel {
  return {
    id: model.id,
    label: model.label,
    ...(model.vendor ? { vendor: { id: model.vendor.id, label: model.vendor.label } } : {}),
    ...(model.modelName !== undefined ? { modelName: model.modelName } : {}),
    ...(model.availability
      ? {
          availability: { state: model.availability.state, reason: model.availability.reason },
        }
      : {}),
  };
}

function desktopToolDisplay(display: HostToolDisplay): HarnessToolDisplay {
  return {
    title: display.title,
    input: display.input.map((line) => line),
    output: display.output.map((line) => line),
    ...(display.summary ? { summary: display.summary.map((line) => line) } : {}),
  };
}

function desktopToolOutcome(outcome: HostToolOutcome): HostToolOutcome {
  return {
    ...(outcome.display ? { display: desktopToolDisplay(outcome.display) } : {}),
    ...(outcome.status ? { status: outcome.status } : {}),
    ...(outcome.effects ? { effects: outcome.effects } : {}),
    ...(outcome.error
      ? { error: { code: outcome.error.code, message: outcome.error.message } }
      : {}),
  };
}

function desktopSession(session: HostSession): HarnessSession {
  // 安全历史来自宿主的已确认历史与独立持久化工具展示事实。
  let label = "新会话";
  for (const entry of session.history) {
    if (entry.role !== "user") continue;
    const request = entry.text.replace(/\s+/gu, " ").trim();
    if (!request) continue;
    label = request;
    break;
  }
  return {
    id: session.id,
    label,
    ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
    toolsMode: session.toolsMode,
    history: session.history.map((entry) =>
      entry.role === "tool"
        ? {
            role: "tool",
            tool: {
              callId: entry.tool.callId,
              name: entry.tool.name,
              result: entry.tool.result,
              ...(entry.tool.identity ? { identity: desktopIdentity(entry.tool.identity) } : {}),
              ...(entry.tool.step !== undefined ? { step: entry.tool.step } : {}),
              ...desktopToolOutcome(entry.tool),
            },
          }
        : { role: entry.role, text: entry.text },
    ),
    ...(session.unfinished
      ? {
          unfinished: {
            queryId: session.unfinished.queryId,
            status: session.unfinished.status,
          },
        }
      : {}),
  };
}

function desktopIdentity(identity: HarnessIdentity): HarnessIdentity {
  return {
    agentId: identity.agentId,
    threadId: identity.threadId,
    queryId: identity.queryId,
    runId: identity.runId,
  };
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

/** 一个窗口拥有一个宿主；Query 的恢复事实始终来自独立 Harness 数据库。 */
export class DesktopHarnessHost {
  private readonly scopeId = randomUUID();
  private readonly lifetime = new AbortController();
  private revision = 0;
  private workspace: HarnessWorkspace | null = null;
  private host: NodeHost | undefined;
  private selectedSessionId: string | null = null;
  private selectedModelId: string | null = null;
  private toolsMode: HarnessToolsMode = "read-only";
  private active: AgentRunHandle | undefined;
  private observing: Promise<void> | undefined;
  private transition: Promise<unknown> | undefined;
  private closing: Promise<void> | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly drainErrors: Array<{ phase: string; error: HarnessError }> = [];
  private status: HarnessSnapshot["status"] = "idle";
  private error: HarnessError | null = null;

  constructor(private readonly options: DesktopHostOptions) {}

  private ensureAvailable(): void {
    if (this.lifetime.signal.aborted) throw new AgentError("HOST_CLOSED", "桌面宿主正在关闭。");
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureAvailable();
    const result = (async () => {
      this.ensureAvailable();
      return operation();
    })();
    this.pending.add(result);
    void result.then(
      () => this.pending.delete(result),
      () => this.pending.delete(result),
    );
    return result;
  }

  private recordDrainError(phase: string, error: unknown): void {
    this.drainErrors.push({ phase, error: desktopError(error) });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureAvailable();
    if (this.transition || this.active)
      throw new AgentError("HOST_BUSY", "请等待当前执行或切换结束。");
    const result = Promise.resolve().then(() => {
      this.ensureAvailable();
      return operation();
    });
    this.transition = result;
    void result.then(
      () => {
        if (this.transition === result) this.transition = undefined;
      },
      () => {
        if (this.transition === result) this.transition = undefined;
      },
    );
    return result;
  }

  private newHost(workspace: HarnessWorkspace): NodeHost {
    return (this.options.createHost ?? createNodeHost)({
      dataRoot: this.options.dataRoot,
      workspaceRoot: workspace.path,
      configuration: this.options.configuration,
    });
  }

  private emit(event: HarnessDesktopEvent): void {
    if (this.closing) return;
    // 窗口消失或停止观察不影响执行；窗口所有者另行关闭并排空宿主。
    try {
      this.options.emit(event);
    } catch {
      /* 接收方已关闭。 */
    }
  }

  private async approval(
    host: NodeHost | undefined,
    workspace: HarnessWorkspace | null,
    sessionId: string | null,
    active: boolean,
  ): Promise<HarnessApproval | null> {
    if (!workspace || !sessionId || !host || active) return null;
    const boundContext = host.context;
    const checkpoint = await readHostCheckpoint(this.options.dataRoot, workspace.path, sessionId);
    if (checkpoint?.status !== "waiting") return null;
    // 同一 NodeHost 可切会话；旧读取不能借用切换后的模型/权限解释旧审批。
    try {
      if (host.context !== boundContext) return null;
    } catch {
      return null;
    }
    const display = projectHostInteractionDisplay(
      host.describeInteraction(checkpoint.pending.interaction),
    );
    return {
      queryId: checkpoint.queryId,
      interactionId: checkpoint.pending.interaction.id,
      supported: display.support === "supported",
      summary:
        display.support === "supported"
          ? display.summary
          : "此交互无法安全解释；可以取消当前请求。",
      choices:
        display.support === "supported"
          ? display.choices.map(({ id, label }) => ({ id, label }))
          : [],
    };
  }

  async models(): Promise<readonly HarnessModel[]> {
    return this.track(async () => {
      if (this.host) {
        const models = await this.host.models();
        this.ensureAvailable();
        return models.map(desktopModel);
      }
      // 模型目录不需要工作区、模型实例或数据库；临时 NodeHost 不调用 open。
      const catalog = (this.options.createHost ?? createNodeHost)({
        dataRoot: this.options.dataRoot,
        workspaceRoot: this.options.dataRoot,
        configuration: this.options.configuration,
      });
      let models: readonly HostModel[] | undefined;
      let readFailed = false;
      let readError: unknown;
      try {
        models = await catalog.models();
      } catch (error) {
        readFailed = true;
        readError = error;
      }
      try {
        await catalog.close();
      } catch (error) {
        this.recordDrainError("catalog", error);
        if (readFailed)
          throw new AggregateError([readError, error], "模型目录读取与资源回收均失败。");
        throw error;
      }
      if (readFailed) throw readError;
      this.ensureAvailable();
      return models!.map(desktopModel);
    });
  }

  async sessions(): Promise<readonly HarnessSession[]> {
    return this.track(async () => {
      const sessions = this.host ? await this.host.sessions() : [];
      this.ensureAvailable();
      return sessions.map(desktopSession);
    });
  }

  async snapshot(): Promise<HarnessSnapshot> {
    return this.track(() => this.readSnapshot());
  }

  private async readSnapshot(): Promise<HarnessSnapshot> {
    this.ensureAvailable();
    // 在任何异步读取前固定身份并签发顺序；晚完成的旧读取永远保持较低修订。
    const revision = ++this.revision;
    const host = this.host;
    const workspace = this.workspace;
    const selectedSessionId = this.selectedSessionId;
    const selectedModelId = this.selectedModelId;
    const toolsMode = this.toolsMode;
    const status = this.status;
    const activeRun = this.active ? desktopIdentity(this.active.identity) : null;
    const error = this.error ? { code: this.error.code, message: this.error.message } : null;
    // 全部读取都必须落定；某一读取先失败不能遗失其余读取的排空屏障。
    const reads = await Promise.allSettled([
      host ? host.models().then((models) => models.map(desktopModel)) : this.models(),
      host ? host.sessions().then((sessions) => sessions.map(desktopSession)) : [],
      this.options.workspaces.list(),
      this.options.configuration.management.getSnapshot(),
      this.approval(host, workspace, selectedSessionId, activeRun !== null),
    ] as const);
    this.ensureAvailable();
    const models = settledValue(reads[0]);
    const sessions = settledValue(reads[1]);
    const recentWorkspaces = settledValue(reads[2]);
    const configuration = settledValue(reads[3]);
    const pendingApproval = settledValue(reads[4]);
    return {
      scopeId: this.scopeId,
      revision,
      workspace,
      recentWorkspaces,
      models,
      sessions,
      defaultModelId: configuration?.settings.cli?.defaultModelId ?? null,
      selectedSessionId,
      selectedModelId,
      toolsMode,
      status,
      activeRun,
      pendingApproval,
      error,
    };
  }

  private async publish(): Promise<HarnessSnapshot> {
    const snapshot = await this.snapshot();
    this.ensureAvailable();
    if (snapshot.revision === this.revision) this.emit({ type: "snapshot", snapshot });
    return snapshot;
  }

  private async switchWorkspace(path: string): Promise<HarnessSnapshot> {
    // 校验成功前保留旧上下文；最近记录的提交也受本次生命周期约束。
    this.ensureAvailable();
    const selected = await this.options.workspaces.remember(path, this.lifetime.signal);
    this.ensureAvailable();
    await this.host?.close();
    this.ensureAvailable();
    const host = this.newHost(selected);
    this.workspace = selected;
    this.host = host;
    this.selectedSessionId = null;
    this.selectedModelId = null;
    this.status = "idle";
    this.error = null;
    return this.publish();
  }

  chooseWorkspace(): Promise<HarnessSnapshot> {
    return this.exclusive(async () => {
      // 保留真实选择器等待，close 必须排空它而非遗失迟返回的 Promise。
      const path = await this.options.chooseDirectory();
      this.ensureAvailable();
      if (!path) return this.snapshot();
      return this.switchWorkspace(path);
    });
  }

  selectWorkspace(workspaceId: string): Promise<HarnessSnapshot> {
    return this.exclusive(async () => {
      const workspace = (await this.options.workspaces.list()).find(
        (entry) => entry.id === workspaceId,
      );
      this.ensureAvailable();
      if (!workspace) throw new AgentError("HOST_WORKSPACE_NOT_FOUND", "请选择已记录的工作目录。");
      return this.switchWorkspace(workspace.path);
    });
  }

  async setDefaultModel(modelId?: string): Promise<HarnessSnapshot> {
    return this.track(async () => {
      if (modelId !== undefined && !(await this.models()).some((model) => model.id === modelId))
        throw new AgentError("CLI_MODEL_UNAVAILABLE", "请选择已配置的模型。");
      this.ensureAvailable();
      await this.options.configuration.management.saveCliPreferences({ defaultModelId: modelId });
      this.ensureAvailable();
      return this.publish();
    });
  }

  newSession(options: {
    readonly modelId: string;
    readonly toolsMode: HarnessToolsMode;
  }): Promise<HarnessSnapshot> {
    return this.exclusive(async () => {
      if (!this.workspace || !this.host)
        throw new AgentError("HOST_NOT_OPEN", "请先选择工作目录。");
      if (
        !options ||
        typeof options.modelId !== "string" ||
        !["none", "read-only", "read-write"].includes(options.toolsMode)
      )
        throw new AgentError("HOST_OPTIONS_INVALID", "请选择模型与工具权限。");
      if (this.selectedSessionId) await this.host.newSession(options);
      else await this.host.open({ ...options, signal: this.lifetime.signal });
      this.ensureAvailable();
      this.adoptContext();
      this.status = "idle";
      this.error = null;
      return this.publish();
    });
  }

  private adoptContext(): void {
    const context = this.host!.context;
    this.selectedSessionId = context.threadId;
    this.selectedModelId = context.model.id;
    this.toolsMode = context.toolsMode;
  }

  selectSession(sessionId: string): Promise<HarnessSnapshot> {
    return this.exclusive(async () => {
      if (!this.host || !this.workspace)
        throw new AgentError("HOST_NOT_OPEN", "请先选择工作目录。");
      if (this.selectedSessionId) await this.host.selectSession(sessionId);
      else await this.host.open({ threadId: sessionId, signal: this.lifetime.signal });
      this.ensureAvailable();
      this.adoptContext();
      const checkpoint = await readHostCheckpoint(
        this.options.dataRoot,
        this.workspace.path,
        sessionId,
      );
      this.ensureAvailable();
      this.status = checkpoint?.status ?? "idle";
      this.error =
        checkpoint?.status === "failed"
          ? desktopError(new AgentError(checkpoint.error.code, checkpoint.error.message))
          : null;
      return this.publish();
    });
  }

  private assertSession(sessionId: string): NodeHost {
    if (!this.host || !this.workspace || !sessionId || sessionId !== this.selectedSessionId)
      throw new AgentError("STALE_SESSION", "会话已变更，请刷新后重试。");
    return this.host;
  }

  run(request: { readonly sessionId: string; readonly text: string }): Promise<HarnessIdentity> {
    return this.exclusive(async () => {
      const host = this.assertSession(request?.sessionId);
      if (
        typeof request.text !== "string" ||
        !request.text.trim() ||
        request.text.length > 1_000_000
      )
        throw new AgentError("HOST_INPUT_INVALID", "请输入有效的消息（最多一百万字符）。");
      const checkpoint = await readHostCheckpoint(
        this.options.dataRoot,
        this.workspace!.path,
        request.sessionId,
      );
      this.ensureAvailable();
      if (checkpoint && ["running", "waiting", "interrupted"].includes(checkpoint.status))
        throw new AgentError("HOST_QUERY_UNFINISHED", "请先恢复或取消未完成的请求。");
      return this.activate(await host.run(request.text));
    });
  }

  resume(request: {
    readonly sessionId: string;
    readonly queryId: string;
    readonly interactionId?: string;
    readonly choiceId?: "allow" | "reject";
  }): Promise<HarnessIdentity> {
    return this.exclusive(async () => {
      const host = this.assertSession(request?.sessionId);
      const checkpoint = await readHostCheckpoint(
        this.options.dataRoot,
        this.workspace!.path,
        request.sessionId,
      );
      this.ensureAvailable();
      if (
        !checkpoint ||
        checkpoint.queryId !== request.queryId ||
        !["running", "waiting", "interrupted"].includes(checkpoint.status)
      )
        throw new AgentError("STALE_QUERY", "请求已结束或已变更，不能恢复。");
      let response: InteractionResponse | undefined;
      if (checkpoint.status === "waiting") {
        if (
          request.interactionId !== checkpoint.pending.interaction.id ||
          (request.choiceId !== "allow" && request.choiceId !== "reject")
        )
          throw new AgentError("STALE_INTERACTION", "请明确回答当前待决审批。");
        response = host.answerInteraction(
          checkpoint.pending.interaction,
          request.choiceId,
          request.interactionId,
        );
      } else if (request.interactionId !== undefined || request.choiceId !== undefined) {
        throw new AgentError("STALE_INTERACTION", "此请求没有等待审批。");
      }
      return this.activate(await host.resume(request.queryId, response));
    });
  }

  private async activate(handle: AgentRunHandle): Promise<HarnessIdentity> {
    this.active = handle;
    this.status = "running";
    this.error = null;
    const published = Promise.withResolvers<void>();
    // 先持有观察排空屏障，发布等待期间关闭也不能丢失它。
    this.observing = this.observe(handle, published.promise);
    try {
      this.ensureAvailable();
      await this.publish();
      this.ensureAvailable();
    } catch (error) {
      if (this.lifetime.signal.aborted) throw error;
      this.error = desktopError(error);
    } finally {
      // 首段事件仍须等待运行身份发布（或确认关闭后不再投递）。
      published.resolve();
    }
    return desktopIdentity(handle.identity);
  }

  private async observe(handle: AgentRunHandle, published: Promise<void>): Promise<void> {
    const consume = (async () => {
      await published;
      const previewedRequests = new Set<string>();
      for await (const event of handle.events) {
        if (event.type === "model.preview") previewedRequests.add(event.requestId);
        if (
          event.type === "model.delta" &&
          event.delta.type === "text" &&
          previewedRequests.has(event.requestId)
        )
          continue;
        if (event.type === "tool.started" || event.type === "tool.completed") {
          const outcome = desktopToolOutcome(
            projectToolOutcome(
              event.invocation,
              event.type === "tool.completed" ? event.completion : undefined,
            ),
          );
          this.emit({
            type: "tool.status",
            scopeId: this.scopeId,
            identity: desktopIdentity(handle.identity),
            invocationIdentity: desktopIdentity(event.invocation.identity),
            step: event.step,
            callId: escapeDisplayControls(event.invocation.call.callId),
            name: escapeDisplayControls(event.invocation.call.name),
            ...outcome,
            status:
              event.type === "tool.started"
                ? "dispatched"
                : event.completion.status === "succeeded"
                  ? "completed"
                  : event.completion.status,
          });
        }
        if (
          (event.type === "model.delta" || event.type === "model.preview") &&
          (event.delta.type === "text" || event.delta.type === "reasoning")
        ) {
          this.emit({
            type: "text.delta",
            scopeId: this.scopeId,
            identity: desktopIdentity(handle.identity),
            text: escapeDisplayControls(event.delta.text),
            reasoning: event.delta.type === "reasoning",
          });
        }
      }
    })();
    // completion 与观察分别排空；订阅者速度/异常不驱动 Agent。
    const [result, observed] = await Promise.allSettled([handle.completed, consume]);
    if (result.status === "fulfilled") {
      this.status = result.value.status;
      if (result.value.status === "failed")
        this.error = desktopError(
          new AgentError(result.value.error.code, result.value.error.message),
        );
    } else {
      this.status = "failed";
      this.error = desktopError(result.reason);
    }
    if (observed.status === "rejected") {
      this.error = desktopError(observed.reason);
      this.recordDrainError("observation", observed.reason);
    }
    if (this.active === handle) this.active = undefined;
    this.emit({
      type: "run.settled",
      scopeId: this.scopeId,
      identity: desktopIdentity(handle.identity),
      status: this.status,
    });
    if (!this.closing) {
      try {
        await this.publish();
      } catch (error) {
        this.error = desktopError(error);
      }
    }
  }

  async cancel(request: {
    readonly sessionId: string;
    readonly queryId: string;
    readonly runId?: string;
  }): Promise<HarnessSnapshot> {
    this.ensureAvailable();
    const host = this.assertSession(request?.sessionId);
    if (this.active) {
      if (
        this.active.identity.queryId !== request.queryId ||
        this.active.identity.runId !== request.runId
      )
        throw new AgentError("STALE_RUN", "执行已变更，取消请求未被应用。");
      this.active.cancel();
      await this.observing;
      return this.snapshot();
    }
    return this.exclusive(async () => {
      const checkpoint = await readHostCheckpoint(
        this.options.dataRoot,
        this.workspace!.path,
        request.sessionId,
      );
      this.ensureAvailable();
      if (
        !checkpoint ||
        checkpoint.queryId !== request.queryId ||
        !["running", "waiting", "interrupted"].includes(checkpoint.status)
      )
        throw new AgentError("STALE_QUERY", "请求已结束或已变更，不能取消。");
      const handle = await host.resume(
        request.queryId,
        checkpoint.status === "waiting"
          ? { type: "cancel", interactionId: checkpoint.pending.interaction.id }
          : undefined,
      );
      if (checkpoint.status !== "waiting") handle.cancel();
      await this.activate(handle);
      await this.observing;
      return this.snapshot();
    });
  }

  close(): Promise<void> {
    if (!this.closing) {
      const closed = Promise.withResolvers<void>();
      this.closing = closed.promise;
      this.lifetime.abort(new AgentError("HOST_CLOSED", "桌面宿主正在关闭。"));
      void this.drain().then(closed.resolve, closed.reject);
    }
    return this.closing;
  }

  private async drain(): Promise<void> {
    // 立即请求中断，但不使用 cancel：waiting 和已发生影响必须保留。
    const closeHost = Promise.resolve()
      .then(() => this.host?.close())
      .catch((error: unknown) => this.recordDrainError("host", error));
    await this.transition?.catch((error: unknown) => {
      if (error instanceof AgentError && error.code === "HOST_CLOSE_FAILED")
        this.recordDrainError("transition", error);
    });
    await closeHost;
    await this.observing?.catch((error: unknown) => this.recordDrainError("observation", error));
    // 读取、临时模型目录和选择器都属于此 scope；失败也要继续回收其余资源。
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    if (this.drainErrors.length) {
      const failures = this.drainErrors.map(({ phase, error }) => `${phase}:${error.code}`);
      throw new AgentError(
        "HOST_CLOSE_FAILED",
        `桌面宿主资源未能全部关闭（${failures.join(", ")}）。`,
      );
    }
  }
}
