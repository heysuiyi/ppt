import type { TerminalView } from "./renderer-contract.js";
import { graphemes, truncateTerminalText, visibleWidth } from "./terminal-text.js";

/** 单行状态栏：项目标识、模型、工作目录，随后是上下文刻度。 */
export function contextLines(view: TerminalView, columns: number): string[] {
  if (!view.context) return [];
  const { model, workspace } = view.context;
  const path = workspace.replaceAll("\\", "/").replace(/\/+$/, "");
  // 当前宿主没有上下文容量契约；不可把输出预算或累计 usage 冒充上下文用量。
  const gauge = "—% ── 上下文未知";
  const labelBudget = Math.max(1, columns - visibleWidth(gauge) - 5);
  const name = truncateTerminalText(`π › ${model}`, Math.max(1, Math.floor(labelBudget * 0.55)));
  const budget = Math.max(0, labelBudget - visibleWidth(name) - 3);
  let tail = path;
  if (visibleWidth(path) > budget) {
    const parts = graphemes(path);
    let width = 1;
    let start = parts.length;
    while (start > 0 && width + visibleWidth(parts[start - 1]!) <= budget) {
      start -= 1;
      width += visibleWidth(parts[start]!);
    }
    tail = budget > 0 ? `…${parts.slice(start).join("")}` : "";
  }
  const label = [name, tail].filter(Boolean).join(" › ");
  const line = `${label} ${"─".repeat(Math.max(1, columns - visibleWidth(label) - visibleWidth(gauge) - 2))}${gauge}`;
  return [truncateTerminalText(line, columns)];
}

/** Execution and durable problems are independent of the editor's focus. */
export function activityLines(view: TerminalView, columns: number): string[] {
  const lines: string[] = [];
  if (view.activity) lines.push(view.activity);
  if (view.feedback?.kind === "blocking") lines.push(view.feedback.message);
  const problem = view.context?.modelStatus;
  if (problem && !view.feedback?.message.includes(problem)) lines.push(`模型不可用：${problem}`);
  return lines.filter(Boolean).map((line) => truncateTerminalText(line, columns));
}

/** Feedback and genuinely local instructions live below the editor/completion. */
export function hintLines(view: TerminalView, columns: number): string[] {
  return [view.feedback?.kind !== "blocking" ? view.feedback?.message : undefined, view.input.hint]
    .filter((line): line is string => !!line)
    .map((line) => truncateTerminalText(line, columns));
}

export function statusLines(view: TerminalView, columns: number): string[] {
  return [
    ...activityLines(view, columns),
    ...contextLines(view, columns),
    ...hintLines(view, columns),
  ];
}
