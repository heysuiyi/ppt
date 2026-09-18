import type { AgentActivityItem } from "@shared/agent-activity";
import {
  formatAgentProgressMessage,
  formatAgentToolActivity,
} from "@shared/agent-activity-display";

export type AgentRunPhase =
  | "submitting"
  | "preparing"
  | "idle"
  | "requesting"
  | "thinking"
  | "tool"
  | "working"
  | "responding"
  | "waiting";

export interface AgentRunPresentation {
  label: string;
  animated: boolean;
  phase: AgentRunPhase;
}

function findLatestActiveItem(items: AgentActivityItem[]): AgentActivityItem | undefined {
  return [...items].reverse().find((item) => {
    if (item.kind === "reasoning") return item.streaming === true;
    if (item.kind === "tool") return item.status === "running";
    if (item.kind === "step") return item.status === "running" || item.status === "typing";
    return false;
  });
}

export function deriveAgentRunPresentation(
  phase: AgentRunPhase,
  items: AgentActivityItem[],
): AgentRunPresentation {
  if (phase === "submitting" || phase === "preparing") {
    return {
      phase,
      label: phase === "submitting" ? "正在提交请求" : "正在准备运行",
      animated: true,
    };
  }
  if (phase === "waiting") {
    return { phase, label: "等待你的确认", animated: false };
  }

  const activeItem = findLatestActiveItem(items);
  if (activeItem?.kind === "tool") {
    return {
      phase: "tool",
      label: formatAgentToolActivity(activeItem.toolName, "running"),
      animated: true,
    };
  }
  if (activeItem?.kind === "step") {
    const label = formatAgentProgressMessage(activeItem.text);
    if (label) return { phase, label, animated: true };
  }
  if (activeItem?.kind === "reasoning") {
    return { phase: "thinking", label: "正在思考页面内容", animated: true };
  }

  switch (phase) {
    case "requesting":
      return { phase, label: "正在理解你的需求", animated: true };
    case "thinking":
      return { phase, label: "正在思考页面内容", animated: true };
    case "tool":
      return { phase, label: "正在处理演示文稿", animated: true };
    case "working":
      return { phase, label: "正在推进演示文稿", animated: true };
    case "responding":
      return { phase, label: "正在组织回复", animated: true };
    case "idle":
      return { phase: "requesting", label: "正在准备工作区", animated: true };
  }
}
