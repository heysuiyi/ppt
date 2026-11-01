import type { TerminalDraft } from "./terminal-contract.js";
import { graphemes, sanitizeTerminalText, visibleWidth } from "./terminal-text.js";

export interface ComposerLayout {
  readonly lines: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
  readonly positions: readonly { readonly row: number; readonly column: number }[];
}

/** Layout uses source grapheme boundaries, even when safe text expands a control character. */
export function layoutComposer(draft: TerminalDraft, columns: number): ComposerLayout {
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
  const clusters = graphemes(draft.text);
  const lines: string[] = [];
  const positions: { row: number; column: number }[] = [];
  let line = "";
  let used = 0;

  for (let index = 0; index <= clusters.length; index++) {
    const cluster = clusters[index];
    let value = cluster === "\t" ? " ".repeat(4 - (used % 4)) : sanitizeTerminalText(cluster ?? "");
    let size = visibleWidth(value);
    if (cluster !== "\n" && used > 0 && used + size > width) {
      lines.push(line);
      line = "";
      used = 0;
      if (cluster === "\t") {
        value = "    ";
        size = 4;
      }
    }
    // Never emit an indivisible display cell wider than the available line.
    // The original grapheme remains in the draft and keeps its source boundary.
    if (cluster !== "\n" && size > width) {
      value = "�";
      size = 1;
    }
    positions.push({ row: lines.length, column: used });
    if (cluster === undefined) break;
    if (cluster === "\n") {
      lines.push(line);
      line = "";
      used = 0;
    } else {
      line += value;
      used += size;
    }
  }
  lines.push(line);
  const cursor = Math.max(0, Math.min(clusters.length, Math.trunc(draft.cursor) || 0));
  const position = positions[cursor]!;
  return { lines, cursorRow: position.row, cursorColumn: position.column, positions };
}
