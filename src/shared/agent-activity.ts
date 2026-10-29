import { z } from "zod";
import type { AgentToolActivityState } from "./agent-activity-display";
import { type AgentTaskNode, agentTaskNodeSchema, TASK_LIST_TRACE_ID } from "./agent-task-list";
import type { TeammateProgressEvent } from "./teammate-progress";

export const agentActivityItemSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("response"),
    /** UTF-16 offsets into SessionChatMessage.content. */
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    attemptId: z.string().optional(),
    streaming: z.boolean().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("reasoning"),
    content: z.string(),
    streaming: z.boolean().optional(),
    modelStep: z.number().int().nonnegative().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("tool"),
    toolCallId: z.string(),
    toolName: z.string(),
    status: z.enum(["running", "completed", "failed", "denied", "invalid-input"]),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("step"),
    text: z.string(),
    status: z.enum(["typing", "running", "done"]).optional(),
    /** Ephemeral request presentation; not a durable process record. */
    transient: z.boolean().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("tasklist"),
    tasks: z.array(agentTaskNodeSchema),
    goal: z.string().nullable().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("tool-approval"),
    approvalId: z.string(),
    toolName: z.string(),
    reason: z.string(),
    detail: z.string(),
    status: z.enum(["pending", "approved", "denied"]),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("task"),
    taskId: z.string(),
    /** Stable teammate identity. Optional for activity persisted before team views existed. */
    agentName: z.string().optional(),
    /** TaskList node linked to this activity, when the assignment came from the shared board. */
    taskListId: z.string().optional(),
    /** Reserved for recursive teammate/session trees. */
    parentTaskId: z.string().optional(),
    description: z.string(),
    status: z.enum(["running", "completed", "failed", "interrupted", "cancelled"]),
    steps: z.array(
      z.object({
        id: z.string(),
        type: z.enum(["reasoning", "tool"]),
        text: z.string(),
        toolName: z.string().optional(),
        status: z.enum(["running", "completed", "failed"]),
        streaming: z.boolean().optional(),
      }),
    ),
  }),
]);

export type AgentActivityItem = z.infer<typeof agentActivityItemSchema>;

export function sealResponseBlocks(trace: AgentActivityItem[]): AgentActivityItem[] {
  return trace.map((item) =>
    item.kind === "response" && item.streaming ? { ...item, streaming: false } : item,
  );
}

export function sealAllReasoning(trace: AgentActivityItem[]): AgentActivityItem[] {
  return trace.map((item) =>
    item.kind === "reasoning" && item.streaming ? { ...item, streaming: false } : item,
  );
}

export function finalizeReasoning(trace: AgentActivityItem[]): AgentActivityItem[] {
  const last = trace.at(-1);
  if (last?.kind === "reasoning" && last.streaming) {
    return [...trace.slice(0, -1), { ...last, streaming: false }];
  }
  return trace;
}

export function appendReasoningChunk(
  trace: AgentActivityItem[],
  chunk: string,
  modelStep = 0,
): AgentActivityItem[] {
  const sealed = sealResponseBlocks(trace);
  let matchIndex = -1;
  for (let index = sealed.length - 1; index >= 0; index -= 1) {
    const item = sealed[index]!;
    if (item.kind === "reasoning" && (item.modelStep ?? 0) === modelStep) {
      matchIndex = index;
      break;
    }
  }
  if (matchIndex >= 0) {
    const match = sealed[matchIndex] as Extract<AgentActivityItem, { kind: "reasoning" }>;
    return sealed.map((item, index) => {
      if (index === matchIndex) {
        return {
          ...match,
          content: match.content + chunk,
          streaming: true,
        };
      }
      if (item.kind === "reasoning" && item.streaming) {
        return { ...item, streaming: false };
      }
      return item;
    });
  }
  return [
    ...sealAllReasoning(sealed),
    {
      id: crypto.randomUUID(),
      kind: "reasoning",
      content: chunk,
      streaming: true,
      modelStep,
    },
  ];
}

