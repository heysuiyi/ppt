import type { ModelMessage } from "@agent-harness/core/model/model-contract";
import { sameValue } from "@agent-harness/core/protocol-values";
import type { AgentCheckpoint } from "@agent-harness/core/session/session-contract";
import type { HostHistoryEntry } from "./host-contract.js";
import type { StoredHostToolFact } from "./internal/sqlite/tool-display.js";

export interface SessionHistoryBatch {
  readonly revision: number;
  readonly messages: readonly ModelMessage[];
}

/** 展示只信任数据库中已获检查点确认的前缀；不从 inflight 或私有重放补全内容。 */
export function projectSessionHistory(
  batches: readonly SessionHistoryBatch[],
  checkpoints: readonly AgentCheckpoint[],
  toolFacts: readonly StoredHostToolFact[] = [],
): readonly HostHistoryEntry[] {
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

  const factsByMessage = new Map<number, StoredHostToolFact[]>();
  let projectedMessageCount = messages.length;
  for (const fact of toolFacts) {
    const checkpoint = checkpoints.find((entry) => entry.queryId === fact.queryId);
    if (
      !checkpoint ||
      fact.messageIndex < checkpoint.startMessageCount ||
      fact.messageIndex > checkpoint.committed.messages.length ||
      fact.step > checkpoint.committed.step + 1
    )
      continue;
    if (
      [...boundaries].some(
        (boundary) => boundary > checkpoint.startMessageCount && boundary < fact.messageIndex,
      )
    )
      continue;
    const unresolvedAfterStop =
      checkpoint.status !== "running" && checkpoint.status !== "waiting" && fact.dispatched;
    if (!fact.hasCompletion && fact.effects !== "applied" && !unresolvedAfterStop) continue;
    const facts = factsByMessage.get(fact.messageIndex) ?? [];
    facts.push(!fact.hasCompletion && unresolvedAfterStop ? { ...fact, status: "unknown" } : fact);
    factsByMessage.set(fact.messageIndex, facts);
    projectedMessageCount = Math.max(projectedMessageCount, fact.messageIndex + 1);
  }
  const history: HostHistoryEntry[] = [];
  const pendingCalls = new Map<string, number>();
  const appendFact = (fact: StoredHostToolFact): void => {
    pendingCalls.set(fact.callId, history.length);
    history.push({
      role: "tool",
      tool: {
        callId: fact.callId,
        name: fact.name,
        identity: fact.identity,
        step: fact.step,
        result: "missing",
        ...(fact.display ? { display: fact.display } : {}),
        ...(fact.status ? { status: fact.status } : {}),
        ...(fact.effects ? { effects: fact.effects } : {}),
        ...(fact.error ? { error: fact.error } : {}),
      },
    });
  };
  for (let index = 0; index < projectedMessageCount; index++) {
    const message = messages[index];
    const facts = factsByMessage.get(index) ?? [];
    if (!message) {
      for (const fact of facts) appendFact(fact);
      continue;
    }
    // callId 只在本 Query 的待关联调用中有意义；用户消息也阻断缺失检查点的旧范围。
    if (boundaries.has(index) || message.role === "user") pendingCalls.clear();
    if (message.role === "user") {
      // 已取消 Query 的最后工具位置可与下一 Query 起点重合；影响事实不能丢失。
      for (const fact of facts) appendFact(fact);
      pendingCalls.clear();
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
    ) {
      // 未提交助手正文保持隐藏；只允许独立持久化的有界工具事实穿过此边界。
      for (const fact of facts) appendFact(fact);
      continue;
    }
    if (message.role === "assistant") {
      let text = "";
      const flushText = (): void => {
        if (text) history.push({ role: "assistant", text });
        text = "";
      };
      for (const [contentIndex, content] of message.content.entries()) {
        if (content.type === "text") {
          text += content.text;
          continue;
        }
        if (content.type === "reasoning" && !content.text) continue;
        flushText();
        if (content.type === "tool-call") {
          const fact = facts.find(
            (entry) =>
              entry.contentIndex === contentIndex &&
              entry.callId === content.callId &&
              entry.name === content.name,
          );
          if (fact) {
            appendFact(fact);
            continue;
          }
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
