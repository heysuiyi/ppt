import {
  type OutputBlockRow,
  outputBlockContentWidth,
  outputBlockWidth,
  renderOutputBlock,
  wrapOutputBlockText,
} from "./output-block.js";
import type { TerminalToolRecord } from "./terminal-contract.js";
import { sanitizeTerminalText, truncateTerminalText, visibleWidth } from "./terminal-text.js";

function stringLines(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((line) => typeof line === "string");
}

/** Only the installed file tool's versioned, host-whitelisted display is eligible. */
export function canGroupRead(tool: TerminalToolRecord): boolean {
  // The file plugin registers `read`, not its result payload type `tools.read`.
  if (tool.name !== "read" || tool.toolVersion !== "1") return false;
  const display = tool.display;
  return (
    display !== undefined &&
    display !== null &&
    typeof display.title === "string" &&
    display.title.trim().length > 0 &&
    stringLines(display.input) &&
    stringLines(display.output) &&
    (display.summary === undefined || stringLines(display.summary))
  );
}

/**
 * Compact presentation only; invocation storage and individual tool selection
 * remain the renderer's responsibility. Never fall back to raw input or output.
 * Impossible budgets return no frame, rather than cutting a border or warning.
 */
export function readToolGroupLines(
  tools: readonly TerminalToolRecord[],
  columns: number,
  options: { readonly color: boolean; readonly maxRows?: number },
): string[] {
  const width = outputBlockWidth(columns);
  const budget =
    options.maxRows === undefined || !Number.isFinite(options.maxRows)
      ? undefined
      : Math.max(0, Math.floor(options.maxRows));
  if (width < 4 || (budget !== undefined && budget < 4)) return [];
  // Reject the entire group, not just unsupported members: no calls disappear.
  if (tools.length === 0 || !tools.every(canGroupRead)) return [];

  let running = 0;
  let completed = 0;
  let failed = 0;
  let unknown = 0;
  let applied = 0;
  let uncertain = 0;
  for (const tool of tools) {
    if (tool.phase === "started") {
      running += 1;
      continue;
    }
    if (tool.status === "succeeded") completed += 1;
    else if (tool.status === "failed") failed += 1;
    else unknown += 1;
    if (tool.effects === "applied") applied += 1;
    else if (tool.effects === "unknown") uncertain += 1;
  }

  const content = (text: string): OutputBlockRow => ({ kind: "content", text });
  const wrap = (text: string): OutputBlockRow[] => wrapOutputBlockText(text, width).map(content);
  // Counts cover every invocation, including targets omitted from the preview.
  const counts = [
    ...(failed > 0 ? [`失败 ${failed}`] : []),
    ...(unknown > 0 ? [`结果未知 ${unknown}`] : []),
    ...(running > 0 ? [`执行中 ${running}`] : []),
    ...(completed > 0 ? [`已完成 ${completed}`] : []),
  ];
  const summary = wrap(counts.join(" · "));
  const effects = [
    ...(applied > 0 ? [`已产生外部影响 ${applied}`] : []),
    ...(uncertain > 0 ? [`外部影响未知 ${uncertain}`] : []),
  ];
  if (effects.length > 0) summary.push(...wrap(effects.join(" · ")));
  const hints = [...wrap("Ctrl+O 查看最新工具"), ...wrap("/tools-output 逐个选择")];
  const available =
    budget === undefined ? Number.POSITIVE_INFINITY : budget - 2 - summary.length - hints.length;
  const candidates: { readonly required: boolean; readonly rows: readonly OutputBlockRow[] }[] = [];
  const contentWidth = outputBlockContentWidth(width);
  let targetRows = 0;
  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index]!;
    const risky =
      tool.phase === "completed" && (tool.status !== "succeeded" || tool.effects !== "none");
    if (index < tools.length - 3 && !risky) continue;
    // The ordinal keeps repeated and similarly truncated targets distinguishable.
    // Only display.title is read; error messages, raw arguments and results are not.
    const target = sanitizeTerminalText(tool.display!.title)
      .replaceAll("\n", "\\n")
      .replaceAll("\t", "    ");
    const status =
      tool.phase === "started"
        ? "执行中"
        : tool.status === "succeeded"
          ? "已完成"
          : tool.status === "failed"
            ? "失败"
            : "结果未知";
    const effects =
      tool.phase !== "completed" || tool.effects === "none"
        ? ""
        : tool.effects === "applied"
          ? " · 已产生外部影响"
          : " · 外部影响未知";
    const facts = `#${index + 1} ${status}${effects}`;
    // Facts never get truncated, even at narrow widths. Targets have a stable
    // ordinal when their safe title has to be shortened.
    const targetWidth = Math.max(0, contentWidth - visibleWidth(facts) - 3);
    const text =
      targetWidth > 0 ? `${facts} · ${truncateTerminalText(target, targetWidth)}` : facts;
    const lines = wrap(text);
    candidates.push({ required: risky || index === tools.length - 1, rows: lines });
    targetRows += lines.length;
  }
  // Never hide an individual failed/uncertain outcome or applied/unknown effect
  // behind a successful aggregate. Remove ordinary preview targets first.
  for (let index = 0; index < candidates.length && targetRows > available; ) {
    if (candidates[index]!.required) {
      index += 1;
      continue;
    }
    targetRows -= candidates[index]!.rows.length;
    candidates.splice(index, 1);
  }
  if (candidates.length === 0 || targetRows > available) return [];
  const rows = [...summary, ...candidates.flatMap((candidate) => candidate.rows), ...hints];
  const hidden = tools.length - candidates.length;
  return renderOutputBlock({
    width,
    header: `读取 ${tools.length} 项`,
    rows,
    ...(hidden > 0 ? { footer: `${hidden} 个目标未展开` } : {}),
    color: options.color,
    tone:
      failed > 0
        ? "error"
        : unknown > 0 || applied > 0 || uncertain > 0
          ? "warning"
          : running > 0
            ? "running"
            : "success",
  });
}