export function appendResponseChunk(
  trace: AgentActivityItem[],
  contentStart: number,
  chunkLength: number,
  attemptId?: string,
): AgentActivityItem[] {
  if (chunkLength <= 0) return trace;
  const sealed = sealAllReasoning(trace);
  const last = sealed.at(-1);
  const contentEnd = contentStart + chunkLength;
  if (
    last?.kind === "response" &&
    last.streaming &&
    last.end === contentStart &&
    last.attemptId === attemptId
  ) {
    return [...sealed.slice(0, -1), { ...last, end: contentEnd }];
  }
  return [
    ...sealResponseBlocks(sealed),
    {
      id: crypto.randomUUID(),
      kind: "response",
      start: contentStart,
      end: contentEnd,
      ...(attemptId ? { attemptId } : {}),
      streaming: true,
    },
  ];
}

export function commitResponseAttempt(
  trace: AgentActivityItem[],
  attemptId: string,
): AgentActivityItem[] {
  return trace.map((item) =>
    item.kind === "response" && item.attemptId === attemptId && item.streaming
      ? { ...item, streaming: false }
      : item,
  );
}

export function removeResponseAttempt(
  trace: AgentActivityItem[],
  content: string,
  attemptId: string,
): { trace: AgentActivityItem[]; content: string } {
  let nextContent = "";
  const nextTrace: AgentActivityItem[] = [];
  for (const item of trace) {
    if (item.kind !== "response") {
      nextTrace.push(item);
      continue;
    }
    if (item.attemptId === attemptId) continue;
    const blockContent = content.slice(item.start, item.end);
    const start = nextContent.length;
    nextContent += blockContent;
    nextTrace.push({
      ...item,
      start,
      end: nextContent.length,
    });
  }
  return { trace: nextTrace, content: nextContent };
}

export function appendResponseText(
  trace: AgentActivityItem[],
  content: string,
  text: string,
): { trace: AgentActivityItem[]; content: string } {
  if (!text) return { trace, content };
  const start = content.length;
  const nextContent = content + text;
  return {
    content: nextContent,
    trace: [
      ...sealResponseBlocks(sealAllReasoning(trace)),
      {
        id: crypto.randomUUID(),
        kind: "response",
        start,
        end: nextContent.length,
        streaming: false,
      },
    ],
  };
}

export function mergeResponseText(
  trace: AgentActivityItem[],
  content: string,
  nextText: string,
): { trace: AgentActivityItem[]; content: string } {
  if (!nextText || nextText === content) {
    return { trace, content };
  }
  const last = trace.at(-1);
  if (last?.kind === "response" && last.end === content.length) {
    const tail = getResponseBlockContent(last, content);
    if (tail === nextText || tail === `\n${nextText}` || tail === `\n\n${nextText}`) {
      return { trace, content };
    }
  }
  if (nextText.length > content.length && nextText.startsWith(content)) {
    return appendResponseText(trace, content, nextText.slice(content.length));
  }
  const separator = content.endsWith("\n\n")
    ? ""
    : content.endsWith("\n")
      ? "\n"
      : content
        ? "\n\n"
        : "";
  return appendResponseText(trace, content, `${separator}${nextText}`);
}

export function getResponseBlockContent(
  item: Extract<AgentActivityItem, { kind: "response" }>,
  content: string,
): string {
  return content.slice(item.start, item.end);
}

export function appendStep(
  trace: AgentActivityItem[],
  text: string,
  status: "typing" | "running" | "done" = "done",
): AgentActivityItem[] {
  return [
    ...finalizeReasoning(sealResponseBlocks(trace)),
    {
      id: crypto.randomUUID(),
      kind: "step",
      text,
      status,
    },
  ];
}

export function upsertTaskListTrace(
  trace: AgentActivityItem[],
  input: { tasks: AgentTaskNode[]; goal?: string | null },
): AgentActivityItem[] {
  const sealed = finalizeReasoning(sealResponseBlocks(trace));
  const existingIndex = sealed.findIndex((item) => item.kind === "tasklist");
  const nextItem = {
    id: existingIndex >= 0 ? sealed[existingIndex]!.id : TASK_LIST_TRACE_ID,
    kind: "tasklist" as const,
    tasks: input.tasks.map((task) => ({ ...task })),
    goal: input.goal ?? null,
  };

  if (existingIndex >= 0) {
    return sealed.map((item, index) => (index === existingIndex ? nextItem : item));
  }

  return [...sealed, nextItem];
}

