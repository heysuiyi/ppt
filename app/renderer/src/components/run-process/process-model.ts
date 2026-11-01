import type { AgentActivityItem } from "@shared/agent-activity";
import {
  type AgentToolDisplayCategory,
  formatAgentProgressMessage,
  formatAgentToolActivity,
  getAgentToolDisplayCopy,
} from "@shared/agent-activity-display";
import type { SessionChatMessage } from "@shared/session";

export interface ProcessRowModel {
  id: string;
  kind: "thought" | "progress" | "tool" | "task" | "approval";
  title: string;
  content?: string;
  lines?: string[];
  active?: boolean;
  streaming?: boolean;
  status?: "running" | "completed" | "failed" | "denied" | "invalid-input";
  toolCategory?: AgentToolDisplayCategory;
}

export interface ProcessView {
  rows: ProcessRowModel[];
  title: string;
  active: boolean;
  attention: boolean;
}

type ProcessOptions = {
  live: boolean;
  hasLaterResponse?: boolean;
  runStatus?: SessionChatMessage["runStatus"];
};

type TimelineSegment =
  | { kind: "process"; id: string; items: AgentActivityItem[] }
  | { kind: "response"; item: Extract<AgentActivityItem, { kind: "response" }> }
  | { kind: "task"; item: Extract<AgentActivityItem, { kind: "task" }> };

