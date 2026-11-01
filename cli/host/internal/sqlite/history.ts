import type { ModelMessage } from "@agent-harness/core/model/model-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import { sameValue, snapshot } from "@agent-harness/core/protocol-values";
import type {
  SessionHistoryAppendResult,
  SessionHistoryStore,
} from "@agent-harness/core/session/session-contract";
import type { SqliteConnection } from "./connection.js";
import { prepareHistoryBatches } from "./history-queries.js";
import { assertRevision, nextRevision } from "./revision.js";

export function createSqliteHistoryStore(connection: SqliteConnection): SessionHistoryStore {
  const database = connection.database;
  const historyHead = database.prepare(
    "SELECT revision FROM general_agent_history WHERE thread_id = ?",
  );
  const historyBatches = prepareHistoryBatches(connection);
  const batchReceipt = database.prepare(
    "SELECT revision, payload FROM general_agent_history_batches WHERE thread_id = ? AND batch_id = ?",
  );
  const insertHead = database.prepare(
    "INSERT INTO general_agent_history(thread_id, revision) VALUES (?, 0) ON CONFLICT DO NOTHING",
  );
  const updateHead = database.prepare(
    "UPDATE general_agent_history SET revision = ? WHERE thread_id = ?",
  );
  const insertBatch = database.prepare(
    "INSERT INTO general_agent_history_batches(thread_id, batch_id, revision, payload) VALUES (?, ?, ?, ?)",
  );
  return {
    async read(threadId) {
      // 延迟只读事务令 head 与 batches 共享快照；读取不存在的 Thread 不创建 head。
      return connection.transaction(() => {
        const head = historyHead.get(threadId) as { revision: number } | undefined;
        const messages: ModelMessage[] = [];
        for (const row of historyBatches.all(threadId)) {
          messages.push(...snapshot(JSON.parse(row.payload as string) as ModelMessage[]));
        }
        return { threadId, revision: head?.revision ?? 0, messages };
      }, "read");
    },
    async append(threadId, expectedRevision, messages, batchId) {
      assertRevision(expectedRevision);
      if (!batchId) throw new AgentError("invalid-batch-id", "History batch ID must not be empty.");
      const detached = snapshot(messages);
      const payload = JSON.stringify(detached);
      return connection.transaction<SessionHistoryAppendResult>(() => {
        // 已提交收据先于 revision 比较，保留确认丢失后的原批次幂等语义。
        const receipt = batchReceipt.get(threadId, batchId) as
          | { revision: number; payload: string }
          | undefined;
        if (receipt) {
          if (!sameValue(JSON.parse(receipt.payload), detached)) {
            throw new AgentError(
              "history-batch-conflict",
              "History batch ID was already committed with different messages.",
            );
          }
          return { status: "appended", revision: receipt.revision };
        }
        const head = historyHead.get(threadId) as { revision: number } | undefined;
        const revision = head?.revision ?? 0;
        if (revision !== expectedRevision) return { status: "conflict", currentRevision: revision };
        const next = nextRevision(revision);
        insertHead.run(threadId);
        insertBatch.run(threadId, batchId, next, payload);
        updateHead.run(next, threadId);
        return { status: "appended", revision: next };
      });
    },
  };
}
