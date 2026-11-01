import type { TerminalView } from "./renderer-contract.js";
import { truncateTerminalText, visibleWidth } from "./terminal-text.js";

export function statusLines(view: TerminalView, columns: number): string[] {
  const context = view.context;
  const phase = ` | ${view.phase}`;
  const state = `${truncateTerminalText(context?.model ?? "model not selected", Math.max(0, columns - visibleWidth(phase)))}${phase}`;
  const details = context
    ? ` | ${context.workspace} | ${context.threadId} | ${context.capabilities}`
    : "";
  const hint =
    view.notification ??
    (view.composer.submission.enabled
      ? "Enter send · Alt+Enter newline · Ctrl+O tools"
      : `Send disabled: ${view.composer.submission.reason} · Ctrl+C cancel/back`);
  const first =
    columns >= 80
      ? state + truncateTerminalText(details, Math.max(0, columns - visibleWidth(state)))
      : state;
  return [first, truncateTerminalText(hint, columns)];
}
