import {
  type OutputBlockRow,
  outputBlockContentWidth,
  outputBlockWidth,
  renderOutputBlock,
  wrapOutputBlockText,
} from "./output-block.js";
import type { TerminalSelectionItem, TerminalToolRecord } from "./terminal-contract.js";
import { sanitizeTerminalText, truncateTerminalText, visibleWidth } from "./terminal-text.js";

export function toolCardId(tool: TerminalToolRecord): string {
  return JSON.stringify([
    tool.invocationIdentity.agentId,
    tool.invocationIdentity.threadId,
    tool.invocationIdentity.queryId,
    tool.invocationIdentity.runId,
    tool.callId,
  ]);
}

function toolOutcome(tool: TerminalToolRecord): string {
  const state =
    tool.phase === "started"
      ? "执行中"
      : tool.status === "succeeded"
        ? "已完成"
        : tool.status === "failed"
          ? "失败"
          : "结果未知";
  const impact =
    tool.phase === "completed"
      ? tool.effects === "applied"
        ? " · 已产生外部影响"
        : tool.effects === "unknown"
          ? " · 外部影响未知"
          : ""
      : "";
  return `${state}${impact}`;
}

export function toolSummary(tool: TerminalToolRecord): string {
  const error =
    tool.phase === "completed" && tool.status !== "succeeded"
      ? ` · ${tool.error.code}: ${tool.error.message}`
      : "";
  const target = tool.display?.title ? ` · ${tool.display.title}` : "";
  return sanitizeTerminalText(`${tool.name}${target} · ${toolOutcome(tool)}${error}`);
}

export interface ToolCardOptions {
  readonly maxRows?: number;
  /** Zero-based; clamped to the available expanded pages. */
  readonly page?: number;
  readonly color?: boolean;
  /** Presentation only: a started invocation whose owning turn has ended. */
  readonly interrupted?: boolean;
}

interface CardSection {
  readonly label: string;
  readonly lines: readonly string[];
}

interface CardLayout {
  readonly header: string;
  readonly fixed: readonly OutputBlockRow[];
  readonly sections: readonly CardSection[];
  readonly hidden: number;
}

const previewLines: Readonly<Record<string, number>> = {
  read: 12,
  glob: 8,
  grep: 6,
  write: 6,
  edit: 40,
};

function content(text: string): OutputBlockRow {
  return { kind: "content", text };
}

function rowBudget(maxRows: number | undefined): number | undefined {
  if (maxRows === undefined || maxRows === Number.POSITIVE_INFINITY) return undefined;
  return Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 0;
}

