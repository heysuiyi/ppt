import type {
  AgentDefinition,
  AgentResumeInput,
  AgentRunInput,
  AgentRunResult,
} from "../agent-contract";
import type { PromptContext } from "../extensions/plugin-contract";
import type { ModelClient, ModelRequest, ModelToolCallContent } from "../model/model-contract";
import { AgentError, asProtocolError } from "../protocol-errors";
import { type RunIdentity, sameValue, snapshot } from "../protocol-values";
import type { CheckpointStore } from "../session/checkpoint-contract";
import type { AgentCheckpoint, SessionHistoryStore } from "../session/session-contract";
import type { RuntimeEvent } from "../session/session-events";
import type { ToolExecutor } from "../tools/tool-executor";
import { CheckpointSession, checkpointData, running } from "./query/checkpoint-session";
import { executeModelTurn } from "./turns/model-turn";
import { executeToolTurn, resumeTool } from "./turns/tool-turn";

/**
 * Loop 只依赖执行端口与当前身份，不接收工作区、Presentation 或厂商服务。
 * 业务事实通过提示词贡献和工具协议进入，不能直接改变内核状态。
 */
export interface RunEnvironment {
  readonly identity: RunIdentity;
  readonly definition: AgentDefinition;
  readonly plugins: readonly { readonly id: string; readonly version: string }[];
  readonly model: ModelClient;
  readonly tools: ToolExecutor;
  renderPrompt(context: PromptContext): Promise<string>;
  readonly checkpoints: CheckpointStore;
  readonly history: SessionHistoryStore;
  readonly maxSteps: number;
  readonly signal: AbortSignal;
  isInterrupted(): boolean;
  emit(event: RuntimeEvent): void;
}

export type RunRequest =
  | { readonly kind: "run"; readonly input: AgentRunInput }
  | { readonly kind: "resume"; readonly input: AgentResumeInput };

function validateIdentity(request: RunRequest, env: RunEnvironment): void {
  for (const value of Object.values(env.identity)) {
    if (typeof value !== "string" || !value.trim())
      throw new AgentError("INVALID_IDENTITY", "Execution IDs must be nonempty strings");
  }
  if (
    request.input.threadId !== env.identity.threadId ||
    request.input.queryId !== env.identity.queryId ||
    request.input.runId !== env.identity.runId
  )
    throw new AgentError("INVALID_IDENTITY", "Run input and execution identity disagree");
  if (request.kind === "run") {
    const input = snapshot(request.input.input);
    if (!Array.isArray(input) || input.length === 0)
      throw new AgentError("EMPTY_INPUT", "New queries require user input");
    for (const message of input) {
      if (
        message.role !== "user" ||
        !Array.isArray(message.content) ||
        message.content.length === 0
      )
        throw new AgentError("INVALID_INPUT", "Only new user content may enter a query");
      for (const part of message.content) {
        if (part.type === "text" && typeof part.text === "string") continue;
        if (
          part.type === "image" &&
          part.source &&
          ((part.source.type === "url" && typeof part.source.url === "string") ||
            (part.source.type === "base64" &&
              typeof part.source.data === "string" &&
              typeof part.source.mediaType === "string"))
        )
          continue;
        throw new AgentError("INVALID_INPUT", "Unsupported user content");
      }
    }
  }
}

function validateResume(state: AgentCheckpoint, env: RunEnvironment): void {
  if (
    state.schemaVersion !== 1 ||
    state.agentId !== env.identity.agentId ||
    state.threadId !== env.identity.threadId ||
    state.queryId !== env.identity.queryId
  )
    throw new AgentError(
      "INCOMPATIBLE_CHECKPOINT",
      "Checkpoint identity or schema is incompatible",
    );
  if (state.lastRunId === env.identity.runId)
    throw new AgentError("RUN_ID_REUSED", "Resume requires a fresh activation ID");
  if (
    !sameValue(state.definition, { id: env.definition.id, version: env.definition.version }) ||
    !sameValue(state.plugins, env.plugins) ||
    !sameValue(state.model, env.model.selection)
  )
    throw new AgentError("DEFINITION_CHANGED", "Execution definition, plugins or model changed");
  if (
    !Number.isSafeInteger(state.maxSteps) ||
    state.maxSteps <= 0 ||
    !Number.isSafeInteger(state.committed.step) ||
    state.committed.step < 0
  )
    throw new AgentError("INVALID_CHECKPOINT", "Invalid saved execution budget");
  if (state.status !== "running" && state.status !== "waiting" && state.status !== "interrupted")
    throw new AgentError("QUERY_TERMINAL", "This query cannot be resumed");
}

