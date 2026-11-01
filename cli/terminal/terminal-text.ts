import stringWidth from "string-width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Content protection, not key parsing: only the renderer may emit terminal controls. */
export function sanitizeTerminalText(text: string): string {
  return text.replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => {
      const code = character.codePointAt(0)!;
      if (code === 0x1b) return "\\x1b";
      if (code === 0x07) return "\\a";
      if (code === 0x08) return "\\b";
      if (code === 0x0d) return "\\r";
      return `\\u${code.toString(16).padStart(4, "0")}`;
    },
  );
}

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

export function visibleWidth(text: string): number {
  return stringWidth(sanitizeTerminalText(text).replaceAll("\t", "    "));
}

export function truncateTerminalText(text: string, columns: number): string {
  const safe = sanitizeTerminalText(text).replaceAll("\t", "    ").replaceAll("\n", " ");
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
  for (const source of sanitizeTerminalText(text).split("\n")) {
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

/** Markdown stays literal and copyable; no HTML, links or external escape sequences execute. */
export function markdownLines(text: string, columns: number, viewport = false): string[] {
  const lines: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of sanitizeTerminalText(text).split("\n")) {
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      const marker = opening[1]!;
      if (!fence) fence = { marker: marker[0]!, length: marker.length };
      else if (
        marker[0] === fence.marker &&
        marker.length >= fence.length &&
        /^ {0,3}(?:`+|~+)\s*$/.test(line)
      )
        fence = undefined;
      lines.push(...wrapTerminalText(line, columns));
      continue;
    }
    if (fence && !viewport) {
      // Native soft-wrap retains the exact code line in scrollback, including tabs/spaces.
      lines.push(line);
    } else {
      // Paragraphs, lists, headings and inline code retain their text and Markdown markers.
      lines.push(...wrapTerminalText(line, columns));
    }
  }
  return lines;
}