function cardLayout(
  tool: TerminalToolRecord,
  columns: number,
  expanded: boolean,
  bounded: boolean,
  interrupted: boolean,
): CardLayout {
  const width = outputBlockContentWidth(columns);
  const wrap = (text: string): string[] => wrapOutputBlockText(text, columns);
  const fixed: OutputBlockRow[] = [];
  const sections: CardSection[] = [];
  const section = (label: string, values: readonly string[]): void => {
    if (values.length > 0) sections.push({ label, lines: values.flatMap(wrap) });
  };
  const compact = (text: string): string => {
    if (visibleWidth(text) <= width) return text;
    const hint = width >= 20 ? " · Ctrl+O" : "";
    return `${truncateTerminalText(text, width - visibleWidth(hint))}${hint}`;
  };
  const state = interrupted
    ? "结果及外部影响未知"
    : tool.phase === "started"
      ? "执行中"
      : tool.status === "succeeded"
        ? "已完成"
        : tool.status === "failed"
          ? "失败"
          : "结果未知";
  const identity = `${tool.name} · ${state}`;
  const target = tool.display?.title;
  // Reserve the header's cap, surrounding spaces and both corners.
  const headerWidth = Math.max(0, columns - 6);
  const withTarget = target ? `${identity} · ${target}` : identity;
  const targetInHeader = visibleWidth(withTarget) <= headerWidth;
  const header = targetInHeader
    ? withTarget
    : visibleWidth(identity) <= headerWidth
      ? identity
      : `${state} · ${tool.name}`;
  if (visibleWidth(identity) > headerWidth && expanded) section("Tool", [identity]);
  if (target && !targetInHeader) {
    const lines = wrap(target);
    fixed.push(...(bounded ? [content(compact(target))] : lines.map(content)));
    if (expanded && bounded && lines.length > 1) section("Target", [target]);
  }
  if (interrupted) {
    const warning = "本轮已结束，结果及外部影响未知。";
    fixed.push(
      ...(bounded ? [content(truncateTerminalText(warning, width))] : wrap(warning).map(content)),
    );
    if (expanded && bounded && visibleWidth(warning) > width) section("Status", [warning]);
  }
  if (tool.phase === "completed" && tool.status !== "succeeded") {
    const error = `${tool.error.code}: ${tool.error.message}`;
    fixed.push(...(bounded ? [content(compact(error))] : wrap(error).map(content)));
    if (expanded && bounded && wrap(error).length > 1) section("Error", [error]);
  }
  if (tool.phase === "completed" && (tool.effects === "applied" || tool.effects === "unknown")) {
    const warning =
      tool.effects === "applied"
        ? "已产生外部影响；失败/取消不撤销。"
        : "外部影响未知；不要假定未执行。";
    fixed.push(
      ...(bounded ? [content(truncateTerminalText(warning, width))] : wrap(warning).map(content)),
    );
    if (expanded && bounded && visibleWidth(warning) > width) section("Effects", [warning]);
  }
  const display = tool.display;
  let hidden = 0;
  if (display) {
    if (expanded || tool.phase === "started") section("Input", display.input);
    section("Summary", display.summary ?? []);
    const source = tool.phase === "completed" && tool.status !== "succeeded" ? [] : display.output;
    const limit = expanded ? source.length : (previewLines[tool.name] ?? 12);
    let visible = source.slice(0, limit);
    let omitted = source.slice(limit);
    // Edit's safe projection is old (-) then new (+). Keep both sides useful:
    // the default allowance is per fragment, not all consumed by the old side.
    const newFragment =
      !expanded && tool.name === "edit" && source[0]?.startsWith("- ")
        ? source.findIndex((line) => line.startsWith("+ "))
        : -1;
    if (newFragment > 0) {
      const oldLines = source.slice(0, newFragment);
      const newLines = source.slice(newFragment);
      visible = [
        ...oldLines.slice(0, limit),
        ...(oldLines.length > limit ? ["…"] : []),
        ...newLines.slice(0, limit),
      ];
      omitted = [...oldLines.slice(limit), ...newLines.slice(limit)];
    }
    hidden = omitted.reduce((count, line) => count + wrap(line).length, 0);
    // A failed invocation's error is already shown above; do not add a second
    // "preview unavailable" diagnostic in its otherwise empty output section.
    const empty =
      tool.phase === "started"
        ? interrupted
          ? []
          : ["等待工具完成。"]
        : tool.status === "succeeded"
          ? ["无可展示的安全结果正文。"]
          : [];
    sections.push({ label: "Output", lines: (visible.length > 0 ? visible : empty).flatMap(wrap) });
  } else {
    section("Output", ["无受支持的安全展示信息；不显示原始参数或结果。"]);
  }
  if (expanded) {
    const invocation = tool.invocationIdentity;
    section("Details", [
      `call: ${tool.callId}; version: ${tool.toolVersion ?? "unknown"}`,
      `agent: ${invocation.agentId}; thread: ${invocation.threadId}`,
      `query: ${invocation.queryId}; run: ${invocation.runId}`,
    ]);
  }
  return { header, fixed, sections, hidden };
}

function sectionRows(sections: readonly CardSection[]): OutputBlockRow[] {
  const rows: OutputBlockRow[] = [];
  for (const section of sections) {
    rows.push({ kind: "section", text: section.label }, ...section.lines.map(content));
  }
  return rows;
}

/**
 * Section dividers repeat after page breaks; content rows never repeat or skip.
 * The bottom border itself carries the page footer, so it costs exactly one row.
 */
