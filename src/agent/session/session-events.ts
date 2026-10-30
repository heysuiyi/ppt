import type { ModelContentDelta } from "../model/model-contract";
import type {
  InteractionRequest,
  InteractionResponse,
  ProtocolError,
  RunIdentity,
} from "../protocol-values";
import type { ToolCompletion } from "../tools/tool-contract";
import type { StoredToolInvocation } from "./session-contract";

interface RuntimeEventIdentity {
  /** Identity of the run emitting this event, even when it resumes an older tool call. */
  readonly identity: RunIdentity;
}

/**
 * Lifecycle observations, not UI instructions or a durable event log. A fact alone does
 * not promise a checkpoint commit; step.committed explicitly identifies durable history.
 */
export type RuntimeFactEvent = RuntimeEventIdentity &
  (
    | {
        readonly kind: "fact";
        readonly type: "run.started" | "run.completed" | "run.cancelled";
      }
    | {
        readonly kind: "fact";
        readonly type: "run.waiting";
        readonly interactionId: string;
      }
    | {
        readonly kind: "fact";
        readonly type: "run.failed";
        readonly error: ProtocolError;
      }
    | {
        readonly kind: "fact";
        readonly type: "step.started";
        readonly step: number;
      }
    | {
        readonly kind: "fact";
        readonly type: "step.committed";
        readonly step: number;
        readonly historyRevision: number;
      }
    | {
        readonly kind: "fact";
        readonly type: "tool.started";
        readonly step: number;
        readonly invocation: StoredToolInvocation;
      }
    | {
        readonly kind: "fact";
        readonly type: "tool.completed";
        readonly step: number;
        readonly invocation: StoredToolInvocation;
        /** The completion discriminant distinguishes success, failure and unknown outcome. */
        readonly completion: ToolCompletion;
      }
    | {
        readonly kind: "fact";
        readonly type: "interaction.requested";
        readonly invocation: StoredToolInvocation;
        readonly interaction: InteractionRequest;
      }
    | {
        readonly kind: "fact";
        readonly type: "interaction.resolved";
        readonly invocation: StoredToolInvocation;
        /** Accepted for the stored waiting interaction, not merely received from a client. */
        readonly response: InteractionResponse;
      }
  );

/**
 * Provisional model output, never canonical history or a resumable execution snapshot.
 * Consumers may drop deltas; cancellation/failure may leave an incomplete stream.
 */
export interface RuntimeStreamEvent extends RuntimeEventIdentity {
  readonly kind: "stream";
  readonly type: "model.delta";
  readonly step: number;
  readonly requestId: string;
  /** Position in the final assistant message's ordered content array. */
  readonly contentIndex: number;
  readonly delta: ModelContentDelta;
}

export type RuntimeEvent = RuntimeFactEvent | RuntimeStreamEvent;
