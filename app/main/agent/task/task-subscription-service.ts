import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import type { TaskMutationResult, TaskStore } from "./task-store";

export type TaskListSnapshot = Omit<TaskMutationResult, "task" | "changed">;
export type TaskSnapshotListener = (snapshot: TaskListSnapshot) => void;

/**
 * Rebuilds snapshots from the canonical file after same-process signals,
 * cross-process file events, and a polling fallback.
 */
export class TaskSubscriptionService {
  private readonly listeners = new Set<TaskSnapshotListener>();
  private watcher?: FSWatcher;
  private pollTimer?: ReturnType<typeof setInterval>;
  private refreshQueued = false;
  private disposed = false;
  private lastRevision = -1;
  private lastContentHash?: string;

  constructor(
    private readonly store: TaskStore,
    private readonly pollIntervalMs = 5_000,
  ) {}

  async subscribe(listener: TaskSnapshotListener): Promise<() => void> {
    if (this.disposed) throw new Error("TaskSubscriptionService is disposed");
    this.listeners.add(listener);
    if (!this.watcher) await this.start();
    await this.refresh();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stopWatching();
    };
  }

  notifyTasksUpdated(taskListId: string): void {
    if (taskListId !== this.store.identity.taskListId || this.disposed) return;
    this.queueRefresh();
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const persisted = await this.store.getSnapshot();
    const snapshot: TaskListSnapshot = {
      taskListId: persisted.taskListId,
      tasks: persisted.tasks,
      listRevision: persisted.listRevision,
      state: persisted.state,
      ...(persisted.archive ? { archive: persisted.archive } : {}),
    };
    const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    if (snapshot.listRevision < this.lastRevision) {
      throw new Error(
        `Task list revision regressed from ${this.lastRevision} to ${snapshot.listRevision}`,
      );
    }
    if (snapshot.listRevision === this.lastRevision) {
      if (this.lastContentHash && this.lastContentHash !== hash) {
        throw new Error(`Task list content changed without revision ${snapshot.listRevision}`);
      }
      return;
    }
    this.lastRevision = snapshot.listRevision;
    this.lastContentHash = hash;
    for (const listener of this.listeners) listener(structuredClone(snapshot));
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.stopWatching();
  }

  private async start(): Promise<void> {
    const location = await this.store.storageLocation();
    this.watcher = watch(location.directory, (_event, filename) => {
      if (!filename || filename.toString() === "tasks.json") this.queueRefresh();
    });
    this.watcher.on("error", () => {
      this.watcher?.close();
      this.watcher = undefined;
    });
    this.pollTimer = setInterval(() => this.queueRefresh(), this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private queueRefresh(): void {
    if (this.refreshQueued || this.disposed) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      void this.refresh().catch(() => {
        // Polling remains active; the next valid atomic snapshot can recover.
      });
    });
  }

  private stopWatching(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}