function expandedPages(layout: CardLayout, maxRows: number | undefined): OutputBlockRow[][] {
  if (maxRows === undefined) return [[...layout.fixed, ...sectionRows(layout.sections)]];
  const capacity = maxRows - 2 - layout.fixed.length;
  if (capacity < 2) return [];
  const pages: OutputBlockRow[][] = [];
  let page: OutputBlockRow[] = [];
  const flush = (): void => {
    pages.push([...layout.fixed, ...page]);
    page = [];
  };
  for (const section of layout.sections) {
    if (section.lines.length === 0) {
      if (page.length === capacity) flush();
      page.push({ kind: "section", text: section.label });
      continue;
    }
    let offset = 0;
    while (offset < section.lines.length) {
      if (capacity - page.length < 2) flush();
      page.push({ kind: "section", text: section.label });
      const count = Math.min(section.lines.length - offset, capacity - page.length);
      for (let index = 0; index < count; index++)
        page.push(content(section.lines[offset + index]!));
      offset += count;
      if (offset < section.lines.length) flush();
    }
  }
  if (page.length > 0 || pages.length === 0) flush();
  return pages;
}

/** Count expanded pages using exactly the same wrapped layout as toolCardLines. */
export function toolCardPageCount(
  tool: TerminalToolRecord,
  columns: number,
  maxRows: number,
): number {
  const width = outputBlockWidth(columns);
  const budget = rowBudget(maxRows);
  if (width < 4 || (budget !== undefined && budget < 4)) return 0;
  return expandedPages(cardLayout(tool, width, true, budget !== undefined, false), budget).length;
}

/**
 * Default previews count source lines (edit: 40 per old/new fragment); summary
 * facts never consume that allowance. Finite maxRows counts every frame,
 * divider, wrapped body and footer row. Expanded pages retain all safe details.
 * An impossible budget produces no partial frame; page indices are zero-based.
 */
export function toolCardLines(
  tool: TerminalToolRecord,
  columns: number,
  expanded: boolean,
  options: ToolCardOptions = {},
): string[] {
  const width = outputBlockWidth(columns);
  const budget = rowBudget(options.maxRows);
  if (width < 4 || (budget !== undefined && budget < 4)) return [];
  const layout = cardLayout(
    tool,
    width,
    expanded,
    budget !== undefined,
    options.interrupted === true,
  );
  let rows: OutputBlockRow[];
  let footer: string | undefined;
  if (expanded) {
    const pages = expandedPages(layout, budget);
    if (pages.length === 0) return [];
    const requested =
      options.page === Number.POSITIVE_INFINITY
        ? pages.length - 1
        : Number.isFinite(options.page)
          ? Math.floor(options.page!)
          : 0;
    const page = Math.max(0, Math.min(pages.length - 1, requested));
    rows = pages[page]!;
    footer = `${page + 1}/${pages.length} · Ctrl+O 翻页 · Escape 收起`;
  } else {
    const detail = sectionRows(layout.sections);
    rows = [...layout.fixed, ...detail];
    let hidden = layout.hidden;
    if (budget !== undefined && rows.length + 2 + (hidden > 0 ? 1 : 0) > budget) {
      const available = budget - 2 - layout.fixed.length;
      if (available < 1) return [];
      const visible = detail.slice(0, Math.max(0, available - 1));
      // A divider without any of its body is not a useful preview.
      while (visible.at(-1)?.kind === "section") visible.pop();
      hidden += detail.slice(visible.length).filter((row) => row.kind === "content").length;
      rows = [...layout.fixed, ...visible];
      if (hidden === 0) hidden = 1;
    }
    if (hidden > 0) {
      const hint = `… ${hidden} 行未显示 · Ctrl+O 展开`;
      // One premeasured footer row is reserved under a finite viewport budget.
      rows.push(
        ...(budget === undefined
          ? wrapOutputBlockText(hint, width).map(content)
          : [content(truncateTerminalText(hint, outputBlockContentWidth(width)))]),
      );
    }
  }
  return renderOutputBlock({
    width,
    header: layout.header,
    rows,
    ...(footer === undefined ? {} : { footer }),
    color: options.color,
    tone:
      options.interrupted || (tool.phase === "completed" && tool.status === "unknown")
        ? "warning"
        : tool.phase === "started"
          ? "running"
          : tool.status === "failed"
            ? "error"
            : "success",
  });
}

export function toolSelection(tool: TerminalToolRecord): TerminalSelectionItem {
  return {
    id: toolCardId(tool),
    label: sanitizeTerminalText(tool.name),
    description: toolSummary(tool),
  };
}
