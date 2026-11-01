import type { TerminalView } from "./renderer-contract.js";
import { truncateTerminalText, visibleWidth } from "./terminal-text.js";

/** 输入归属、提交条件及按键说明只由控制器提供。 */
export function statusLines(view: TerminalView, columns: number): string[] {
  const lines = [view.input.status];
  if (view.feedback) lines.push(view.feedback.message);
  if (view.context?.modelStatus) lines.push(view.context.modelStatus);
  if (view.context) {
    const { model, capabilities } = view.context;
    const workspace = view.context.workspace.replaceAll("\\", "/").replace(/\/+$/, "");
    const location = columns < 80 ? workspace.split("/").at(-1) || workspace : workspace;
    const mode =
      capabilities === "read-only"
        ? "只读"
        : capabilities === "read-write"
          ? "读写"
          : capabilities === "none"
            ? "无"
            : capabilities;
    const tools = truncateTerminalText(`工具 ${mode}`, Math.floor(columns / 3));
    const name = truncateTerminalText(model, Math.max(0, Math.floor(columns / 2) - 3));
    const path = truncateTerminalText(
      location,
      Math.max(0, columns - visibleWidth(name) - visibleWidth(tools) - 6),
    );
    lines.push([name, tools, path].filter(Boolean).join(" · "));
  }
  lines.push(view.input.hint);
  return lines.map((line) => truncateTerminalText(line, columns));
}
