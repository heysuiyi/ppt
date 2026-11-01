import { markdownLines } from "./terminal-markdown.js";
import { truncateTerminalText } from "./terminal-text.js";

export interface ThinkingBlockOptions {
  readonly color: boolean;
  readonly live?: boolean;
  readonly expanded?: boolean;
  readonly maxRows?: number;
  readonly page?: number;
}

/** 公开思考独立于回答；默认收起，显式打开才展示正文，绝不从私有重放补全文字。 */
export function renderThinkingBlock(
  text: string,
  columns: number,
  options: ThinkingBlockOptions,
): { readonly lines: string[]; readonly pages: number } {
  const width = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
  const budget =
    options.maxRows === undefined || !Number.isFinite(options.maxRows)
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.maxRows));
  if (budget < 1 || width < 1) return { lines: [], pages: 1 };
  const color = options.color && process.env.NO_COLOR === undefined;
  const paint = (line: string, italic = false): string =>
    color ? `\x1b[90${italic ? ";3" : ""}m${line}\x1b[0m` : line;
  const label = options.live ? "公开思考 · 预览" : "公开思考";
  if (!options.expanded || budget < 3) {
    return {
      pages: 1,
      lines: [paint(truncateTerminalText(`▸ ${label} · Ctrl+T 展开`, width))],
    };
  }
  const inset = Math.min(2, Math.max(0, width - 2));
  const body = markdownLines(text, Math.max(2, width - inset), true);
  const capacity = Math.max(1, Math.min(18, budget - 2));
  const pages = Math.max(1, Math.ceil(body.length / capacity));
  const page = Math.max(0, Math.min(pages - 1, options.page ?? 0));
  return {
    pages,
    lines: [
      paint(truncateTerminalText(`▾ ${label}`, width)),
      ...body
        .slice(page * capacity, (page + 1) * capacity)
        .map((line) => paint(`${" ".repeat(inset)}${line}`, true)),
      paint(truncateTerminalText(`${page + 1}/${pages} · Ctrl+T 翻页/收起 · Esc 返回`, width)),
    ],
  };
}