export function updateStepText(
  trace: AgentActivityItem[],
  stepId: string,
  text: string,
): AgentActivityItem[] {
  return trace.map((item) =>
    item.id === stepId && item.kind === "step" ? { ...item, text } : item,
  );
}

export function appendToolStart(
  trace: AgentActivityItem[],
  toolCallId: string,
  toolName: string,
): AgentActivityItem[] {
  if (trace.some((item) => item.kind === "tool" && item.toolCallId === toolCallId)) {
    return trace;
  }
  return [
    ...finalizeReasoning(sealResponseBlocks(trace)),
    {
      id: crypto.randomUUID(),
      kind: "tool",
      toolCallId,
      toolName,
      status: "running",
    },
  ];
}

export function appendToolApprovalWaiting(
  trace: AgentActivityItem[],
  input: {
    approvalId: string;
    toolName: string;
    reason: string;
    detail: string;
  },
): AgentActivityItem[] {
  return [
    ...finalizeReasoning(sealResponseBlocks(trace)),
    {
      id: crypto.randomUUID(),
      kind: "tool-approval",
      approvalId: input.approvalId,
      toolName: input.toolName,
      reason: input.reason,
      detail: input.detail,
      status: "pending",
    },
  ];
}

export function resolveToolApprovalItem(
  trace: AgentActivityItem[],
  approvalId: string,
  status: "approved" | "denied",
): AgentActivityItem[] {
  return trace.map((item) =>
    item.kind === "tool-approval" && item.approvalId === approvalId ? { ...item, status } : item,
  );
}

export function finishTool(
  trace: AgentActivityItem[],
  toolCallId: string,
  toolName: string,
  status: Exclude<AgentToolActivityState, "running">,
): AgentActivityItem[] {
  let matchedIndex = -1;
  let terminalIndex = -1;
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const item = trace[index];
    if (item.kind === "tool" && item.toolCallId === toolCallId) {
      if (item.status === "running") {
        matchedIndex = index;
        break;
      }
      if (terminalIndex === -1) terminalIndex = index;
    }
  }

  // The first terminal event wins. Replayed/duplicated starts and finishes are
  // idempotent, and a late start cannot regress a completed tool to running.
  if (terminalIndex !== -1) return trace;

  if (matchedIndex === -1) {
    return [
      ...finalizeReasoning(sealResponseBlocks(trace)),
      {
        id: crypto.randomUUID(),
        kind: "tool",
        toolCallId,
        toolName,
        status,
      },
    ];
  }

  return trace.map((item, index) =>
    index === matchedIndex && item.kind === "tool"
      ? {
          ...item,
          status,
        }
      : item,
  );
}

export function findPendingToolApproval(
  trace: AgentActivityItem[],
): Extract<AgentActivityItem, { kind: "tool-approval" }> | undefined {
  return [...trace]
    .reverse()
    .find(
      (item): item is Extract<AgentActivityItem, { kind: "tool-approval" }> =>
        item.kind === "tool-approval" && item.status === "pending",
    );
}

const MAX_PERSISTED_TRACE_ITEMS = 80;
const MAX_PERSISTED_APPROVAL_ITEMS = 10;
const MAX_PERSISTED_TASK_STEPS = 24;
const MAX_PERSISTED_TASK_LIST_NODES = 60;
const MAX_PERSISTED_TEXT_CHARS = 4_000;
const MAX_PERSISTED_TRACE_BYTES = 96 * 1_024;

function truncatePersistedText(value: string, maxChars = MAX_PERSISTED_TEXT_CHARS): string {
  if (value.length <= maxChars) return value;
  return `…${value.slice(-(maxChars - 1))}`;
}

