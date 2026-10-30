import type { ModelMessage } from "../../model/model-contract";
import { AgentError, snapshot } from "../../protocol-utils";
import type { InteractionResponse } from "../../protocol-values";
import type {
  StoredToolCompletion,
  StoredToolInvocation,
  ToolBatchCheckpoint,
} from "../../session/session-contract";
import type {
  ToolCompletion,
  ToolExecutionResult,
  ToolSideEffects,
} from "../../tools/tool-contract";
import { type CheckpointSession, checkpointData, running } from "../query/checkpoint-session";
import type { RunEnvironment } from "../run-controller";

export function unknownCompletion(previousEffects: ToolSideEffects = "unknown"): ToolCompletion {
  return {
    status: "unknown",
    effects: previousEffects === "applied" ? "applied" : "unknown",
    error: {
      code: "TOOL_OUTCOME_UNKNOWN",
      message:
        "This call was dispatched without a durable result. Verify external state before repeating it.",
    },
    modelContent: [
      {
        type: "text",
        text: "Tool outcome is unknown. Do not blindly repeat side effects; inspect the external state or ask the user.",
      },
    ],
  };
}

function toolEvent(
  env: RunEnvironment,
  invocation: StoredToolInvocation,
  completion: ToolCompletion,
  step: number,
): void {
  env.emit({
    identity: env.identity,
    kind: "fact",
    type: "tool.completed",
    step,
    invocation,
    completion,
  });
}

async function settle(
  session: CheckpointSession,
  batch: ToolBatchCheckpoint,
  invocation: StoredToolInvocation,
  result: ToolExecutionResult,
  env: RunEnvironment,
): Promise<boolean> {
  const detached = snapshot(result);
  if (detached.status === "waiting") {
    if (
      !detached.interaction.id ||
      !detached.interaction.owner ||
      !detached.continuation.type ||
      !Number.isSafeInteger(detached.continuation.version)
    ) {
      throw new AgentError("INVALID_INTERACTION", "Tool returned an invalid continuation");
    }
    await session.save({
      ...checkpointData(session.state),
      status: "waiting",
      inflight: batch,
      pending: {
        invocation,
        interaction: detached.interaction,
        continuation: detached.continuation,
        effects: detached.effects,
      },
    });
    env.emit({
      identity: env.identity,
      kind: "fact",
      type: "interaction.requested",
      invocation,
      interaction: detached.interaction,
    });
    return true;
  }
  const completed: StoredToolCompletion = { invocation, completion: detached };
  await session.save(
    running(session.state, { ...batch, completed: [...batch.completed, completed] }),
  );
  toolEvent(env, invocation, detached, session.state.committed.step + 1);
  return false;
}

/** 首版串行派发。每次先落盘 claimed，再进入不可推断幂等的外部执行。 */
export async function executeToolTurn(
  session: CheckpointSession,
  env: RunEnvironment,
): Promise<void> {
  let state = session.state;
  if (state.status !== "running") return;
  if (state.inflight?.type === "resume") {
    // 恢复时读到此阶段说明上一激活已消费回答，无法证明续传的副作用是否完成。
    const { batch, pending } = state.inflight;
    const completion = unknownCompletion(pending.effects);
    await session.save(
      running(state, {
        ...batch,
        completed: [...batch.completed, { invocation: pending.invocation, completion }],
      }),
    );
    toolEvent(env, pending.invocation, completion, state.committed.step + 1);
    state = session.state;
  }
  while (state.status === "running" && state.inflight?.type === "tools") {
    const batch = state.inflight;
    const invocation = batch.remaining[0];
    if (!invocation) {
      const byId = new Map(
        batch.completed.map((item) => [item.invocation.call.callId, item.completion]),
      );
      const calls = batch.response.message.content.filter((part) => part.type === "tool-call");
      if (byId.size !== calls.length || calls.some((call) => !byId.has(call.callId)))
        throw new AgentError(
          "INCOMPLETE_TOOL_BATCH",
          "Every tool call must have one durable result",
        );
      const results: ModelMessage = {
        role: "tool",
        content: calls.map((call) => {
          const result = byId.get(call.callId);
          if (!result) throw new AgentError("INCOMPLETE_TOOL_BATCH", "Missing tool result");
          return {
            type: "tool-result",
            callId: call.callId,
            content: result.modelContent,
            isError: result.status !== "succeeded",
          };
        }),
      };
      await session.save(
        running(state, {
          type: "history",
          batchId: `${state.queryId}:step:${state.committed.step + 1}`,
          messages: [batch.response.message, results],
          step: state.committed.step + 1,
          terminal: false,
        }),
      );
      return;
    }
    env.signal.throwIfAborted();
    const rest = batch.remaining.slice(1);
    if (invocation.state === "dispatched") {
      await settle(session, { ...batch, remaining: rest }, invocation, unknownCompletion(), env);
    } else {
      if ((env.tools.getVersion(invocation.call.name) ?? null) !== invocation.toolVersion) {
        throw new AgentError("TOOL_VERSION_CHANGED", "Tool implementation changed before dispatch");
      }
      const claimed: StoredToolInvocation = { ...invocation, state: "dispatched" };
      await session.save(running(state, { ...batch, remaining: [claimed, ...rest] }));
      env.signal.throwIfAborted();
      env.emit({
        identity: env.identity,
        kind: "fact",
        type: "tool.started",
        step: state.committed.step + 1,
        invocation: claimed,
      });
      const result = await env.tools.execute(snapshot(claimed.call), {
        identity: env.identity,
        callId: claimed.call.callId,
        signal: env.signal,
      });
      if (await settle(session, { ...batch, remaining: rest }, claimed, result, env)) return;
    }
    state = session.state;
  }
}

/** 回答先被 CAS 消费，再运行续传；不能因为恢复而重新 execute 原工具。 */
export async function resumeTool(
  session: CheckpointSession,
  env: RunEnvironment,
  response: InteractionResponse,
): Promise<void> {
  const state = session.state;
  if (state.status !== "waiting")
    throw new AgentError("NOT_WAITING", "Query is not waiting for an interaction");
  const { pending, inflight: batch } = state;
  if (pending.interaction.id !== response.interactionId)
    throw new AgentError("STALE_INTERACTION", "Response does not match the pending interaction");
  if (env.tools.getVersion(pending.invocation.call.name) !== pending.invocation.toolVersion)
    throw new AgentError("TOOL_VERSION_CHANGED", "Pending tool implementation changed");
  env.signal.throwIfAborted();
  await session.save(
    running(state, { type: "resume", batch, pending, response: snapshot(response) }),
  );
  env.emit({
    identity: env.identity,
    kind: "fact",
    type: "interaction.resolved",
    invocation: pending.invocation,
    response,
  });
  if (response.type === "cancel") {
    await session.save({ ...checkpointData(session.state), status: "cancelled", inflight: batch });
    return;
  }
  const result = await env.tools.resume(
    snapshot(pending.invocation.call),
    pending.continuation,
    snapshot(response),
    { identity: env.identity, callId: pending.invocation.call.callId, signal: env.signal },
  );
  if (result.status === "waiting" && result.interaction.id === response.interactionId)
    throw new AgentError(
      "INTERACTION_ID_REUSED",
      "A new wait must have a new interaction identity",
    );
  await settle(session, batch, pending.invocation, result, env);
}
