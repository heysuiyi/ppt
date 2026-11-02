import stringWidth from "string-width";
import { escapeDisplayControls } from "../host/safe-display-text.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

export function visibleWidth(text: string): number {
  return stringWidth(escapeDisplayControls(text).replaceAll("\t", "    "));
}

export function truncateTerminalText(text: string, columns: number): string {
  const safe = escapeDisplayControls(text).replaceAll("\t", "    ").replaceAll("\n", " ");
  const budget = Math.max(0, columns);
  if (stringWidth(safe) <= budget) return safe;
  let result = "";
  let width = 0;
  for (const cluster of graphemes(safe)) {
    const size = stringWidth(cluster);
    if (width + size > Math.max(0, budget - 1)) break;
    result += cluster;
    width += size;
  }
  return budget > 0 ? `${result}…` : "";
}

export function wrapTerminalText(text: string, columns: number): string[] {
  const width = Math.max(1, Math.floor(columns));
  const lines: string[] = [];
  for (const source of escapeDisplayControls(text).split("\n")) {
    let line = "";
    let used = 0;
    for (const cluster of graphemes(source)) {
      const value = cluster === "\t" ? " ".repeat(4 - (used % 4)) : cluster;
      const size = stringWidth(value);
      if (used > 0 && used + size > width) {
        lines.push(line);
        line = "";
        used = 0;
      }
      // A terminal too narrow for a single wide grapheme is handled by plain mode.
      line += value;
      used += size;
    }
    lines.push(line);
  }
  return lines;
}
