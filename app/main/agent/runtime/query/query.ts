import { ModelTurnRunner } from "../turns/model-turn-runner";
import type { AgentLoopTerminalOutcome, PreparedAgentRun } from "../turns/prepared-agent-run";
import { ToolTurnRunner } from "../turns/tool-turn-runner";
import {
  type AgentQueryContinue,
  type AgentQueryLoopEvent,
  createIterationWorkspace,
  reduceQueryState,
} from "./query-types";

export interface AgentQueryDriver {
  modelTurns: Pick<ModelTurnRunner, "run">;
  toolTurns: Pick<ToolTurnRunner, "runBatch">;
}

const defaultDriver: AgentQueryDriver = {
  modelTurns: new ModelTurnRunner(),
  toolTurns: new ToolTurnRunner(),
};

/**
 * Drives one logical query as an async state-machine stream.
 *
 * QueryParams remain immutable. QueryState is replaced only after a complete
 * model/tool iteration, while the IterationWorkspace owns all uncommitted
 * assistant and tool-result data. The yielded events are observations; callers
 * must not use them as a second state store.
 */
export async function* query(
  run: PreparedAgentRun,
  driver: AgentQueryDriver = defaultDriver,
): AsyncGenerator<AgentQueryLoopEvent, AgentLoopTerminalOutcome> {
  const machine = runQueryMachine(run, driver);
  let turnCount = run.initialState.turnCount;
  try {
    while (true) {
      const next = await machine.next();
      if (next.done) return next.value;
      turnCount = next.value.turnCount;
      yield next.value;
    }
  } catch (error) {
    yield {
      type: "query_failed",
      queryId: run.scope.queryId,
      turnCount,
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

async function* runQueryMachine(
  run: PreparedAgentRun,
  driver: AgentQueryDriver,
): AsyncGenerator<AgentQueryLoopEvent, AgentLoopTerminalOutcome> {
  const { scope } = run;
  let state = run.initialState;
  scope.setCommittedQueryState(state);
  yield {
    type: "query_started",
    queryId: scope.queryId,
    turnCount: state.turnCount,
  };

  if (run.initialWorkspace) {
    yield {
      type: "workspace_recovered",
      queryId: scope.queryId,
      turnCount: state.turnCount,
      phase: run.initialWorkspacePhase ?? "model_received",
      toolUseCount: run.initialWorkspace.toolUseBlocks.length,
      toolResultCount: run.initialWorkspace.toolResults.length,
    };
  }

  if (run.initialWorkspace && run.initialWorkspacePhase !== "model_streaming") {
    const workspace = run.initialWorkspace;
    scope.setInflightQuery("model_received", workspace);
    if (workspace.toolResults.length < workspace.toolUseBlocks.length) {
      const toolOutcome = await driver.toolTurns.runBatch(
        run,
        workspace.toolUseBlocks,
        workspace,
        state,
      );
      yield {
        type: "tool_batch_completed",
        queryId: scope.queryId,
        turnCount: state.turnCount,
        toolUseCount: workspace.toolUseBlocks.length,
        toolResultCount: workspace.toolResults.length,
        terminal: toolOutcome.type === "terminal",
      };
      if (toolOutcome.type === "terminal") {
        const committed = await commitTerminalWorkspace(run, state, workspace, toolOutcome);
        state = committed.state;
        if (committed.didCommit) {
          yield {
            type: "state_committed",
            queryId: scope.queryId,
            turnCount: state.turnCount,
            reason: "completed",
          };
        }
        yield {
          type: "query_completed",
          queryId: scope.queryId,
          turnCount: state.turnCount,
          reason: "terminal",
          resultType: toolOutcome.result.type,
        };
        return toolOutcome;
      }
    }
    state = reduceQueryState(state, workspace);
    scope.setCommittedQueryState(state);
    await scope.persistCheckpoint();
    yield {
      type: "state_committed",
      queryId: scope.queryId,
      turnCount: state.turnCount,
      reason: state.transition?.reason ?? "next_turn",
    };
  }

  let replayWorkspace =
    run.initialWorkspacePhase === "model_streaming" ? run.initialWorkspace : undefined;

  while (true) {
    if (state.turnCount >= run.params.maxTurns) {
      const outcome = await run.resolveStepLimit();
      yield {
        type: "query_completed",
        queryId: scope.queryId,
        turnCount: state.turnCount,
        reason: "step_limit",
        resultType: outcome.result.type,
      };
      return outcome;
    }
    if (scope.signal.aborted) throw new Error("Run aborted by user.");

    const workspace = replayWorkspace ?? createIterationWorkspace(state);
    const isStreamingReplay = replayWorkspace !== undefined;
    replayWorkspace = undefined;
    if (!isStreamingReplay) {
      scope.setInflightQuery("model_streaming", workspace);
    }

    const modelOutcome = await driver.modelTurns.run(run, state, workspace);
    yield {
      type: "model_turn_completed",
      queryId: scope.queryId,
      turnCount: state.turnCount,
      decision: modelOutcome.type,
      toolUseCount: workspace.toolUseBlocks.length,
    };
    if (modelOutcome.type === "terminal") {
      const committed = await commitTerminalWorkspace(run, state, workspace, modelOutcome);
      state = committed.state;
      if (committed.didCommit) {
        yield {
          type: "state_committed",
          queryId: scope.queryId,
          turnCount: state.turnCount,
          reason: "completed",
        };
      }
      yield {
        type: "query_completed",
        queryId: scope.queryId,
        turnCount: state.turnCount,
        reason: "terminal",
        resultType: modelOutcome.result.type,
      };
      return modelOutcome;
    }

    if (modelOutcome.type === "tool_batch") {
      const toolOutcome = await driver.toolTurns.runBatch(
        run,
        workspace.toolUseBlocks,
        workspace,
        state,
      );
      yield {
        type: "tool_batch_completed",
        queryId: scope.queryId,
        turnCount: state.turnCount,
        toolUseCount: workspace.toolUseBlocks.length,
        toolResultCount: workspace.toolResults.length,
        terminal: toolOutcome.type === "terminal",
      };
      if (toolOutcome.type === "terminal") {
        const committed = await commitTerminalWorkspace(run, state, workspace, toolOutcome);
        state = committed.state;
        if (committed.didCommit) {
          yield {
            type: "state_committed",
            queryId: scope.queryId,
            turnCount: state.turnCount,
            reason: "completed",
          };
        }
        yield {
          type: "query_completed",
          queryId: scope.queryId,
          turnCount: state.turnCount,
          reason: "terminal",
          resultType: toolOutcome.result.type,
        };
        return toolOutcome;
      }
    }

    const transition: AgentQueryContinue = {
      reason: modelOutcome.type === "continue" ? (modelOutcome.reason ?? "next_turn") : "next_turn",
    };
    state = reduceQueryState(state, workspace, transition);
    scope.setCommittedQueryState(state);
    await scope.persistCheckpoint();
    yield {
      type: "state_committed",
      queryId: scope.queryId,
      turnCount: state.turnCount,
      reason: transition.reason,
    };
  }
}

async function commitTerminalWorkspace(
  run: PreparedAgentRun,
  state: Parameters<typeof reduceQueryState>[0],
  workspace: Parameters<typeof reduceQueryState>[1],
  outcome: AgentLoopTerminalOutcome,
): Promise<{ state: Parameters<typeof reduceQueryState>[0]; didCommit: boolean }> {
  // A user-interaction terminal deliberately keeps the paired batch inflight
  // so waiting_user resume can append the answer to the same logical Query.
  if (outcome.result.type === "ask_user" || !hasCompleteToolPairing(workspace)) {
    return { state, didCommit: false };
  }

  const nextState = reduceQueryState(state, workspace, { reason: "completed" });
  run.scope.stageConversationHistory(state, workspace);
  run.scope.setCommittedQueryState(nextState);
  await run.scope.persistCheckpoint();
  return { state: nextState, didCommit: true };
}

function hasCompleteToolPairing(workspace: Parameters<typeof reduceQueryState>[1]): boolean {
  if (workspace.toolUseBlocks.length !== workspace.toolResults.length) return false;
  const resultIds = new Set(workspace.toolResults.map((result) => result.toolUseId));
  return workspace.toolUseBlocks.every((toolUse) => resultIds.has(toolUse.id));
}
