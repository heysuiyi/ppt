import type { ModelMessage } from "@agent-harness/core/model/model-contract";
import type { AgentCheckpoint } from "@agent-harness/core/session/session-contract";
import { type HostSessionBinding, snapshotHostSessionBinding } from "./host-session-binding.js";
import { openSqliteReader } from "./internal/sqlite/connection.js";
import { readToolDisplayFacts } from "./internal/sqlite/tool-display.js";
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
          readToolDisplayFacts(database, binding.agentId, binding.threadId),
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

/** 只读恢复绑定；策略继承仍须通过创建宿主时的完整 binding 校验。 */
export function readSqliteHostBinding(
  filePath: string,
  workspaceRoot: string,
  threadId: string,
): HostSessionBinding | undefined {
  const connection = openSqliteReader(filePath);
  try {
    const row = connection.database
      .prepare("SELECT payload FROM general_agent_host_bindings WHERE thread_id = ?")
      .get(threadId);
    if (!row) return undefined;
    const binding = snapshotHostSessionBinding(JSON.parse(row.payload as string));
    return binding.workspaceRoot === workspaceRoot ? binding : undefined;
  } finally {
    connection.close();
  }
}

/** 宿主恢复边界专用：先匹配持久绑定的目录，再读取权威检查点；不供展示层消费。 */
export function readSqliteHostCheckpoint(
  filePath: string,
  workspaceRoot: string,
  threadId: string,
): AgentCheckpoint | undefined {
  const connection = openSqliteReader(filePath);
  try {
    return connection.transaction(() => {
      const row = connection.database
        .prepare("SELECT payload FROM general_agent_host_bindings WHERE thread_id = ?")
        .get(threadId);
      if (!row) return undefined;
      const binding = snapshotHostSessionBinding(JSON.parse(row.payload as string));
      if (binding.workspaceRoot !== workspaceRoot) return undefined;
      const checkpoint = connection.database
        .prepare(`SELECT payload FROM general_agent_checkpoints
          WHERE agent_id = ? AND thread_id = ? ORDER BY updated_order DESC LIMIT 1`)
        .get(binding.agentId, threadId);
      return checkpoint?.payload
        ? (JSON.parse(checkpoint.payload as string) as AgentCheckpoint)
        : undefined;
    }, "read");
  } finally {
    connection.close();
  }
}
