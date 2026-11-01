import type { TaskListIdentity } from "./task-store";

export type TaskListIdentityInput = {
  taskListId?: string;
  teamSessionId?: string;
  threadId: string;
};

export function resolveTaskListIdentity(input: TaskListIdentityInput): TaskListIdentity {
  const explicit = input.taskListId?.trim();
  if (explicit) {
    return {
      taskListId: explicit,
      scope: input.teamSessionId ? "team" : "conversation",
      canonicalKey: `${input.teamSessionId ? "team" : "conversation"}:${explicit}`,
    };
  }
  const team = input.teamSessionId?.trim();
  if (team) {
    return { taskListId: team, scope: "team", canonicalKey: `team:${team}` };
  }
  const thread = input.threadId.trim();
  if (!thread) throw new Error("Task list identity requires threadId");
  return { taskListId: thread, scope: "conversation", canonicalKey: `conversation:${thread}` };
}
