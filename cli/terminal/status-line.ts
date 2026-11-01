import type { TerminalView } from "./renderer-contract.js";
import { truncateTerminalText, visibleWidth } from "./terminal-text.js";

export function statusLines(view: TerminalView, columns: number): string[] {
  const context = view.context;
  const phases: Record<TerminalView["phase"], string> = {
    starting: "启动中",
    idle: "就绪",
    running: "执行中",
    settling: "收尾中",
    waiting: "等待确认",
    submitting: "提交中",
    cancelling: "取消中",
    closing: "关闭中",
  };
  const phase = ` · ${phases[view.phase]}`;
  const lines = [
    `${truncateTerminalText(context?.model || "未选择模型", Math.max(0, columns - visibleWidth(phase)))}${phase}`,
  ];
  const state = [context?.modelStatus, view.activity].filter((value): value is string => !!value);
  if (state.length > 0) {
    const budget = Math.max(0, Math.floor((columns - (state.length - 1) * 3) / state.length));
    lines.push(state.map((value) => truncateTerminalText(value, budget)).join(" · "));
  }
  if (context) {
    const workspace = context.workspace.replaceAll("\\", "/").replace(/\/+$/, "");
    const location = columns < 80 ? workspace.split("/").pop() || workspace : workspace;
    const tools = `工具 ${context.capabilities}`;
    const session = `会话 ${context.threadId}`;
    const toolsBudget = Math.min(visibleWidth(tools), Math.floor(columns / 3));
    const sessionBudget = Math.min(visibleWidth(session), Math.floor(columns / 3));
    lines.push(
      [
        truncateTerminalText(location, Math.max(0, columns - toolsBudget - sessionBudget - 6)),
        truncateTerminalText(session, sessionBudget),
        truncateTerminalText(tools, toolsBudget),
      ].join(" · "),
    );
  }
  const hint = view.selector
    ? view.selector.navigation
      ? "←→/Tab 切栏 · ↑↓ 移动 · Enter 选择 · Esc 返回"
      : "↑↓ 选择 · Enter 确认 · Esc 返回"
    : view.prompt
      ? "Enter 确认输入 · Esc 返回"
      : view.interaction || view.phase === "waiting"
        ? "等待明确选择 · Ctrl+C 取消"
        : view.phase === "running"
          ? "Esc 取消 · 草稿保留，不排队"
          : view.phase !== "idle" || !view.composer.submission.enabled
            ? "暂不能发送 · 草稿保留"
            : "Enter 发送 · Alt+Enter 换行 · / 命令";
  if (view.notification) lines.push(truncateTerminalText(view.notification, columns));
  lines.push(truncateTerminalText(hint, columns));
  return lines.map((line) => truncateTerminalText(line, columns));
}
