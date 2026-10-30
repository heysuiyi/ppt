import type {
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelSelection,
  ModelToolCallContent,
} from "../model/model-contract";
import type {
  InteractionRequest,
  ProtocolError,
  RunIdentity,
  VersionedData,
} from "../protocol-values";
import type { ToolCompletion, ToolSideEffects } from "../tools/tool-contract";

export interface SessionHistory {
  readonly threadId: string;
  /** Starts at zero for an empty thread and increases on each successful append. */
  readonly revision: number;
  readonly messages: readonly ModelMessage[];
}

export type SessionHistoryAppendResult =
  | { readonly status: "appended"; readonly revision: number }
  | { readonly status: "conflict"; readonly currentRevision: number };

/** Canonical model history, including ordered tool calls/results and provider replay state. */
export interface SessionHistoryStore {
  /** Missing threads read as an empty history at revision zero. I/O failures reject. */
  read(threadId: string): Promise<SessionHistory>;
  /**
   * Atomically append the entire ordered batch only when expectedRevision matches.
   * Success durably preserves the existing prefix and advances the revision by one;
   * conflict changes nothing. I/O failures reject rather than becoming conflicts.
   */
  append(
    threadId: string,
    expectedRevision: number,
    messages: readonly ModelMessage[],
  ): Promise<SessionHistoryAppendResult>;
}

/** Identity and pinned implementation version survive a different run resuming this call. */
export interface StoredToolInvocation {
  readonly identity: RunIdentity;
  readonly call: ModelToolCallContent;
  readonly toolVersion: string;
}

export interface StoredToolCompletion {
  readonly invocation: StoredToolInvocation;
  /** Includes the already-converted model content; recovery must not rerun its conversion. */
  readonly completion: ToolCompletion;
}

export interface ModelRequestCheckpoint {
  readonly type: "model";
  readonly requestId: string;
  readonly request: ModelRequest;
}

export interface ToolBatchCheckpoint {
  readonly type: "tools";
  /** The authoritative response preserves call ordering and provider replay state. */
  readonly response: ModelResponse;
  /**
   * Calls without a durably recorded completion, excluding a waiting checkpoint's
   * pending invocation. Absence of a result is not proof that no side effect occurred.
   */
  readonly remaining: readonly StoredToolInvocation[];
  readonly completed: readonly StoredToolCompletion[];
}

export type InflightCheckpoint = ModelRequestCheckpoint | ToolBatchCheckpoint;

export interface PendingInteraction {
  readonly invocation: StoredToolInvocation;
  readonly interaction: InteractionRequest;
  readonly continuation: VersionedData;
  readonly effects: ToolSideEffects;
}

interface AgentCheckpointBase {
  readonly schemaVersion: 1;
  readonly agentId: string;
  readonly threadId: string;
  readonly queryId: string;
  readonly lastRunId: string;
  readonly definition: { readonly id: string; readonly version: string };
  readonly model: ModelSelection;
  readonly committed: {
    /** Revision of the authoritative history represented by messages. */
    readonly historyRevision: number;
    readonly messages: readonly ModelMessage[];
    /** Last fully committed step; zero before the first step. Inflight is the next step. */
    readonly step: number;
  };
  /** Unique producer names in type; extension payloads never replace kernel fields. */
  readonly extensions: readonly VersionedData[];
}

/**
 * Persist only serializable protocol values, never services, credentials or abort signals.
 * Call IDs partition the tool response into remaining/completed and, while waiting,
 * exactly one pending invocation; retain original IDs and tool versions on recovery.
 * This snapshot and SessionHistoryStore are not an implicit cross-store transaction.
 */
export type AgentCheckpoint = AgentCheckpointBase &
  (
    | { readonly status: "running"; readonly inflight?: InflightCheckpoint }
    | {
        readonly status: "waiting";
        readonly inflight: ToolBatchCheckpoint;
        /**
         * Only this stored interaction may accept a matching response. Its consumption
         * and transition out of waiting must be committed under the checkpoint CAS;
         * reject duplicate or stale responses rather than executing the continuation twice.
         */
        readonly pending: PendingInteraction;
      }
    | { readonly status: "completed" }
    | {
        /** Cancellation stops future work; it neither rolls back history nor external effects. */
        readonly status: "cancelled";
        readonly inflight?: InflightCheckpoint;
      }
    | {
        readonly status: "failed";
        readonly error: ProtocolError;
        readonly inflight?: InflightCheckpoint;
      }
  );
