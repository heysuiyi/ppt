import type { ModelMessage } from "@agent-harness/core/model/model-contract";
import type { AgentCheckpoint } from "@agent-harness/core/session/session-contract";
import { snapshotHostSessionBinding } from "./host-session-binding.js";
import { openSqliteReader } from "./internal/sqlite/connection.js";
import { projectSessionHistory } from "./session-history-projection.js";
import type { HostSessionSummary } from "./session-persistence-contract.js";

/** 仅宿主的只读投影；不取得检查点租约，也不将规范历史或重放状态暴露给 CLI。 */
export function readSqliteAgentSessions(
  filePath: string,
  workspaceRoot: string,
): readonly HostSessionSummary[] {
  const connection = openSqliteReader(filePath);
  try {
    const sessions = connection.transaction(() => {
      const database = connection.database;
      const bindings = database.prepare(`
        SELECT binding.payload
        FROM general_agent_host_bindings AS binding
        LEFT JOIN general_agent_checkpoints AS checkpoint
          ON checkpoint.thread_id = binding.thread_id
          AND checkpoint.agent_id = json_extract(binding.payload, '$.agentId')
        WHERE json_extract(binding.payload, '$.workspaceRoot') = ?
        GROUP BY binding.thread_id
        ORDER BY COALESCE(MAX(checkpoint.updated_order), 0) DESC, binding.thread_id
      `);
      const historyBatches = database.prepare(`
        SELECT revision, payload FROM general_agent_history_batches
        WHERE thread_id = ? ORDER BY revision
      `);
      const checkpoints = database.prepare(`
        SELECT payload FROM general_agent_checkpoints
        WHERE agent_id = ? AND thread_id = ?
        ORDER BY updated_order DESC
      `);
      const summaries: HostSessionSummary[] = [];
      for (const row of bindings.all(workspaceRoot)) {
        const binding = snapshotHostSessionBinding(JSON.parse(row.payload as string));
        const authoritative = checkpoints
          .all(binding.agentId, binding.threadId)
          .map((entry) =>
            entry.payload ? (JSON.parse(entry.payload as string) as AgentCheckpoint) : undefined,
          )
          .filter((entry): entry is AgentCheckpoint => entry !== undefined);
        const unfinished = authoritative.filter(
          (entry) =>
            entry.status === "running" ||
            entry.status === "waiting" ||
            entry.status === "interrupted",
        );
        const history = projectSessionHistory(
          historyBatches.all(binding.threadId).map((batch) => ({
            revision: batch.revision as number,
            messages: JSON.parse(batch.payload as string) as readonly ModelMessage[],
          })),
          authoritative,
        );
        const pending = unfinished[0];
        summaries.push({
          threadId: binding.threadId,
          model: binding.model,
          connectionFingerprint: binding.connectionFingerprint,
          toolMode: binding.toolMode,
          history,
          ...(pending
            ? {
                unfinished: {
                  queryId: pending.queryId,
                  status: pending.status as "running" | "waiting" | "interrupted",
                },
              }
            : {}),
        });
      }
      return summaries;
    }, "read");
    connection.close();
    return sessions;
  } catch (error) {
    connection.closeAfterFailure();
    throw error;
  }
}
