import { markdownLines } from "./terminal-markdown.js";
import { visibleWidth, wrapTerminalText } from "./terminal-text.js";

// 成对设置前景/背景，避免浅色终端沿用深色前景而不可读；每行独立复原，不能染到后续输出。
const userSurface = "\x1b[48;5;235m\x1b[38;5;252m";
const reset = "\x1b[0m";

/** 只改变终端展示，不向规范消息添加角色前缀、缩进或填充。 */
export function userMessageLines(text: string, columns: number, color: boolean): string[] {
  const width = Math.max(1, columns);
  const inset = width >= 5 ? 2 : 0;
  const body = wrapTerminalText(text, Math.max(1, width - inset * 2));
  const blank = color ? `${userSurface}${" ".repeat(width)}${reset}` : "";
  return [
    "",
    blank,
    ...body.map((line) => {
      if (!color) return `${inset ? "│ " : ""}${line}`;
      const left = " ".repeat(inset);
      const right = " ".repeat(Math.max(0, width - inset - visibleWidth(line)));
      return `${userSurface}${left}${line}${right}${reset}`;
    }),
    blank,
  ];
}

/** 流式正文和最终正文保持同一外间距，代码块仍保留原内容及复制语义。 */
export function assistantMessageLines(
  text: string,
  columns: number,
  viewport = false,
  color = false,
): string[] {
  return ["", ...markdownLines(text, columns, viewport, color), ""];
}
