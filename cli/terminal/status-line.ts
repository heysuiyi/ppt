import type { TerminalView } from "./renderer-contract.js";
import { truncateTerminalText, visibleWidth } from "./terminal-text.js";

/** 输入归属、提交条件及按键说明只由控制器提供。 */
export function statusLines(view: TerminalView, columns: number): string[] {
  const context = view.context;
  let main = view.input.status;
  if (context) {
    const workspace = context.workspace.replaceAll("\\", "/").replace(/\/+$/, "");
    const location = columns < 80 ? workspace.split("/").at(-1) || workspace : workspace;
    const mode =
      context.capabilities === "read-only"
        ? "只读"
        : context.capabilities === "read-write"
          ? "读写"
          : context.capabilities === "none"
            ? "无"
            : context.capabilities;
    const tools = truncateTerminalText(`工具 ${mode}`, Math.floor(columns / 3));
    // 先缩工作区和模型名；切换、取消等真实状态优先于元数据。
    const status = truncateTerminalText(
      view.input.status,
      Math.max(0, columns - visibleWidth(tools) - 3),
    );
    const remaining = Math.max(0, columns - visibleWidth(status) - visibleWidth(tools) - 9);
    const pathBudget = Math.min(visibleWidth(location), Math.max(4, Math.floor(remaining / 3)));
    const name = truncateTerminalText(context.model, Math.max(0, remaining - pathBudget));
    const path = truncateTerminalText(location, Math.max(0, remaining - visibleWidth(name)));
    main = [status, name, tools, path].filter(Boolean).join(" · ");
  }
  const feedback = view.feedback;
  const modelProblem = context?.modelStatus;
  const problems: string[] = [];
  if (feedback?.kind === "blocking") problems.push(feedback.message);
  else if (feedback) main = `${feedback.message} · ${main}`;
  if (modelProblem && !feedback?.message.includes(modelProblem))
    problems.push(`模型不可用：${modelProblem}`);
  // 两个独立问题占用主行和问题行，仍为返回操作保留尾行。
  if (problems.length > 1) main = `${problems.pop()} · ${main}`;
  const lines = [main, ...problems];
  lines.push(view.input.hint);
  return lines.map((line) => truncateTerminalText(line, columns));
}
