import { z } from "zod";
import type { ToolPermissionProfile } from "../runtime/tools/tool-access-policy";
import type { SubAgentToolDefinition } from "../subagent/workspace-tools";
import { publishCurrentTaskList, type TaskListSnapshotListener } from "../task/task-list-publisher";
import type { TaskCommandPrincipal, TaskDispatchCandidate } from "../task/task-store";
import { type TaskStore, TaskStoreError } from "../task/task-store";

const TASK_TOOL_PERMISSION: ToolPermissionProfile = {
  profile: "teammate-task-board",
  description: "Read or update the shared persistent task list.",
  scopes: ["subagent"],
  effects: ["workflow.delegate"],
  sandbox: "workspace",
  approval: "never",
};

const emptySchema = z.object({}).strict();
const getSchema = z.object({ taskId: z.string().min(1) }).strict();
const claimSchema = z
  .object({
    taskId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
const updateSchema = z
  .object({
    taskId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    subject: z.string().min(1).optional(),
    description: z.string().optional(),
    activeForm: z.string().optional(),
    status: z.enum(["pending", "in_progress"]).optional(),
    userMetadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const reviewRequestSchema = z
  .object({
    taskId: z.string().min(1),
    requestId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

function teammatePrincipal(store: TaskStore, owner: string): TaskCommandPrincipal {
  return store.principal(owner, "teammate", new Set(["task:update_own"]));
}

export function createTeammateTaskTools(
  store: TaskStore,
  owner: string,
  onTasksUpdated?: TaskListSnapshotListener,
): SubAgentToolDefinition[] {
  const principal = teammatePrincipal(store, owner);
  const publish = () => publishCurrentTaskList(store, onTasksUpdated);

  const listTool: SubAgentToolDefinition<typeof emptySchema> = {
    name: "TaskList",
    description: "Read the complete shared task list. This tool never changes task state.",
    inputSchema: emptySchema,
    permission: TASK_TOOL_PERMISSION,
    async execute() {
      return JSON.stringify(await store.getSnapshot(), null, 2);
    },
  };
  const getTool: SubAgentToolDefinition<typeof getSchema> = {
    name: "TaskGet",
    description: "Read one complete task and its derived blocked/claimable state.",
    inputSchema: getSchema,
    permission: TASK_TOOL_PERMISSION,
    async execute(args) {
      return JSON.stringify(await store.getDerived(args.taskId), null, 2);
    },
  };
  const claimTool: SubAgentToolDefinition<typeof claimSchema> = {
    name: "TaskClaim",
    description: "Claim a task as yourself. Claim changes owner only, never status.",
    inputSchema: claimSchema,
    permission: TASK_TOOL_PERMISSION,
    async execute(args) {
      const result = await store.mutate({ type: "claim", ...args }, principal);
      await publish();
      return JSON.stringify(result, null, 2);
    },
  };
  const updateTool: SubAgentToolDefinition<typeof updateSchema> = {
    name: "TaskUpdate",
    description: "Update your claimed task. Set status=in_progress before concrete work.",
    inputSchema: updateSchema,
    permission: TASK_TOOL_PERMISSION,
    async execute(args) {
      const result = await store.mutate({ type: "update", ...args }, principal);
      await publish();
      return JSON.stringify(result, null, 2);
    },
  };
  const reviewTool: SubAgentToolDefinition<typeof reviewRequestSchema> = {
    name: "TaskReviewRequest",
    description:
      "Persist a review request after completing concrete work. Reuse requestId only for retries.",
    inputSchema: reviewRequestSchema,
    permission: TASK_TOOL_PERMISSION,
    async execute(args) {
      const result = await store.mutate({ type: "review_request", ...args }, principal);
      await publish();
      return JSON.stringify(result, null, 2);
    },
  };
  return [listTool, getTool, claimTool, updateTool, reviewTool];
}

export async function claimNextDispatchTask(
  store: TaskStore,
  owner: string,
  onTasksUpdated?: TaskListSnapshotListener,
): Promise<TaskDispatchCandidate | undefined> {
  const principal = teammatePrincipal(store, owner);
  for (const candidate of await store.listDispatchCandidates(owner)) {
    try {
      const result = await store.mutate(
        {
          type: "claim",
          taskId: candidate.task.id,
          expectedRevision: candidate.task.revision,
        },
        principal,
      );
      await publishCurrentTaskList(store, onTasksUpdated);
      return { ...candidate, task: result.task! };
    } catch {
      // A competing process claimed or changed this task. Continue with the next snapshot candidate.
    }
  }
  return undefined;
}

export async function releaseOwnedTasks(
  store: TaskStore,
  owner: string,
  onTasksUpdated?: TaskListSnapshotListener,
): Promise<string[]> {
  const principal = teammatePrincipal(store, owner);
  const released: string[] = [];
  for (const task of await store.listTasks()) {
    if (task.owner !== owner) continue;
    try {
      await store.mutate(
        {
          type: "release",
          taskId: task.id,
          expectedRevision: task.revision,
        },
        principal,
      );
      released.push(task.id);
    } catch (error) {
      // Another writer may have removed or revised the task after listTasks().
      // Those facts are authoritative; operational and policy failures are not.
      if (
        error instanceof TaskStoreError &&
        (error.code === "TASK_NOT_FOUND" || error.code === "REVISION_CONFLICT")
      ) {
        continue;
      }
      throw error;
    }
  }
  if (released.length) await publishCurrentTaskList(store, onTasksUpdated);
  return released;
}

export function formatTaskAssignment(candidate: TaskDispatchCandidate): string {
  const recovery =
    candidate.mode === "new_pending"
      ? "This is new work."
      : "This is recovered work. Inspect existing artifacts and continue from the durable state; do not restart by default.";
  return `<task_assignment source="task_list" mode="${candidate.mode}" owner="${candidate.task.owner}">
${JSON.stringify(candidate.task, null, 2)}
</task_assignment>
${recovery}
First call TaskGet for taskId "${candidate.task.id}" and inspect any artifact paths in description/userMetadata.
For new pending work, call TaskUpdate(status="in_progress") before concrete work.
When the artifact is ready, call TaskReviewRequest with a stable new requestId and the latest revision.`;
}