function compactActivityItem(item: AgentActivityItem): AgentActivityItem {
  if (item.kind === "response") {
    return item;
  }
  if (item.kind === "reasoning") {
    return { ...item, content: truncatePersistedText(item.content) };
  }
  if (item.kind === "step") {
    return { ...item, text: truncatePersistedText(item.text) };
  }
  if (item.kind === "tool") {
    return item;
  }
  if (item.kind === "tool-approval") {
    return {
      ...item,
      reason: truncatePersistedText(item.reason),
      detail: truncatePersistedText(item.detail),
    };
  }
  if (item.kind === "task") {
    return {
      ...item,
      description: truncatePersistedText(item.description),
      steps: item.steps.slice(-MAX_PERSISTED_TASK_STEPS).map((step) => ({
        ...step,
        text: truncatePersistedText(step.text),
      })),
    };
  }
  if (item.kind === "tasklist") {
    return {
      ...item,
      goal: item.goal ? truncatePersistedText(item.goal) : item.goal,
      tasks: item.tasks.slice(-MAX_PERSISTED_TASK_LIST_NODES).map((task) => ({
        ...task,
        subject: truncatePersistedText(task.subject, 1_000),
        description: truncatePersistedText(task.description),
        blockedBy: task.blockedBy.slice(-MAX_PERSISTED_TASK_LIST_NODES),
      })),
    };
  }
  return item;
}

function persistedTraceSize(trace: AgentActivityItem[]): number {
  return new TextEncoder().encode(JSON.stringify(trace)).byteLength;
}

export function compactActivityTraceForPersistence(
  trace: AgentActivityItem[] | undefined,
): AgentActivityItem[] | undefined {
  if (!trace) return undefined;
  if (trace.length === 0) return trace;

  const compacted = trace.map(compactActivityItem);
  const latestTaskList = [...compacted].reverse().find((item) => item.kind === "tasklist");
  const pendingApprovals = compacted
    .filter((item) => item.kind === "tool-approval" && item.status === "pending")
    .slice(-MAX_PERSISTED_APPROVAL_ITEMS);
  const completedApprovalBudget = MAX_PERSISTED_APPROVAL_ITEMS - pendingApprovals.length;
  const completedApprovals =
    completedApprovalBudget > 0
      ? compacted
          .filter((item) => item.kind === "tool-approval" && item.status !== "pending")
          .slice(-completedApprovalBudget)
      : [];
  // Response markers are structural: dropping one would make the remaining
  // content offsets lie about the visual order. Keep them outside the process
  // item budget, then retain the newest process activity around them.
  const responseIds = compacted.filter((item) => item.kind === "response").map((item) => item.id);
  const keptIds = new Set<string>([
    ...responseIds,
    ...(latestTaskList ? [latestTaskList.id] : []),
    ...pendingApprovals.map((item) => item.id),
    ...completedApprovals.map((item) => item.id),
  ]);

  let keptProcessItems = keptIds.size - responseIds.length;
  for (let index = compacted.length - 1; index >= 0; index -= 1) {
    const item = compacted[index]!;
    if (item.kind === "response" || keptIds.has(item.id)) continue;
    if (keptProcessItems >= MAX_PERSISTED_TRACE_ITEMS) break;
    keptIds.add(item.id);
    keptProcessItems += 1;
  }

  const kept = compacted.filter((item) => keptIds.has(item.id));
  const latestProcessItem = [...compacted]
    .reverse()
    .find((item) => item.kind !== "response" && item.kind !== "tasklist");
  const mandatoryIds = new Set<string>([
    ...responseIds,
    ...(latestTaskList ? [latestTaskList.id] : []),
    ...pendingApprovals.slice(-1).map((item) => item.id),
    ...(latestProcessItem ? [latestProcessItem.id] : []),
  ]);
  while (kept.length > 1 && persistedTraceSize(kept) > MAX_PERSISTED_TRACE_BYTES) {
    const removableIndex = kept.findIndex((item) => !mandatoryIds.has(item.id));
    if (removableIndex === -1) break;
    kept.splice(removableIndex, 1);
  }
  return kept;
}

export function extractLatestTaskList(
  ...traces: Array<AgentActivityItem[] | undefined>
): { tasks: AgentTaskNode[]; goal?: string | null } | null {
  for (const trace of traces) {
    if (!trace?.length) continue;
    for (let index = trace.length - 1; index >= 0; index -= 1) {
      const item = trace[index];
      if (item?.kind === "tasklist" && item.tasks.length > 0) {
        return { tasks: item.tasks, goal: item.goal ?? null };
      }
    }
  }
  return null;
}

type TaskStep = Extract<AgentActivityItem, { kind: "task" }>["steps"][number];

