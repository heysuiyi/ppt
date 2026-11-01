import { composerContentWidth, layoutComposer } from "./composer-layout.js";
import type { TerminalDraft } from "./terminal-contract.js";
import { truncateTerminalText, visibleWidth } from "./terminal-text.js";

export interface ComposerFrameOptions {
  readonly maxRows: number;
  readonly color: boolean;
  readonly secret: boolean;
}

export interface ComposerFrame {
  readonly lines: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
}

/** The frame is presentation only: cursor positions always come from the shared draft layout. */
export function renderComposerFrame(
  draft: TerminalDraft,
  columns: number,
  options: ComposerFrameOptions,
): ComposerFrame {
  const width = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  const maxRows = Number.isFinite(options.maxRows) ? Math.max(0, Math.floor(options.maxRows)) : 0;
  // Do not even measure secret input; neither its length nor its line breaks may affect the frame.
  const visibleDraft = options.secret ? { text: "", cursor: 0 } : draft;
  const band = width >= 8;
  const contentWidth = band ? composerContentWidth(width) : Math.max(1, width - 1);
  const layout = layoutComposer(visibleDraft, contentWidth);
  const bodyRows = Math.min(
    layout.lines.length,
    band ? Math.min(6, maxRows - (layout.lines.length > Math.min(6, maxRows) ? 1 : 0)) : maxRows,
  );
  if (bodyRows <= 0 || width === 0) return { lines: [], cursorRow: 0, cursorColumn: 0 };

  // A stateless caret-centred viewport keeps both nearby context and the active row visible.
  const start = Math.max(
    0,
    Math.min(layout.cursorRow - Math.floor((bodyRows - 1) / 2), layout.lines.length - bodyRows),
  );
  const body = layout.lines.slice(start, start + bodyRows);

  if (!band) {
    return {
      lines: body,
      cursorRow: layout.cursorRow - start,
      cursorColumn: Math.min(width - 1, layout.cursorColumn),
    };
  }

  const hiddenBelow = layout.lines.length - start - bodyRows;
  const overflow: string[] = [];
  if (start > 0) overflow.push(`↑ ${start}`);
  if (hiddenBelow > 0) overflow.push(`↓ ${hiddenBelow}`);
  return {
    lines: [
      ...body.map((text, index) => {
        const line = `${index === 0 ? "╰─ " : "   "}${text}`;
        return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
      }),
      // 只有滚动时才添加隐藏行提示；不绘制底框或空输入占位提示。
      ...(overflow.length > 0
        ? [
            options.color && process.env.NO_COLOR === undefined
              ? `\x1b[90m${truncateTerminalText(overflow.join(" · "), width)}\x1b[39m`
              : truncateTerminalText(overflow.join(" · "), width),
          ]
        : []),
    ],
    cursorRow: layout.cursorRow - start,
    // OMP band 的三列曲线 gutter，正文另保留行末光标格。
    cursorColumn: 3 + layout.cursorColumn,
  };
}
