import type { TerminalView } from "./renderer-contract.js";
import { graphemes, truncateTerminalText, visibleWidth } from "./terminal-text.js";

/** OMP 式透明状态带：分段着色，只显示宿主确实提供的数据。 */
export function contextLines(view: TerminalView, columns: number, color = false): string[] {
  if (!view.context || !Number.isFinite(columns) || columns < 1) return [];
  const width = Math.floor(columns);
  const { model, workspace } = view.context;
  // 先按纯文本分配列宽，最后才加样式；不把 ANSI 当作可见字符或再次转义。
  const separator = " › ";
  const brand = "s";
  const modelIcon = "◉ ";
  const folderIcon = "📁 ";
  const chromeWidth = visibleWidth(brand + separator + modelIcon + separator + folderIcon);
  const available = Math.max(0, width - chromeWidth);
  const name = truncateTerminalText(model, Math.max(1, Math.floor(available * 0.65)));
  const pathBudget = Math.max(0, available - visibleWidth(name));
  let tail = truncateTerminalText(workspace, Number.MAX_SAFE_INTEGER);
  if (visibleWidth(tail) > pathBudget) {
    const parts = graphemes(tail);
    let used = 1;
    let start = parts.length;
    while (start > 0 && used + visibleWidth(parts[start - 1]!) <= pathBudget) {
      start -= 1;
      used += visibleWidth(parts[start]!);
    }
    tail = pathBudget > 0 ? `…${parts.slice(start).join("")}` : "";
  }
  const prefix = `${brand}${separator}${modelIcon}${name}`;
  const plain = tail ? `${prefix}${separator}${folderIcon}${tail}` : prefix;
  // 极窄场景由 plain 降级消费，仍保证单行且不输出半个宽字素。
  if (!color || visibleWidth(plain) > width) return [truncateTerminalText(plain, width)];
  const split = Math.max(tail.lastIndexOf("/"), tail.lastIndexOf("\\")) + 1;
  const parent = tail.slice(0, split);
  const leaf = tail.slice(split);
  const content =
    `\x1b[90m${brand}${separator}\x1b[36m${modelIcon}${name}\x1b[39m` +
    (tail
      ? `\x1b[90m${separator}\x1b[33m${folderIcon}\x1b[90m${parent}\x1b[39m\x1b[1m${leaf}\x1b[22;39m`
      : "");
  // 宿主未提供上下文容量/当前用量；不绘制假百分比、未知标签或占位刻度。
  return [content];
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
