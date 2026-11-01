import { AgentError } from "@agent-harness/core/protocol-errors";
import { sameValue } from "@agent-harness/core/protocol-values";
import {
  type HostSessionBinding,
  type HostSessionBindingStore,
  snapshotHostSessionBinding,
} from "../../host-session-binding.js";
import type { SqliteConnection } from "./connection.js";

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
    },
  };
}
