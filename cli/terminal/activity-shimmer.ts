/**
 * Activity sweep adapted from oh-my-pi's theme/shimmer.ts and components/loader.ts.
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
import { graphemes, sanitizeTerminalText, visibleWidth } from "./terminal-text.js";

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const accent = "\x1b[38;5;147m";

/** 按经过时间而非输出次数推进；扫光不拆字素，不改变通知文字或显示列数。 */
export function shimmerActivity(text: string, elapsedMs: number): string {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const clusters = graphemes(sanitizeTerminalText(text));
  const width = clusters.reduce((total, cluster) => total + visibleWidth(cluster), 0);
  // OMP classic: 30 列/秒、两端各十列空程、六列半宽的余弦亮度曲线。
  const head = ((elapsed / 1000) * 30) % (width + 20);
  let column = 0;
  let previous = "";
  let result = `${accent}${spinnerFrames[Math.floor(elapsed / 80) % spinnerFrames.length]}\x1b[39m `;
  for (const cluster of clusters) {
    const size = visibleWidth(cluster);
    const distance = Math.abs(column + size / 2 + 10 - head);
    const intensity = distance < 6 ? 0.5 * (1 + Math.cos((Math.PI * distance) / 6)) : 0;
    const color =
      intensity >= 0.65 ? `\x1b[1m${accent}` : intensity >= 0.22 ? "\x1b[37m" : "\x1b[90m";
    if (color !== previous) {
      if (previous) result += "\x1b[22;39m";
      result += color;
      previous = color;
    }
    result += cluster;
    column += size;
  }
  return `${result}\x1b[22;39m`;
}
