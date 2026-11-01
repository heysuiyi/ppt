import { graphemes, sanitizeTerminalText, visibleWidth } from "./terminal-text.js";

/** 只移动前景高亮，不拆字素、不修改文字或显示列数。 */
export function shimmerActivity(text: string, frame: number): string {
  const clusters = graphemes(sanitizeTerminalText(text));
  const width = clusters.reduce((total, cluster) => total + visibleWidth(cluster), 0);
  const head = (frame % (width + 6)) - 3;
  let column = 0;
  let previous = 0;
  let result = "";
  for (const cluster of clusters) {
    const size = visibleWidth(cluster);
    const distance = Math.abs(column + size / 2 - head);
    const color = distance < 1.5 ? 96 : distance < 3.5 ? 36 : 90;
    if (color !== previous) {
      result += `\x1b[${color}m`;
      previous = color;
    }
    result += cluster;
    column += size;
  }
  return `${result}\x1b[39m`;
}
