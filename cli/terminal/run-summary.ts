import type { TerminalRecord } from "./terminal-contract.js";
import { wrapTerminalText } from "./terminal-text.js";
import { toolCardId } from "./tool-card.js";

/** 仅汇总当前激活观察到的事实；恢复不把前次 Run 的等待时间、请求或账单算进来。 */
export class RunStatistics {
  private readonly steps = new Set<number>();
  private readonly tools = new Set<string>();
  private readonly requests = new Map<
    string,
    Extract<TerminalRecord, { type: "model.completed" }>
  >();

  observe(record: TerminalRecord): void {
    if (record.type === "progress" && record.phase === "step.started") this.steps.add(record.step);
    if (record.type === "tool") this.tools.add(toolCardId(record));
    if (record.type === "model.completed" && !this.requests.has(record.requestId))
      this.requests.set(record.requestId, record);
  }

  lines(columns: number, color: boolean): string[] {
    let input = 0;
    let output = 0;
    let measured = 0;
    let modelDuration = 0;
    for (const request of this.requests.values()) {
      modelDuration += request.durationMs;
      if (!request.usage) continue;
      input += request.usage.inputTokens;
      output += request.usage.outputTokens;
      measured += 1;
    }
    const fields = [
      "本次运行",
      this.requests.size ? `模型用时 ${(modelDuration / 1000).toFixed(1)}s` : "模型耗时未提供",
      `${this.steps.size} 步`,
      `${this.tools.size} 工具`,
      `${this.requests.size} 次模型响应`,
    ];
    if (measured > 0)
      fields.push(
        `${input} 输入 / ${output} 输出 token${measured < this.requests.size ? "（部分请求）" : ""}`,
      );
    else fields.push("token 未提供");
    return wrapTerminalText(fields.join(" · "), columns).map((line) =>
      color ? `\x1b[90m${line}\x1b[0m` : line,
    );
  }
}