function resultOf(session: CheckpointSession, env: RunEnvironment): AgentRunResult {
  const state = session.state;
  if (state.status === "waiting")
    return {
      status: "waiting",
      identity: env.identity,
      interaction: snapshot(state.pending.interaction),
    };
  if (state.status === "completed")
    return {
      status: "completed",
      identity: env.identity,
      output: snapshot(
        state.committed.messages
          .slice(state.startMessageCount)
          .filter((message) => message.role === "assistant"),
      ),
    };
  if (state.status === "failed")
    return { status: "failed", identity: env.identity, error: state.error };
  if (state.status === "cancelled" || state.status === "interrupted")
    return { status: state.status, identity: env.identity };
  throw new AgentError("QUERY_NOT_SETTLED", "Execution has not reached a result boundary");
}

function emitResult(result: AgentRunResult, env: RunEnvironment): void {
  if (result.status === "waiting")
    env.emit({
      identity: env.identity,
      kind: "fact",
      type: "run.waiting",
      interactionId: result.interaction.id,
    });
  else if (result.status === "failed")
    env.emit({ identity: env.identity, kind: "fact", type: "run.failed", error: result.error });
  else
    env.emit({
      identity: env.identity,
      kind: "fact",
      type:
        result.status === "completed"
          ? "run.completed"
          : result.status === "cancelled"
            ? "run.cancelled"
            : "run.interrupted",
    });
}

/**
 * 正常执行的阅读入口：按持久化阶段调度模型步、工具步与历史提交，不解释工具业务。
 * executeRun 负责激活与恢复；这里既推进新步骤，也接续检查点中尚未完成的步骤。
 */
async function drive(session: CheckpointSession, env: RunEnvironment): Promise<void> {
  while (session.state.status === "running") {
    env.signal.throwIfAborted();
    // 先对账未确认的追加，避免用旧历史前缀调用模型或在恢复时重复提交消息。
    if (await session.reconcileHistory()) {
      env.emit({
        identity: env.identity,
        kind: "fact",
        type: "step.committed",
        step: session.state.committed.step,
        historyRevision: session.state.committed.historyRevision,
      });
      continue;
    }
    const state = session.state;
    if (state.status !== "running") return;
    if (state.inflight?.type === "tools" || state.inflight?.type === "resume") {
      await executeToolTurn(session, env);
      continue;
    }
    // 预算属于 Query，不能因审批后换了 Run 就重新获得完整步数。
    const step = state.committed.step + 1;
    if (step > Math.min(state.maxSteps, env.maxSteps))
      throw new AgentError("STEP_LIMIT", "Query exhausted its model step budget");
    let request: ModelRequest;
    let requestId: string;
    if (state.inflight?.type === "model") {
      // 恢复复用已保存的请求，不重新渲染可能已变化的动态提示词。
      request = state.inflight.request;
      requestId = state.inflight.requestId;
    } else {
      const contribution = await env.renderPrompt({ identity: env.identity, signal: env.signal });
      env.signal.throwIfAborted();
      const instructions = [env.definition.instructions, contribution].filter(Boolean).join("\n\n");
      request = snapshot({
        messages: [
          ...(instructions
            ? [
                {
                  role: "system" as const,
                  content: [{ type: "text" as const, text: instructions }],
                },
              ]
            : []),
          ...state.committed.messages,
        ],
        tools: env.tools.getSchemas(),
      });
      requestId = `${state.queryId}:step:${step}`;
      await session.save(running(state, { type: "model", requestId, request }));
    }
    env.signal.throwIfAborted();
    env.emit({ identity: env.identity, kind: "fact", type: "step.started", step });
    const response = await executeModelTurn(env, request, requestId, step);
    const calls = response.message.content.filter(
      (part): part is ModelToolCallContent => part.type === "tool-call",
    );
    if (calls.length === 0) {
      // 模型返回不等于提交成功；先保存追加意图，由下一次对账确认完成状态。
      await session.save(
        running(session.state, {
          type: "history",
          batchId: `${state.queryId}:step:${step}`,
          messages: [response.message],
          step,
          terminal: true,
        }),
      );
    } else {
      await session.save(
        running(session.state, {
          type: "tools",
          response,
          remaining: calls.map((call) => ({
            identity: env.identity,
            call,
            toolVersion: env.tools.getVersion(call.name) ?? null,
            state: "pending",
          })),
          completed: [],
        }),
      );
    }
  }
}

