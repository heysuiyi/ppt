/**
 * Bordered output layout adapted from oh-my-pi's output-block/tool-card/code-cell.
 *
 * MIT License
 *
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { truncateTerminalText, visibleWidth, wrapTerminalText } from "./terminal-text.js";

export type OutputBlockRow =
  | { readonly kind: "content"; readonly text: string }
  | { readonly kind: "section"; readonly text: string };

export interface OutputBlockOptions {
  readonly width: number;
  readonly header: string;
  readonly rows: readonly OutputBlockRow[];
  readonly footer?: string;
  readonly color?: boolean;
  readonly tone?: "running" | "success" | "warning" | "error";
}

export function outputBlockWidth(columns: number): number {
  return Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
}

/** Narrow cards drop padding, never either vertical edge. */
export function outputBlockContentWidth(columns: number): number {
  const width = outputBlockWidth(columns);
  return Math.max(0, width - (width >= 6 ? 4 : 2));
}

/** Width >= 4 leaves room for even a double-width grapheme. */
export function wrapOutputBlockText(text: string, columns: number): string[] {
  return wrapTerminalText(
    text.replaceAll("\t", "    "),
    Math.max(2, outputBlockContentWidth(columns)),
  );
}

/** Rows are already wrapped by the card's shared measurement/pagination pass. */
export function renderOutputBlock(options: OutputBlockOptions): string[] {
  const width = outputBlockWidth(options.width);
  if (width < 4) return [];
  const contentWidth = outputBlockContentWidth(width);
  const pad = width >= 6 ? " " : "";
  const enabled = options.color === true && process.env.NO_COLOR === undefined;
  const code =
    options.tone === "error"
      ? 31
      : options.tone === "warning"
        ? 33
        : options.tone === "running"
          ? 36
          : 90;
  const border = (text: string): string => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  const bar = (left: string, right: string, label = ""): string => {
    const innerWidth = width - 2;
    const cap = "─".repeat(Math.min(2, innerWidth));
    const available = innerWidth - cap.length;
    const text = label && available > 0 ? truncateTerminalText(` ${label} `, available) : "";
    const tail = `${"─".repeat(Math.max(0, available - visibleWidth(text)))}${right}`;
    return border(`${left}${cap}${text}${tail}`);
  };
  const lines = [bar("╭", "╮", options.header)];
  for (const row of options.rows) {
    if (row.kind === "section") {
      lines.push(bar("├", "┤", row.text));
    } else {
      const text = truncateTerminalText(row.text, contentWidth);
      lines.push(
        `${border("│")}${pad}${text}${" ".repeat(Math.max(0, contentWidth - visibleWidth(text)))}${pad}${border("│")}`,
      );
    }
  }
  lines.push(bar("╰", "╯", options.footer));
  return lines;
}