function upsertTask(
  trace: AgentActivityItem[],
  taskId: string,
  updater: (
    task: Extract<AgentActivityItem, { kind: "task" }>,
  ) => Extract<AgentActivityItem, { kind: "task" }>,
): AgentActivityItem[] {
  const index = trace.findIndex((item) => item.kind === "task" && item.taskId === taskId);
  if (index < 0) return trace;
  return trace.map((item, i) =>
    i === index ? updater(item as Extract<AgentActivityItem, { kind: "task" }>) : item,
  );
}

export function upsertTaskStarted(
  trace: AgentActivityItem[],
  input: {
    taskId: string;
    description: string;
    agentName?: string;
    taskListId?: string;
    parentTaskId?: string;
  },
): AgentActivityItem[] {
  const existing = trace.find((item) => item.kind === "task" && item.taskId === input.taskId);
  if (existing?.kind === "task") {
    return upsertTask(trace, input.taskId, (task) => ({
      ...task,
      description: input.description,
      ...(input.agentName ? { agentName: input.agentName } : {}),
      ...(input.taskListId ? { taskListId: input.taskListId } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      status: "running",
    }));
  }
  return [
    ...finalizeReasoning(sealResponseBlocks(trace)),
    {
      id: crypto.randomUUID(),
      kind: "task",
      taskId: input.taskId,
      ...(input.agentName ? { agentName: input.agentName } : {}),
      ...(input.taskListId ? { taskListId: input.taskListId } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      description: input.description,
      status: "running",
      steps: [],
    },
  ];
}

export function appendTaskReasoningChunk(
  trace: AgentActivityItem[],
  taskId: string,
  chunk: string,
): AgentActivityItem[] {
  return upsertTask(trace, taskId, (task) => {
    const steps = [...task.steps];
    const last = steps.at(-1);
    if (last?.type === "reasoning" && last.streaming) {
      steps[steps.length - 1] = { ...last, text: last.text + chunk };
    } else {
      steps.push({
        id: crypto.randomUUID(),
        type: "reasoning",
        text: chunk,
        status: "running",
        streaming: true,
      });
    }
    return { ...task, steps };
  });
}

export function appendTaskToolStart(
  trace: AgentActivityItem[],
  taskId: string,
  toolName: string,
  message: string,
): AgentActivityItem[] {
  return upsertTask(trace, taskId, (task) => {
    const steps = task.steps.map(
      (step): TaskStep =>
        step.streaming ? { ...step, streaming: false, status: "completed" } : step,
    );
    steps.push({
      id: crypto.randomUUID(),
      type: "tool",
      text: message,
      toolName,
      status: "running",
    });
    return { ...task, steps };
  });
}

export function finishTaskTool(
  trace: AgentActivityItem[],
  taskId: string,
  toolName: string,
  message: string,
  status: "completed" | "failed",
): AgentActivityItem[] {
  return upsertTask(trace, taskId, (task) => {
    let matched = false;
    const steps = [...task.steps];
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index]!;
      if (step.type === "tool" && step.toolName === toolName && step.status === "running") {
        steps[index] = { ...step, text: message, status };
        matched = true;
        break;
      }
    }
    if (!matched) {
      steps.push({
        id: crypto.randomUUID(),
        type: "tool",
        text: message,
        toolName,
        status,
      });
    }
    return { ...task, steps };
  });
}

export function finishTask(
  trace: AgentActivityItem[],
  taskId: string,
  status: "completed" | "failed" | "interrupted" | "cancelled" = "completed",
): AgentActivityItem[] {
  const unfinishedStepStatus = status === "completed" ? "completed" : "failed";
  return upsertTask(trace, taskId, (task) => ({
    ...task,
    status,
    steps: task.steps.map(
      (step): TaskStep =>
        step.streaming || step.status === "running"
          ? { ...step, streaming: false, status: unfinishedStepStatus }
          : step,
    ),
  }));
}

