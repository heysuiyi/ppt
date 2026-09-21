import { createModuleLogger, withLogContext } from "../logger";
import type { AgentRunFactory } from "./agent-run-factory";
import { AgentRunFinalizer } from "./agent-run-finalizer";
import { isRuntimeCancellation } from "./lifecycle/runtime-cancellation";
import { query } from "./query/query";
import type { AgentQueryLoopEvent } from "./query/query-types";
import {
  type AgentRuntimeInput,
  type AgentRuntimeResult,
  normalizeAgentRuntimeOptions,
} from "./runtime-types";
import type { AgentLoopTerminalOutcome, PreparedAgentRun } from "./turns/prepared-agent-run";

const logger = createModuleLogger("agent-runtime");

/** Owns one run lifecycle and consumes the independent query state machine. */
export class AgentRuntime {
  private readonly finalizer = new AgentRunFinalizer();

  constructor(
    private readonly runFactory: Pick<AgentRunFactory, "open" | "prepare" | "clearSession">,
  ) {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    const options = normalizeAgentRuntimeOptions(input);
    const scope = await this.runFactory.open(options);
    return withLogContext(
      {
        runId: scope.runId,
        threadId: options.threadId,
        queryId: scope.queryId,
      },
      async () => {
        const startedAt = Date.now();
        logger.info("agent.query.started", {
          startMode: options.startMode.type,
          executionStrategy: options.executionStrategy,
          provider: options.model?.provider,
          model: options.model?.model,
        });
        try {
          const prepared = await this.runFactory.prepare(scope);
          const outcome: AgentLoopTerminalOutcome =
            prepared.type === "short_circuit"
              ? { type: "terminal" as const, result: prepared.result }
              : await this.runQuery(prepared.run);
          const result = await this.finalizer.complete(scope, outcome.result, outcome.reason);
          logger.info("agent.query.completed", {
            resultType: result.type,
            reason: outcome.reason,
            durationMs: Date.now() - startedAt,
          });
          return result;
        } catch (error) {
          const interrupted = isRuntimeCancellation(error, scope.signal, options.signal);
          logger[interrupted ? "info" : "error"](
            interrupted ? "agent.query.interrupted" : "agent.query.failed",
            { durationMs: Date.now() - startedAt, error },
          );
          await this.finalizer.fail(scope, error);
          throw error;
        } finally {
          await scope.close();
        }
      },
    );
  }

  clearSession(threadId: string): void {
    this.runFactory.clearSession(threadId);
  }

  private async runQuery(run: PreparedAgentRun): Promise<AgentLoopTerminalOutcome> {
    const iterator = query(run);
    while (true) {
      const next = await iterator.next();
      if (next.done) return next.value;
      safelyNotifyQueryEvent(run.params.deps.onQueryEvent, next.value);
    }
  }
}

function safelyNotifyQueryEvent(
  handler: ((event: AgentQueryLoopEvent) => void) | undefined,
  event: AgentQueryLoopEvent,
): void {
  try {
    handler?.(event);
  } catch {
    // Query events are projections. Observers cannot replace Runtime control flow.
  }
}
