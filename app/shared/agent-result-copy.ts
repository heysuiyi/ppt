import type { Presentation } from "../../src/shared/presentation";
import type { AgentRunResult } from "./ipc";

export type TerminalAgentRunResult = Extract<AgentRunResult, { status: "completed" | "rejected" }>;

function countSlidesMissingSvgVisualSource(presentation: Presentation | undefined): number {
  if (!presentation?.slides) return 0;
  return presentation.slides.filter((slide) => slide.visualSource?.kind !== "svg").length;
}

/**
 * Main and Renderer must project the same durable terminal copy. Keeping this
 * in Shared prevents a late Renderer snapshot from changing result semantics.
 */
export function formatTerminalAgentRunContent(result: TerminalAgentRunResult): string {
  const slidesNeedingDesign =
    result.status === "completed" ? countSlidesMissingSvgVisualSource(result.presentation) : 0;
  if (result.status === "rejected") {
    return "已放弃排版变更提案。";
  }
  return slidesNeedingDesign > 0
    ? `内容草稿已就绪（${slidesNeedingDesign} 页待设计）。`
    : "已成功应用演示文稿更新。";
}

export function mergeApprovalTerminalContent(
  result: TerminalAgentRunResult,
  _waitingContent: string,
): string {
  return formatTerminalAgentRunContent(result);
}

export function mergeWaitingUserRunContent(
  streamedContent: string,
  questionMessage: string,
): string {
  if (!streamedContent) return questionMessage;
  if (!questionMessage || streamedContent.includes(questionMessage)) return streamedContent;
  const separator = streamedContent.endsWith("\n\n")
    ? ""
    : streamedContent.endsWith("\n")
      ? "\n"
      : "\n\n";
  return `${streamedContent}${separator}${questionMessage}`;
}
