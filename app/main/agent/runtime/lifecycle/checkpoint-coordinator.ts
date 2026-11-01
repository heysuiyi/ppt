import type {
  CheckpointLease,
  CheckpointSaveResult,
  DurableRunCheckpoint,
  DurableRunStore,
} from "../../persistence/durable-run-store";

export type CheckpointCoordinatorState = "open" | "terminal_fenced" | "faulted" | "closed";

/**
 * Serializes immutable checkpoint snapshots for one Runtime invocation.
 *
 * This is the version-1 mechanical coordinator. Store-level generation/CAS is
 * added behind DurableRunStore without changing this lifecycle contract.
 */
export class CheckpointCoordinator {
  private writeTail: Promise<void> = Promise.resolve();
  private stateValue: CheckpointCoordinatorState = "open";
  private enqueuedRevision: number;
  private lastConfirmedRevision: number;

  constructor(
    private readonly store?: Pick<DurableRunStore, "save"> &
      Partial<Pick<DurableRunStore, "saveCas" | "closeLease" | "inspectLease">>,
    private readonly lease?: CheckpointLease,
    currentRevision = 0,
  ) {
    this.enqueuedRevision = currentRevision;
    this.lastConfirmedRevision = currentRevision;
  }

  get state(): CheckpointCoordinatorState {
    return this.stateValue;
  }

  async commit(checkpoint: DurableRunCheckpoint): Promise<void> {
    if (!this.store) return;
    if (this.stateValue !== "open") {
      throw new Error(`Checkpoint coordinator cannot commit while ${this.stateValue}.`);
    }
    await this.enqueue(checkpoint, false);
  }

  async commitTerminal(checkpoint: DurableRunCheckpoint): Promise<void> {
    if (!this.store) {
      this.stateValue = "terminal_fenced";
      return;
    }
    if (this.stateValue !== "open") {
      throw new Error(`Checkpoint coordinator cannot fence terminal while ${this.stateValue}.`);
    }
    this.stateValue = "terminal_fenced";
    try {
      await this.writeTail;
      await this.enqueue(checkpoint, true);
    } catch (error) {
      this.stateValue = "faulted";
      throw error;
    }
  }

  /**
   * Best-effort failure terminal path. It is intentionally allowed after a
   * normal write or an unsealed success-terminal write has faulted.
   */
  async commitFailureTerminal(checkpoint: DurableRunCheckpoint): Promise<boolean> {
    if (!this.store) {
      this.stateValue = "terminal_fenced";
      return true;
    }
    if (this.stateValue === "closed") return false;
    this.stateValue = "terminal_fenced";
    try {
      await this.writeTail.catch(() => undefined);
      this.writeTail = Promise.resolve();
      if (this.lease && this.store.inspectLease) {
        const inspected = await this.store.inspectLease(this.lease);
        if (inspected.type === "stale") return false;
        // Reconcile an ambiguous IO result: if the previous revision reached
        // storage, failure terminal continues from it instead of retrying a
        // different payload at the same revision.
        this.lastConfirmedRevision = inspected.revision;
      }
      this.enqueuedRevision = this.lastConfirmedRevision;
      await this.enqueue(checkpoint, true);
      return true;
    } catch {
      this.stateValue = "faulted";
      return false;
    }
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  async close(): Promise<void> {
    if (this.stateValue === "closed") return;
    try {
      await this.writeTail;
    } finally {
      if (this.store && this.lease) await this.store.closeLease?.(this.lease);
      this.stateValue = "closed";
    }
  }

  private async enqueue(checkpoint: DurableRunCheckpoint, allowFenced: boolean): Promise<void> {
    if (!this.store) return;
    if (this.stateValue === "closed") {
      throw new Error("Checkpoint coordinator is closed.");
    }
    if (!allowFenced && this.stateValue !== "open") {
      throw new Error(`Checkpoint coordinator cannot enqueue while ${this.stateValue}.`);
    }

    const snapshot = structuredClone(checkpoint);
    const expectedRevision = this.enqueuedRevision;
    const nextRevision = expectedRevision + 1;
    this.enqueuedRevision = nextRevision;
    const write = this.writeTail.then(async () => {
      if (!this.lease) {
        await this.store!.save(snapshot);
        return;
      }
      if (!this.store!.saveCas) throw new Error("Checkpoint store does not support lease CAS.");
      const result = await this.store!.saveCas({
        lease: this.lease,
        expectedRevision,
        nextRevision,
        checkpoint: snapshot,
      });
      this.acceptSaveResult(result, nextRevision);
    });
    this.writeTail = write;
    try {
      await write;
    } catch (error) {
      this.stateValue = "faulted";
      throw error;
    }
  }

  private acceptSaveResult(result: CheckpointSaveResult, revision: number): void {
    if (result === "saved" || result === "already_applied") {
      this.lastConfirmedRevision = revision;
      return;
    }
    if (result === "stale_generation") {
      throw new Error("Checkpoint lease became stale because a newer run owns this thread.");
    }
    throw new Error("Checkpoint revision conflict detected.");
  }
}
