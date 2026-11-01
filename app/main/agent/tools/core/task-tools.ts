import { type AgentTaskNode, formatTaskListSummary } from "@shared/agent-task-list";
import { z } from "zod";
import {
  type TaskCommand,
  type TaskCommandPrincipal,
  type TaskMutationResult,
  type TaskStore,
  TaskStoreError,
} from "../../task/task-store";
import type { ToolContext, ToolDefinition } from "../tool-definition";

function store(context: ToolContext): TaskStore {
  if (!context.taskStore) throw new Error("Task store is not available (workspace root required).");
  return context.taskStore;
}

function principal(context: ToolContext): TaskCommandPrincipal {
  if (!context.taskPrincipal) {
    throw new TaskStoreError("NOT_AUTHORIZED", "Trusted Task principal is not available");
  }
  return context.taskPrincipal;
}

type ToolTaskSuccess = TaskMutationResult & {
  ok: true;
  summary: string;
  code?: undefined;
};
type ToolTaskFailure = { ok: false; code: string; error: string; summary: string };
type ToolTaskResult = ToolTaskSuccess | ToolTaskFailure;

async function execute(
  context: ToolContext,
  command: TaskCommand,
  summary: (result: TaskMutationResult) => string,
): Promise<ToolTaskResult> {
  try {
    const result = await store(context).mutate(command, principal(context));
    context.notifyTaskListUpdated?.({
      tasks: result.tasks,
      listRevision: result.listRevision,
      state: result.state,
      ...(result.archive ? { archive: result.archive } : {}),
    });
    return { ok: true, ...result, summary: summary(result) };
  } catch (error) {
    const failure = taskToolError(error);
    return { ...failure, summary: `${failure.code}: ${failure.error}` };
  }
}

const id = z.string().min(1);
const revision = z.number().int().nonnegative();
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const taskCreateSchema = strict({
  subject: z.string().min(1),
  description: z.string(),
  activeForm: z.string().optional(),
  executionTarget: z.enum(["lead", "teammate"]),
  completionPolicy: z.enum(["direct", "review_required"]),
  userMetadata: z.record(z.string(), z.unknown()).optional(),
});

const dependencyChangesSchema = strict({
  addBlocks: z.array(id).optional(),
  addBlockedBy: z.array(id).optional(),
  removeBlocks: z.array(id).optional(),
  removeBlockedBy: z.array(id).optional(),
}).refine(
  (value) => Object.values(value).some((items) => items?.length),
  "At least one dependency change is required",
);

export const taskUpdateSchema = strict({
  taskId: id,
  expectedRevision: revision,
  subject: z.string().min(1).optional(),
  description: z.string().optional(),
  activeForm: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  userMetadata: z.record(z.string(), z.unknown()).optional(),
  dependencyChanges: dependencyChangesSchema.optional(),
  expectedListRevision: revision.optional(),
});

const taskExpectedSchema = strict({ taskId: id, expectedRevision: revision });
const taskListExpectedSchema = strict({ expectedListRevision: revision });

export const taskDeleteSchema = strict({
  taskId: id,
  expectedRevision: revision,
  expectedListRevision: revision,
});
export const taskClaimSchema = strict({ taskId: id, expectedRevision: revision.optional() });
export const taskAssignSchema = strict({ taskId: id, owner: id, expectedRevision: revision });
export const taskReleaseSchema = taskExpectedSchema;
export const taskTransferSchema = strict({ taskId: id, newOwner: id, expectedRevision: revision });
export const taskReviewRequestSchema = strict({
  taskId: id,
  requestId: id,
  expectedRevision: revision,
});
export const taskReviewApproveSchema = taskReviewRequestSchema;
export const taskReviewRejectSchema = strict({
  taskId: id,
  requestId: id,
  reason: z.string().optional(),
  expectedRevision: revision,
});
export const taskListSchema = strict({});
export const taskGetSchema = strict({ taskId: id });
export const taskReopenSchema = taskExpectedSchema;
export const taskCloseListSchema = taskListExpectedSchema;
export const taskReopenListSchema = taskListExpectedSchema;
export const taskArchiveListSchema = strict({
  expectedListRevision: revision,
  outcome: z.enum(["completed", "abandoned"]),
  archiveReason: z.string().optional(),
});

function mutationTool<T extends z.ZodObject<any>>(
  name: string,
  description: string,
  inputSchema: T,
  command: (args: z.infer<T>) => TaskCommand,
): ToolDefinition<T, ToolTaskResult> {
  return {
    name,
    description,
    category: "core",
    loadPolicy: "core",
    inputSchema,
    risk: "low",
    execute: (args, context) =>
      execute(
        context,
        command(args),
        (result) => `${name} succeeded · list revision ${result.listRevision}`,
      ),
  };
}

