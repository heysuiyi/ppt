import { basename, resolve } from "node:path";
import type { TerminalView } from "./renderer-contract.js";
import type { TerminalHistoryEntry } from "./terminal-contract.js";
import { sanitizeTerminalText, truncateTerminalText } from "./terminal-text.js";

function titleLabel(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const firstLine = /^[^\r\n\u2028\u2029]*/u.exec(text)?.[0] ?? "";
  const label = sanitizeTerminalText(firstLine).replace(/\s+/gu, " ").trim();
  return label ? truncateTerminalText(label, 80) : undefined;
}

/** CLI 独占窗口标题与运行指示；只接受公开消息，不读取草稿、审批回答或密钥。 */
export class TerminalTitle {
  private topic: string | undefined;
  private previous: string | undefined;
  private claimed = false;
  private closed = false;
  private progressActive: boolean | undefined;

  constructor(
    private readonly enabled: boolean,
    private readonly write: (text: string) => Promise<void>,
  ) {}

  bindSession(history: readonly TerminalHistoryEntry[]): void {
    this.topic = undefined;
    for (const entry of history) {
      if (entry.role === "user") {
        this.user(entry.text);
        if (this.topic) break;
      }
    }
  }

  user(text: string): void {
    if (!this.closed && this.topic === undefined) this.topic = titleLabel(text);
  }

  async update(view: TerminalView | undefined, available = true): Promise<void> {
    if (!this.enabled || this.closed || !view || (!available && !this.claimed)) return;
    const label =
      this.topic ??
      titleLabel(view.context ? basename(resolve(view.context.workspace)) : undefined) ??
      "CLI";
    const attention = Boolean(view.interaction || view.prompt || view.phase === "waiting");
    const separator = attention ? "!" : view.phase === "idle" ? ">" : ":";
    const active =
      !attention &&
      (view.phase === "submitting" ||
        view.phase === "running" ||
        view.phase === "settling" ||
        view.phase === "cancelling");
    const next = `s ${separator} ${label}`;
    if (next === this.previous && active === this.progressActive) return;
    const claim = this.claimed ? "" : "\x1b[22;2t";
    const title = next === this.previous ? "" : `\x1b]0;${next}\x07`;
    const progress =
      active === this.progressActive ? "" : active ? "\x1b]9;4;3\x07" : "\x1b]9;4;0;\x07";
    this.claimed = true;
    // 沿用 OMP 的 OSC 标题栈；静态状态符避免 Windows/ConPTY 的逐帧标题写入。
    await this.write(`${claim}${title}${progress}`);
    this.previous = next;
    this.progressActive = active;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.claimed) {
      // 先清除原生运行指示，再恢复标题；不支持标题栈时至少清除本程序标签。
      await this.write("\x1b]9;4;0;\x07\x1b]0;\x07\x1b[23;2t");
    }
  }
}
