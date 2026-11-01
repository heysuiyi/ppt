import type { AgentTaskNode } from "@shared/agent-task-list";
import type { PersistedTaskList, TaskStore } from "./task-store";

export interface TaskListSnapshot {
  tasks: AgentTaskNode[];
  goal?: string | null;
  listRevision: number;
  state: PersistedTaskList["state"];
  archive?: PersistedTaskList["archive"];
}

export type TaskListSnapshotListener = (snapshot: TaskListSnapshot) => void;

export interface PublishedTaskList {
  /** Full durable list for scheduler/tool consumers. */
  allTasks: AgentTaskNode[];
  /** Current task-list projection intended for the UI. */
  snapshot: TaskListSnapshot;
}

/**
 * Read and publish the current canonical task-list snapshot.
 */
export async function publishCurrentTaskList(
  store: TaskStore,
  listener?: TaskListSnapshotListener,
): Promise<PublishedTaskList> {
  const persisted = await store.getSnapshot();
  const allTasks = persisted.tasks;
  const snapshot: TaskListSnapshot = {
    tasks: allTasks,
    goal: null,
    listRevision: persisted.listRevision,
    state: persisted.state,
    ...(persisted.archive ? { archive: persisted.archive } : {}),
  };
  listener?.(snapshot);
  return { allTasks, snapshot };
}