export const taskCreateTool = mutationTool(
  "TaskCreate",
  "创建持久化任务。routing 与完成策略必须显式提供。",
  taskCreateSchema,
  (args) => ({ type: "create", ...args }),
);
export const taskUpdateTool = mutationTool(
  "TaskUpdate",
  "原子更新任务内容、状态或依赖；不修改 owner/review。",
  taskUpdateSchema,
  (args) => ({ type: "update", ...args }),
);
export const taskDeleteTool = mutationTool(
  "TaskDelete",
  "删除任务并原子移除双向依赖。",
  taskDeleteSchema,
  (args) => ({ type: "delete", ...args }),
);
export const taskClaimTool = mutationTool(
  "TaskClaim",
  "认领任务；只设置 owner，不改变 status。",
  taskClaimSchema,
  (args) => ({ type: "claim", ...args }),
);
export const taskAssignTool = mutationTool(
  "TaskAssign",
  "由 lead 指派尚未有 owner 的任务。",
  taskAssignSchema,
  (args) => ({ type: "assign", ...args }),
);
export const taskReleaseTool = mutationTool(
  "TaskRelease",
  "释放 owner；不改变 status 或 review。",
  taskReleaseSchema,
  (args) => ({ type: "release", ...args }),
);
export const taskTransferTool = mutationTool(
  "TaskTransfer",
  "由 lead 原子转移 owner。",
  taskTransferSchema,
  (args) => ({ type: "transfer", ...args }),
);
export const taskReviewRequestTool = mutationTool(
  "TaskReviewRequest",
  "owner 请求验收，requestId 用于幂等重放。",
  taskReviewRequestSchema,
  (args) => ({ type: "review_request", ...args }),
);
export const taskReviewApproveTool = mutationTool(
  "TaskReviewApprove",
  "lead 验收通过并原子完成任务。",
  taskReviewApproveSchema,
  (args) => ({ type: "review_approve", ...args }),
);
export const taskReviewRejectTool = mutationTool(
  "TaskReviewReject",
  "lead 拒绝验收并持久化修改要求。",
  taskReviewRejectSchema,
  (args) => ({ type: "review_reject", ...args }),
);
export const taskReopenTool = mutationTool(
  "TaskReopen",
  "由 lead 显式重开 completed 任务。",
  taskReopenSchema,
  (args) => ({ type: "reopen", ...args }),
);
export const taskCloseListTool = mutationTool(
  "TaskCloseList",
  "关闭 task list，停止任务变更。",
  taskCloseListSchema,
  (args) => ({ type: "close_list", ...args }),
);
export const taskReopenListTool = mutationTool(
  "TaskReopenList",
  "重新打开 closed task list。",
  taskReopenListSchema,
  (args) => ({ type: "reopen_list", ...args }),
);
export const taskArchiveListTool = mutationTool(
  "TaskArchiveList",
  "归档 closed task list。",
  taskArchiveListSchema,
  (args) => ({ type: "archive_list", ...args }),
);

export const taskListTool: ToolDefinition<
  typeof taskListSchema,
  {
    tasks: AgentTaskNode[];
    listRevision: number;
    state: "open" | "closed" | "archived";
    summary: string;
  }
> = {
  name: "TaskList",
  description: "读取当前 task list；不产生任何写入或 worker 副作用。",
  category: "core",
  loadPolicy: "core",
  inputSchema: taskListSchema,
  risk: "low",
  execute: async (_args, context) => {
    const snapshot = await store(context).getSnapshot();
    return {
      tasks: snapshot.tasks,
      listRevision: snapshot.listRevision,
      state: snapshot.state,
      summary: formatTaskListSummary(snapshot.tasks),
    };
  },
};

export const taskGetTool: ToolDefinition<
  typeof taskGetSchema,
  Awaited<ReturnType<TaskStore["getDerived"]>>
> = {
  name: "TaskGet",
  description: "读取完整任务及 isBlocked、incompleteBlockedBy、canClaim 派生值。",
  category: "core",
  loadPolicy: "core",
  inputSchema: taskGetSchema,
  risk: "low",
  execute: (args, context) => store(context).getDerived(args.taskId),
};

export const taskTools = [
  taskCreateTool,
  taskUpdateTool,
  taskDeleteTool,
  taskListTool,
  taskGetTool,
  taskClaimTool,
  taskAssignTool,
  taskReleaseTool,
  taskTransferTool,
  taskReopenTool,
  taskReviewRequestTool,
  taskReviewApproveTool,
  taskReviewRejectTool,
  taskCloseListTool,
  taskReopenListTool,
  taskArchiveListTool,
] as const;

export const TASK_TOOL_NAMES = new Set(taskTools.map((tool) => tool.name));

export function taskToolError(error: unknown): { ok: false; code: string; error: string } {
  if (error instanceof TaskStoreError) return { ok: false, code: error.code, error: error.message };
  return {
    ok: false,
    code: "UNKNOWN",
    error: error instanceof Error ? error.message : String(error),
  };
}
