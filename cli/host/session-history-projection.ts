import type { ModelMessage } from "@agent-harness/core/model/model-contract";
import { sameValue } from "@agent-harness/core/protocol-values";
import type { AgentCheckpoint } from "@agent-harness/core/session/session-contract";
import type { TerminalHistoryEntry } from "../terminal/terminal-contract.js";

export interface SessionHistoryBatch {
  readonly revision: number;
  readonly messages: readonly ModelMessage[];
}

/** 展示只信任数据库中已获检查点确认的前缀；不从 inflight 或私有重放补全内容。 */
export function projectSessionHistory(
  batches: readonly SessionHistoryBatch[],
  checkpoints: readonly AgentCheckpoint[],
): readonly TerminalHistoryEntry[] {
  const messages: ModelMessage[] = [];
  const messageCounts = new Map<number, number>([[0, 0]]);
  let revision = 0;
  for (const batch of batches) {
    if (batch.revision !== revision + 1) break;
    for (const message of batch.messages) messages.push(message);
    revision = batch.revision;
    messageCounts.set(revision, messages.length);
  }

  let acknowledgedCount = 0;
  for (const checkpoint of checkpoints) {
    const committed = checkpoint.committed;
    const count = messageCounts.get(committed.historyRevision);
    if (count === undefined || count <= acknowledgedCount || count !== committed.messages.length)
      continue;
    if (committed.messages.every((message, index) => sameValue(message, messages[index])))
      acknowledgedCount = count;
  }

  const boundaries = new Set(checkpoints.map((checkpoint) => checkpoint.startMessageCount));
  const hiddenRanges = checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.status === "running" ||
        checkpoint.status === "waiting" ||
        checkpoint.status === "interrupted",
    )
    .map((checkpoint) => {
      let end = Number.POSITIVE_INFINITY;
      // 未确认 append 同样属于未结束 Query；只有下一 Query 的权威起点能截断范围。
      for (const boundary of boundaries) {
        if (boundary > checkpoint.startMessageCount && boundary < end) end = boundary;
      }
      return { start: checkpoint.startMessageCount, end };
    });

  const history: TerminalHistoryEntry[] = [];
  const pendingCalls = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    // callId 只在本 Query 的待关联调用中有意义；用户消息也阻断缺失检查点的旧范围。
    if (boundaries.has(index) || message.role === "user") pendingCalls.clear();
    if (message.role === "user") {
      const text = message.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\n");
      if (text.length > 0) history.push({ role: "user", text });
      continue;
    }
    if (
      index >= acknowledgedCount ||
      hiddenRanges.some((range) => index >= range.start && index < range.end)
    )
      continue;
    if (message.role === "assistant") {
      let text = "";
      const flushText = (): void => {
        if (text) history.push({ role: "assistant", text });
        text = "";
      };
      for (const content of message.content) {
        if (content.type === "text") {
          text += content.text;
          continue;
        }
        if (content.type === "reasoning" && !content.text) continue;
        flushText();
        if (content.type === "tool-call") {
          pendingCalls.set(content.callId, history.length);
          history.push({
            role: "tool",
            tool: { callId: content.callId, name: content.name, result: "missing" },
          });
        } else if (content.text.length > 0) {
          history.push({
            role: "reasoning",
            text: content.text,
          });
        }
      }
      flushText();
    } else if (message.role === "tool") {
      for (const content of message.content) {
        const position = pendingCalls.get(content.callId);
        if (position === undefined) continue;
        const call = history[position];
        if (call.role === "tool") {
          // recorded 仅表示规范结果存在，不代表工具成功或已确认副作用。
          history[position] = {
            role: "tool",
            tool: { ...call.tool, result: content.isError ? "error" : "recorded" },
          };
        }
        pendingCalls.delete(content.callId);
      }
    }
  }
  return history;
}