/** Boundaries and identity come from the original trace, before presentation filtering. */
export function buildTimelineSegments(items: AgentActivityItem[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let pending: AgentActivityItem[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    segments.push({ kind: "process", id: pending[0]!.id, items: pending });
    pending = [];
  };

  for (const item of items) {
    if (item.kind === "tasklist") continue;
    if (item.kind === "response") {
      flush();
      segments.push({ kind: "response", item });
    } else if (item.kind === "task") {
      flush();
      segments.push({ kind: "task", item });
    } else {
      pending.push(item);
    }
  }
  flush();
  return segments;
}

const CATEGORY_LABELS: Record<AgentToolDisplayCategory, string> = {
  read: "读取",
  search: "搜索",
  inspect: "检查",
  change: "更新",
  coordinate: "协调",
  other: "工具调用",
};

function progressTitle(text: string): string {
  const display = formatAgentProgressMessage(text) ?? "";
  const line = display.split(/\r?\n/, 1)[0] ?? "";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line || "执行进度";
}

/** A single process entrance for reasoning, actions, progress and direct task records. */
export function buildProcessView(items: AgentActivityItem[], options: ProcessOptions): ProcessView {
  const runLive = options.live && (!options.runStatus || options.runStatus === "running");
  let hasLeadItems = false;
  let runningLead = false;
  let runningTask = false;
  let latestLead: AgentActivityItem | undefined;
  for (const item of items) {
    if (item.kind === "task") {
      runningTask ||= item.status === "running";
    } else if (item.kind !== "response" && item.kind !== "tasklist") {
      hasLeadItems = true;
      latestLead = item;
      runningLead ||=
        (item.kind === "tool" && item.status === "running") ||
        (item.kind === "reasoning" && Boolean(item.streaming));
    }
  }
  const active =
    runLive && (runningLead || runningTask || (hasLeadItems && !options.hasLaterResponse));
  const rows: ProcessRowModel[] = [];
  let waiting = false;
  let interruptedTask = false;

  for (const item of items) {
    if (item.kind === "reasoning") {
      if (!item.content.trim()) continue;
      const streaming = runLive && Boolean(item.streaming);
      rows.push({
        id: item.id,
        kind: "thought",
        title: streaming ? "思考中" : "思考片刻",
        content: item.content,
        active: streaming,
        streaming,
      });
    } else if (item.kind === "tool") {
      rows.push({
        id: item.id,
        kind: "tool",
        title: formatAgentToolActivity(item.toolName, item.status),
        active: runLive && item.status === "running",
        status: item.status,
        toolCategory: getAgentToolDisplayCopy(item.toolName).category,
      });
    } else if (item.kind === "step") {
      if (item.transient) continue;
      const content = formatAgentProgressMessage(item.text);
      if (!content) continue;
      rows.push({
        id: item.id,
        kind: "progress",
        title: progressTitle(content),
        content,
        active:
          active && item === latestLead && (item.status === "typing" || item.status === "running"),
        status: item.status === "typing" || item.status === "running" ? "running" : "completed",
      });
    } else if (item.kind === "tool-approval") {
      if (item.status === "pending") {
        waiting = true;
        continue;
      }
      rows.push({
        id: item.id,
        kind: "approval",
        title: `操作授权 · ${getAgentToolDisplayCopy(item.toolName).action}`,
        lines: [
          item.reason,
          item.detail,
          `状态：${item.status === "approved" ? "已允许" : "已拒绝"}`,
        ].filter(Boolean),
        status: item.status === "approved" ? "completed" : "denied",
      });
    } else if (item.kind === "task") {
      // Assignment state belongs to the teammate, never to the lead run's terminal status.
      const taskLive = runLive && item.status === "running";
      interruptedTask ||= item.status === "interrupted" || item.status === "cancelled";
      rows.push({
        id: item.id,
        kind: "task",
        title:
          item.status === "running"
            ? "正在处理任务"
            : item.status === "failed"
              ? "任务执行失败"
              : item.status === "interrupted"
                ? "任务已中断"
                : item.status === "cancelled"
                  ? "任务已取消"
                  : "任务已完成",
        lines: [item.description],
        active: taskLive,
        status:
          item.status === "interrupted" || item.status === "cancelled" ? "denied" : item.status,
      });
      for (const step of item.steps) {
        if (step.type === "reasoning") {
          if (!step.text.trim()) continue;
          const streaming = taskLive && Boolean(step.streaming);
          rows.push({
            id: step.id,
            kind: "thought",
            title: streaming ? "任务分析中" : "任务分析",
            content: step.text,
            active: streaming,
            streaming,
            status: step.status,
          });
        } else {
          rows.push({
            id: step.id,
            kind: "tool",
            title: step.toolName
              ? formatAgentToolActivity(step.toolName, step.status)
              : progressTitle(step.text),
            active: taskLive && step.status === "running",
            status: step.status,
            toolCategory: step.toolName ? getAgentToolDisplayCopy(step.toolName).category : "other",
          });
        }
      }
    }
  }

  const incomplete = rows.filter((row) => row.status === "failed").length;
  const denied = rows.filter((row) => row.status === "denied").length;
  const invalid = rows.filter((row) => row.status === "invalid-input").length;
  const attention =
    waiting ||
    incomplete > 0 ||
    denied > 0 ||
    invalid > 0 ||
    interruptedTask ||
    options.runStatus === "failed" ||
    options.runStatus === "interrupted" ||
    options.runStatus === "waiting";

  // A finished request indicator leaves neither an empty disclosure nor a durable record.
  if (rows.length === 0 && !active) return { rows, title: "", active: false, attention };

  let title = "";
  if (active) {
    let tool: ProcessRowModel | undefined;
    let thought: ProcessRowModel | undefined;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (row.kind === "tool" && row.active && !tool) tool = row;
      if (row.kind === "thought" && row.active && !thought) thought = row;
      if (tool && thought) break;
    }
    if (waiting) title = "等待操作授权";
    else if (tool) title = tool.title;
    else if (thought) title = thought.title;
    else if (latestLead?.kind === "reasoning") title = "思考中";
    else if (
      latestLead?.kind === "step" &&
      (!latestLead.transient || latestLead.status !== "done")
    ) {
      title = progressTitle(latestLead.text);
    } else if (runningTask) title = "正在处理任务";
    else title = "正在处理…";
  } else {
    const counts = new Map<AgentToolDisplayCategory, number>();
    for (const row of rows) {
      if (row.kind !== "tool" || !row.toolCategory) continue;
      counts.set(row.toolCategory, (counts.get(row.toolCategory) ?? 0) + 1);
    }
    // Counts describe calls, not successful actions: failed/denied calls still occurred.
    title = [...counts]
      .map(([category, count]) => `${CATEGORY_LABELS[category]} ${count} 次`)
      .join(" · ");
    if (!title) {
      if (waiting) title = "等待操作授权";
      else if (rows.some((row) => row.kind === "task"))
        title = rows.find((row) => row.kind === "task")!.title;
      else if (rows.some((row) => row.kind === "thought")) title = "思考片刻";
      else title = rows.at(-1)?.title ?? "执行过程";
    }
  }

  const notices: string[] = [];
  if (options.runStatus === "failed") notices.push("运行失败");
  if (options.runStatus === "interrupted") notices.push("运行已中断");
  if (options.runStatus === "waiting") notices.push("等待你的确认");
  if (incomplete > 0) notices.push(`${incomplete} 项未完成`);
  if (denied > 0) notices.push(`${denied} 项已拒绝或取消`);
  if (invalid > 0) notices.push(`${invalid} 项未执行`);
  if (waiting && title !== "等待操作授权") notices.push("等待操作授权");
  if (notices.length > 0) title += ` · ${notices.join(" · ")}`;
  return { rows, title, active, attention };
}
