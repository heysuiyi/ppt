/**
 * Slash completion layout adapted from oh-my-pi's SelectList, getMenuWindow
 * and scrollbarThumbRange (packages/tui/src/components/).
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
import type { TerminalSelectorView } from "./renderer-contract.js";
import {
  sanitizeTerminalText,
  truncateTerminalText,
  visibleWidth,
  wrapTerminalText,
} from "./terminal-text.js";

interface CompletionRow {
  readonly text: string;
  readonly primaryLength: number;
}

/** 仅负责补全展示；选择、过滤、接受与执行继续归唯一 controller。 */
export function renderCommandCompletions(
  selector: TerminalSelectorView,
  columns: number,
  maxRows: number,
  color: boolean,
): readonly string[] {
  const width = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  const budget = Number.isFinite(maxRows) ? Math.max(0, Math.min(10, Math.floor(maxRows))) : 0;
  if (budget === 0 || width === 0 || selector.items.length === 0) return [];
  const style = (text: string, selected: boolean): string =>
    color ? `\x1b[${selected ? "36" : "90"}m${text}\x1b[39m` : text;
  const selected = Math.max(
    0,
    selector.items.findIndex((item) => item.id === selector.selectedId),
  );
  const primaryWidth = Math.max(
    12,
    Math.min(
      32,
      selector.items.reduce((widest, item) => Math.max(widest, visibleWidth(item.label) + 2), 0),
    ),
  );
  const renderItems = (rowWidth: number): CompletionRow[][] =>
    selector.items.map((item, index) => {
      const prefix = index === selected ? "› " : "  ";
      const description = sanitizeTerminalText(item.description ?? "")
        .replace(/\s+/gu, " ")
        .trim();
      const columnWidth = Math.max(1, Math.min(primaryWidth, rowWidth - 6));
      const descriptionStart = 2 + columnWidth;
      const descriptionWidth = rowWidth - descriptionStart - 2;
      if (!description || rowWidth <= 40 || descriptionWidth <= 10) {
        const text = prefix + truncateTerminalText(item.label, Math.max(0, rowWidth - 4));
        return [{ text, primaryLength: text.length }];
      }
      const label = truncateTerminalText(item.label, Math.max(1, columnWidth - 2));
      const spacing = " ".repeat(columnWidth - visibleWidth(label));
      const wrapped = wrapTerminalText(description, descriptionWidth);
      const rows = wrapped.slice(0, 2);
      if (wrapped.length > 2) rows[1] = truncateTerminalText(`${rows[1]} …`, descriptionWidth);
      return rows.map((text, row) => ({
        text:
          row === 0
            ? `${prefix}${label}${spacing}${text}`
            : `${" ".repeat(descriptionStart)}${text}`,
        primaryLength: row === 0 ? prefix.length + label.length : 0,
      }));
    });
  // 与 OMP 一样，先按可能出现滚动条的保守宽度计量视觉行数。
  let items = renderItems(Math.max(0, width - 1));
  let totalRows = items.reduce((total, item) => total + item.length, 0);
  const overflow = totalRows > budget;
  if (!overflow) {
    items = renderItems(width);
    totalRows = items.reduce((total, item) => total + item.length, 0);
  }
  const targetBefore = Math.floor(
    Math.max(0, budget - Math.min(items[selected]!.length, budget)) / 2,
  );
  let start = selected;
  let before = 0;
  while (start > 0 && before + items[start - 1]!.length <= targetBefore) {
    start -= 1;
    before += items[start]!.length;
  }
  let end = selected + 1;
  let used = before + items[selected]!.length;
  while (end < items.length && used + items[end]!.length <= budget) used += items[end++]!.length;
  while (start > 0 && used + items[start - 1]!.length <= budget) used += items[--start]!.length;
  let offset = 0;
  for (let index = 0; index < start; index += 1) offset += items[index]!.length;
  const height = Math.min(used, budget);
  const thumbSize = Math.max(1, Math.floor((height * height) / totalRows));
  const thumbStart = overflow
    ? Math.round(
        (Math.min(offset, totalRows - height) / (totalRows - height)) * (height - thumbSize),
      )
    : 0;
  let row = 0;
  const lines: string[] = [];
  for (let index = start; index < end && row < budget; index += 1) {
    for (const { text, primaryLength } of items[index]!) {
      if (row >= budget) break;
      // 非选中命令保留默认前景，只有说明低对比；字符串切片只按生成时的边界。
      const content =
        index === selected
          ? style(text, true)
          : text.slice(0, primaryLength) + style(text.slice(primaryLength), false);
      const scrollbar = overflow
        ? " ".repeat(Math.max(0, width - 1 - visibleWidth(text))) +
          style(
            row >= thumbStart && row < thumbStart + thumbSize ? "█" : "│",
            row >= thumbStart && row < thumbStart + thumbSize,
          )
        : "";
      lines.push(content + scrollbar);
      row += 1;
    }
  }
  return lines;
}