/** Apply one long-lived teammate event to the nested task activity timeline. */
export function applyTeammateProgressEvent(
  trace: AgentActivityItem[],
  event: TeammateProgressEvent,
): AgentActivityItem[] {
  switch (event.type) {
    case "teammate-assignment-started":
      return upsertTaskStarted(trace, {
        taskId: event.activityId,
        description: event.description,
        agentName: event.teammateName,
        ...(event.taskId ? { taskListId: event.taskId } : {}),
      });
    case "teammate-thinking-chunk":
      return appendTaskReasoningChunk(trace, event.activityId, event.chunk);
    case "teammate-tool-started":
      return appendTaskToolStart(trace, event.activityId, event.toolName, event.message);
    case "teammate-tool-finished":
      return finishTaskTool(trace, event.activityId, event.toolName, event.message, event.status);
    case "teammate-assignment-finished":
      return finishTask(
        trace,
        event.activityId,
        event.status === "interrupted" ? "cancelled" : event.status,
      );
    default:
      return trace;
  }
}

export function markTraceComplete(
  trace: AgentActivityItem[],
  unfinishedToolState: AgentToolActivityState = "failed",
): AgentActivityItem[] {
  return trace.map((item) => {
    if (item.kind === "response") {
      return { ...item, streaming: false };
    }
    if (item.kind === "reasoning") {
      return { ...item, streaming: false };
    }
    if (item.kind === "tool" && item.status === "running") {
      return {
        ...item,
        status: unfinishedToolState,
      };
    }
    if (item.kind === "step" && item.status && item.status !== "done") {
      return { ...item, status: "done" as const };
    }
    if (item.kind === "tool-approval" && item.status === "pending") {
      return { ...item, status: "denied" as const };
    }
    // Teammate assignments may outlive the lead run. Only their explicit
    // assignment-finished event is allowed to close the nested task trace.
    return item;
  });
}

function activityMergeKey(item: AgentActivityItem): string {
  if (item.kind === "response") return `response:${item.id}`;
  if (item.kind === "tool") return `tool:${item.toolCallId}`;
  if (item.kind === "tool-approval") return `approval:${item.approvalId}`;
  if (item.kind === "task") return `task:${item.taskId}`;
  if (item.kind === "tasklist") return "tasklist";
  if (item.kind === "reasoning") return `reasoning:${item.id}`;
  return `${item.kind}:${item.id}`;
}

function mergeActivityItem(
  current: AgentActivityItem,
  incoming: AgentActivityItem,
): AgentActivityItem {
  if (current.kind !== incoming.kind) return incoming;
  if (current.kind === "response" && incoming.kind === "response") {
    return {
      ...incoming,
      start: current.start,
      end: Math.max(current.end, incoming.end),
      streaming: Boolean(current.streaming && incoming.streaming),
    };
  }
  if (current.kind === "tool" && incoming.kind === "tool") {
    if (current.status !== "running" && incoming.status === "running") return current;
    return incoming;
  }
  if (current.kind === "reasoning" && incoming.kind === "reasoning") {
    const content =
      incoming.content.length >= current.content.length ? incoming.content : current.content;
    return {
      ...incoming,
      content,
      streaming: Boolean(current.streaming && incoming.streaming),
    };
  }
  if (current.kind === "step" && incoming.kind === "step") {
    const statusRank = { typing: 0, running: 1, done: 2 } as const;
    const currentStatus = current.status ?? "done";
    const incomingStatus = incoming.status ?? "done";
    return {
      ...incoming,
      status:
        statusRank[currentStatus] > statusRank[incomingStatus] ? currentStatus : incomingStatus,
    };
  }
  if (current.kind === "tool-approval" && incoming.kind === "tool-approval") {
    return current.status !== "pending" && incoming.status === "pending" ? current : incoming;
  }
  return incoming;
}

/** 按稳定活动身份合并快照；后续快照更新内容，但已完成状态不会回退为运行中。 */
export function mergeActivityTraces(
  ...traces: Array<AgentActivityItem[] | undefined>
): AgentActivityItem[] | undefined {
  const valid = traces.filter((trace): trace is AgentActivityItem[] => Boolean(trace?.length));
  if (valid.length === 0) return undefined;
  const merged: AgentActivityItem[] = [];
  const indices = new Map<string, number>();
  for (const trace of valid) {
    for (const item of trace) {
      const key = activityMergeKey(item);
      const index = indices.get(key);
      if (index === undefined) {
        indices.set(key, merged.length);
        merged.push(item);
      } else {
        merged[index] = mergeActivityItem(merged[index]!, item);
      }
    }
  }
  return merged;
}
