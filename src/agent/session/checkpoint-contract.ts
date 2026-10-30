import type { AgentCheckpoint } from "./session-contract";

export interface CheckpointKey {
  readonly agentId: string;
  readonly threadId: string;
  readonly queryId: string;
}

export interface CheckpointLease {
  readonly key: CheckpointKey;
  /** Identifies one writer activation, normally its runId; not a shared process identity. */
  readonly ownerId: string;
  /** Monotonically advances on every acquisition for this key and is never reused. */
  readonly generation: number;
}

export interface CheckpointAcquireOptions {
  /**
   * Explicit takeover after the host has established that this writer has stopped.
   * Storage compares the entire observed lease before replacing it atomically.
   * Fencing cannot retract external effects already dispatched by the old writer.
   */
  readonly replace?: CheckpointLease;
}

export type CheckpointAcquireResult =
  | { readonly status: "busy"; readonly lease: CheckpointLease }
  | { readonly status: "stale" }
  | {
      readonly status: "acquired";
      readonly lease: CheckpointLease;
      /** Zero before the first save; releasing or acquiring does not change this revision. */
      readonly currentRevision: number;
      readonly checkpoint: AgentCheckpoint | null;
    };

export type CheckpointSaveResult =
  | { readonly status: "saved"; readonly revision: number }
  | { readonly status: "conflict"; readonly currentRevision: number }
  | { readonly status: "stale" };

/**
 * Storage atomically enforces exclusive writer ownership, generation fencing and revision
 * CAS across all writers, not just within one store object. There is no lease TTL or
 * automatic takeover. I/O failures reject; they are not busy/conflict/stale.
 */
export interface CheckpointStore {
  /**
   * Atomically acquire an unowned key or replace the exact lease explicitly supplied.
   * A live owner without a matching replacement makes this busy, even if ownerId matches.
   * A stale replacement must not acquire or release the key, including after it was released.
   * Successful acquisition reads the snapshot and advances the writer generation.
   */
  acquire(
    key: CheckpointKey,
    ownerId: string,
    options?: CheckpointAcquireOptions,
  ): Promise<CheckpointAcquireResult>;
  /**
   * First fence by the current key/ownerId/generation, then compare expectedRevision.
   * A mismatched or released lease is stale; a current lease with a revision mismatch
   * conflicts. Neither outcome writes anything. The checkpoint identity must match key.
   *
   * Success atomically replaces the whole checkpoint and advances revision by one;
   * both the snapshot and revision are durably committed before this promise resolves
   * and survive store/process restart. A rejected write may have committed: callers
   * must reconcile from storage, not assume failure means no write.
   *
   * This protects checkpoint ownership only. It does not make tool side effects,
   * interaction consumption, or writes to another store exactly-once by itself.
   */
  save(
    lease: CheckpointLease,
    expectedRevision: number,
    checkpoint: AgentCheckpoint,
  ): Promise<CheckpointSaveResult>;
  /**
   * Idempotent. Release only when key, ownerId and generation still identify the current
   * owner; a stale release must never release a newer writer or delete its checkpoint.
   */
  release(lease: CheckpointLease): Promise<void>;
}
