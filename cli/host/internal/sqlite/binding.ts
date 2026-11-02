import { AgentError } from "@agent-harness/core/protocol-errors";
import { sameValue } from "@agent-harness/core/protocol-values";
import {
  type HostSessionBinding,
  type HostSessionBindingStore,
  snapshotHostSessionBinding,
} from "../../host-session-binding.js";
import type { SqliteConnection } from "./connection.js";
import { nextRevision } from "./revision.js";

export function createSqliteBindingStore(connection: SqliteConnection): HostSessionBindingStore {
  const database = connection.database;
  const bindingRow = database.prepare(
    "SELECT payload FROM general_agent_host_bindings WHERE thread_id = ?",
  );
  const insertBinding = database.prepare(
    "INSERT INTO general_agent_host_bindings(thread_id, payload) VALUES (?, ?)",
  );
  const existingThreadHistory = database.prepare(
    "SELECT 1 FROM general_agent_history WHERE thread_id = ? LIMIT 1",
  );
  const existingThreadCheckpoint = database.prepare(
    "SELECT 1 FROM general_agent_checkpoints WHERE thread_id = ? LIMIT 1",
  );
  const pendingThread = database.prepare(`
    SELECT 1 FROM general_agent_checkpoints WHERE thread_id = ?
      AND (owner_id IS NOT NULL OR status IN ('running', 'waiting', 'interrupted'))
    LIMIT 1
  `);
  const messageCount = database.prepare(`
    SELECT COALESCE(SUM(json_array_length(payload)), 0) AS count
    FROM general_agent_history_batches WHERE thread_id = ?
  `);
  const updateBinding = database.prepare(
    "UPDATE general_agent_host_bindings SET payload = ? WHERE thread_id = ? AND payload = ?",
  );
  function assertIdle(expected: HostSessionBinding): string {
    const row = bindingRow.get(expected.threadId);
    if (
      !row ||
      !sameValue(snapshotHostSessionBinding(JSON.parse(row.payload as string)), expected)
    ) {
      throw new AgentError("HOST_BINDING_CHANGED", "Host session binding has changed.");
    }
    if (pendingThread.get(expected.threadId)) {
      throw new AgentError("HOST_THREAD_PENDING", "会话仍有活动写者或未完成 Query，不能切换模型。");
    }
    return row.payload as string;
  }
  return {
    async read(threadId) {
      connection.assertOpen();
      const row = bindingRow.get(threadId);
      return row
        ? snapshotHostSessionBinding(JSON.parse(row.payload as string) as HostSessionBinding)
        : null;
    },
    async ensure(binding) {
      connection.assertOpen();
      const detached = snapshotHostSessionBinding(binding);
      const payload = JSON.stringify(detached);
      connection.transaction(() => {
        const row = bindingRow.get(detached.threadId);
        if (row) {
          const existing = snapshotHostSessionBinding(
            JSON.parse(row.payload as string) as HostSessionBinding,
          );
          if (!sameValue(existing, detached)) {
            throw new AgentError("HOST_BINDING_CHANGED", "Host session binding has changed.");
          }
          return;
        }
        // 与执行写入共享 BEGIN IMMEDIATE：空历史、任意 Agent 的空/已释放检查点也不得收养。
        if (
          existingThreadHistory.get(detached.threadId) ||
          existingThreadCheckpoint.get(detached.threadId)
        ) {
          throw new AgentError(
            "HOST_BINDING_MISSING",
            "Existing thread state has no host session binding.",
          );
        }
        insertBinding.run(detached.threadId, payload);
      });
      connection.bind(detached);
    },
    async assertIdle(binding) {
      const expected = snapshotHostSessionBinding(binding);
      connection.transaction(() => assertIdle(expected));
    },
    async replaceModel(binding, model) {
      const expected = snapshotHostSessionBinding(binding);
      const next = connection.transaction(() => {
        const payload = assertIdle(expected);
        const count = messageCount.get(expected.threadId)!.count as number;
        const replacement = snapshotHostSessionBinding({
          ...expected,
          schemaVersion: 3,
          model: model.model,
          connectionFingerprint: model.connectionFingerprint,
          maxSteps: model.maxSteps,
          generation: nextRevision(expected.generation ?? 0),
          modelHistoryStart: count,
        });
        const result = updateBinding.run(JSON.stringify(replacement), expected.threadId, payload);
        if (result.changes !== 1) {
          throw new AgentError("HOST_BINDING_CHANGED", "Host session binding has changed.");
        }
        return replacement;
      });
      connection.bind(next);
      return snapshotHostSessionBinding(next);
    },
  };
}
