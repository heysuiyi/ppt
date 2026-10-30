import type { ModelMessage, ModelSelection } from "./model/model-contract";
import type {
  Disposable,
  InteractionRequest,
  InteractionResponse,
  ProtocolError,
  RunIdentity,
} from "./protocol-values";
import type { RuntimeEvent } from "./session/session-events";

/** Stable execution definition identity; resume must reject incompatible definitions. */
export interface AgentDefinition {
  readonly id: string;
  readonly version: string;
  readonly instructions: string;
}

export interface AgentRunInput {
  readonly threadId: string;
  readonly queryId: string;
  readonly runId: string;
  readonly input: readonly ModelMessage[];
  readonly signal?: AbortSignal;
}

/** The runtime loads the authoritative checkpoint; callers cannot replace its state. */
export interface AgentResumeInput {
  readonly threadId: string;
  readonly queryId: string;
  readonly runId: string;
  /** Only valid for the corresponding stored pending interaction; consume it atomically. */
  readonly response?: InteractionResponse;
  readonly signal?: AbortSignal;
}

export type AgentRunResult =
  | {
      readonly status: "completed";
      readonly identity: RunIdentity;
      readonly output: readonly ModelMessage[];
    }
  | {
      readonly status: "waiting";
      readonly identity: RunIdentity;
      readonly interaction: InteractionRequest;
    }
  | { readonly status: "cancelled"; readonly identity: RunIdentity }
  | {
      readonly status: "failed";
      readonly identity: RunIdentity;
      readonly error: ProtocolError;
    };

export interface AgentRunHandle {
  readonly identity: RunIdentity;
  /** One consumer; observing or abandoning the stream cannot drive or cancel execution. */
  readonly events: AsyncIterable<RuntimeEvent>;
  /** Settles after execution and cleanup; persistence failures may reject instead of claiming success. */
  readonly completed: Promise<AgentRunResult>;
  /** Stops new dispatches and signals active work; cancellation does not undo external effects. */
  cancel(reason?: string): void;
}

export interface Agent extends Disposable {
  readonly id: string;
  readonly definition: AgentDefinition;
  readonly model: ModelSelection;
  /** Reject concurrent activations of this Agent rather than sharing mutable execution state. */
  run(input: AgentRunInput): Promise<AgentRunHandle>;
  resume(input: AgentResumeInput): Promise<AgentRunHandle>;
}
