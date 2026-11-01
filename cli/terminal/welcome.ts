import { truncateTerminalText, visibleWidth, wrapTerminalText } from "./terminal-text.js";

/** One welcome block belongs to the bound empty session and retires into scrollback on send. */
export function welcomeLines(columns: number, rows: number, color: boolean): readonly string[] {
  if (rows < 1) return [];
  const width = Math.max(1, columns);
  const brand =
    width >= 52 && rows >= 5
      ? ["▄▀█ █ █    AGENT HARNESS", "█▀█ █▀█    通用 Agent 终端"]
      : ["AGENT HARNESS"];
  const tips = wrapTerminalText("使用 /help 查看命令。", Math.max(1, Math.min(60, width - 4)));
  const gap = rows >= brand.length + tips.length + 1 ? [""] : [];
  const content = [...brand, ...gap, ...tips].slice(0, rows);
  const top = Math.floor((rows - content.length) / 2);
  const lines = Array.from({ length: top }, () => "");
  for (const [index, line] of content.entries()) {
    if (!line) {
      lines.push("");
      continue;
    }
    const text = truncateTerminalText(line, width);
    const padding = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2)));
    const styled =
      color && index < brand.length ? `\x1b[1;${index === 0 ? 35 : 36}m${text}\x1b[0m` : text;
    lines.push(padding + styled);
  }
  while (lines.length < rows) lines.push("");
  return lines;
}