/** 一次 Run 拥有一次写租约；等待返回后释放，恢复使用新世代而不是旧 Promise。 */
export async function executeRun(
  request: RunRequest,
  environment: RunEnvironment,
): Promise<AgentRunResult> {
  const env: RunEnvironment = {
    ...environment,
    emit(event) {
      try {
        environment.emit(snapshot(event));
      } catch {
        /* 观察者不能替换执行控制流。 */
      }
    },
  };
  validateIdentity(request, env);
  const cancelledBeforeStart = (): AgentRunResult => {
    const result: AgentRunResult = {
      status: env.isInterrupted() ? "interrupted" : "cancelled",
      identity: env.identity,
    };
    emitResult(result, env);
    return result;
  };
  if (env.signal.aborted) return cancelledBeforeStart();
  const key = {
    agentId: env.identity.agentId,
    threadId: env.identity.threadId,
    queryId: env.identity.queryId,
  };
  const unfinished = await env.checkpoints.findUnfinished(key.agentId, key.threadId);
  if (env.signal.aborted) return cancelledBeforeStart();
  if (unfinished && unfinished.queryId !== key.queryId)
    throw new AgentError(
      "THREAD_PENDING",
      "Resolve or resume the thread's pending query before starting another",
    );
  const acquired = await env.checkpoints.acquire(
    key,
    env.identity.runId,
    request.kind === "resume" && request.input.takeover
      ? { replace: request.input.takeover }
      : undefined,
  );
  if (acquired.status !== "acquired")
    throw new AgentError(
      acquired.status === "busy" ? "WRITER_BUSY" : "STALE_TAKEOVER",
      "Query writer is not available",
    );
  let session: CheckpointSession | undefined;
  try {
    env.signal.throwIfAborted();
    if (request.kind === "run") {
      if (acquired.checkpoint)
        throw new AgentError("QUERY_EXISTS", "Query identity has already been used");
      const history = await env.history.read(key.threadId);
      const state: AgentCheckpoint = {
        schemaVersion: 1,
        ...key,
        lastRunId: env.identity.runId,
        definition: { id: env.definition.id, version: env.definition.version },
        plugins: snapshot(env.plugins),
        model: snapshot(env.model.selection),
        maxSteps: env.maxSteps,
        committed: {
          historyRevision: history.revision,
          messages: snapshot(history.messages),
          step: 0,
        },
        startMessageCount: history.messages.length,
        extensions: [],
        status: "running",
        inflight: {
          type: "history",
          batchId: `${key.queryId}:input`,
          messages: snapshot(request.input.input),
          step: 0,
          terminal: false,
        },
      };
      session = new CheckpointSession(
        acquired.lease,
        acquired.currentRevision,
        state,
        env.checkpoints,
        env.history,
      );
      await session.save(state);
      env.emit({ identity: env.identity, kind: "fact", type: "run.started" });
    } else {
      if (!acquired.checkpoint)
        throw new AgentError("QUERY_NOT_FOUND", "No checkpoint exists for this query");
      const saved = snapshot(acquired.checkpoint);
      validateResume(saved, env);
      if (
        request.input.response &&
        (saved.status !== "waiting" ||
          saved.pending.interaction.id !== request.input.response.interactionId)
      )
        throw new AgentError(
          "STALE_INTERACTION",
          "Response is not for the stored pending interaction",
        );
      const state: AgentCheckpoint =
        saved.status === "waiting"
          ? { ...saved, lastRunId: env.identity.runId }
          : {
              ...running(saved, "inflight" in saved ? saved.inflight : undefined),
              lastRunId: env.identity.runId,
            };
      session = new CheckpointSession(
        acquired.lease,
        acquired.currentRevision,
        state,
        env.checkpoints,
        env.history,
      );
      // 先对账已有历史追加意图，再核对前缀，避免已提交但未确认的追加重复。
      await session.reconcileHistory();
      await session.verifyHistory();
      await session.save(session.state);
      env.emit({ identity: env.identity, kind: "fact", type: "run.started" });
      if (request.input.response) await resumeTool(session, env, snapshot(request.input.response));
    }
    await drive(session, env);
    const result = resultOf(session, env);
    emitResult(result, env);
    return result;
  } catch (error) {
    if (!session) {
      if (env.signal.aborted) return cancelledBeforeStart();
      throw error;
    }
    // 落盘结果不确定或写权限已丢失时，不得用当前内存状态覆盖持久断点。
    if (
      error instanceof AgentError &&
      ["PERSISTENCE_FAILED", "CHECKPOINT_CONFLICT", "HISTORY_CONFLICT"].includes(error.code)
    )
      throw error;
    const state = session.state;
    if (state.status === "waiting") {
      if (!env.signal.aborted) throw error;
      const result = resultOf(session, env);
      emitResult(result, env);
      return result;
    }
    const inflight = "inflight" in state ? state.inflight : undefined;
    if (env.signal.aborted) {
      const status = env.isInterrupted() ? "interrupted" : "cancelled";
      await session.save({ ...checkpointData(state), status, ...(inflight ? { inflight } : {}) });
    } else {
      await session.save({
        ...checkpointData(state),
        status: "failed",
        error: asProtocolError(error),
        ...(inflight ? { inflight } : {}),
      });
    }
    const result = resultOf(session, env);
    emitResult(result, env);
    return result;
  } finally {
    await env.checkpoints.release(acquired.lease);
  }
}
