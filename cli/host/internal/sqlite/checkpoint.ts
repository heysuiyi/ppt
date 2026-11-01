import { AgentError } from "@agent-harness/core/protocol-errors";
import { snapshot } from "@agent-harness/core/protocol-values";
import type {
  CheckpointAcquireResult,
  CheckpointKey,
  CheckpointLease,
  CheckpointSaveResult,
  CheckpointStore,
} from "@agent-harness/core/session/checkpoint-contract";
import type { AgentCheckpoint } from "@agent-harness/core/session/session-contract";
import type { SqliteConnection } from "./connection.js";
import { assertRevision, nextRevision } from "./revision.js";

interface CheckpointRow {
  owner_id: string | null;
  generation: number;
  revision: number;
  payload: string | null;
}

function sameKey(left: CheckpointKey, right: CheckpointKey): boolean {
  return (
    left.agentId === right.agentId &&
    left.threadId === right.threadId &&
    left.queryId === right.queryId
  );
}

function matches(row: CheckpointRow | undefined, lease: CheckpointLease): row is CheckpointRow {
  return (
    row !== undefined &&
    row.owner_id !== null &&
    row.owner_id === lease.ownerId &&
    row.generation === lease.generation
  );
}

export function createSqliteCheckpointStore(connection: SqliteConnection): CheckpointStore {
  const database = connection.database;
  const checkpointRow = database.prepare(
    "SELECT owner_id, generation, revision, payload FROM general_agent_checkpoints WHERE agent_id = ? AND thread_id = ? AND query_id = ?",
  );
  const insertCheckpoint = database.prepare(
    "INSERT INTO general_agent_checkpoints(agent_id, thread_id, query_id, owner_id, generation, revision) VALUES (?, ?, ?, ?, 1, 0)",
  );
  const acquireCheckpoint = database.prepare(
    "UPDATE general_agent_checkpoints SET owner_id = ?, generation = ? WHERE agent_id = ? AND thread_id = ? AND query_id = ?",
  );
  const saveCheckpoint = database.prepare(`
    UPDATE general_agent_checkpoints SET revision = ?, payload = ?, status = ?,
      updated_order = (SELECT COALESCE(MAX(updated_order), 0) + 1 FROM general_agent_checkpoints)
    WHERE agent_id = ? AND thread_id = ? AND query_id = ?
  `);
  const releaseCheckpoint = database.prepare(
    "UPDATE general_agent_checkpoints SET owner_id = NULL WHERE agent_id = ? AND thread_id = ? AND query_id = ? AND owner_id = ? AND generation = ?",
  );
  const unfinished = database.prepare(`
    SELECT payload FROM general_agent_checkpoints
    WHERE agent_id = ? AND thread_id = ? AND status IN ('running', 'waiting', 'interrupted')
    ORDER BY updated_order DESC LIMIT 1
  `);
  const pendingThreadQuery = database.prepare(`
    SELECT query_id FROM general_agent_checkpoints
    WHERE agent_id = ? AND thread_id = ? AND query_id <> ?
      AND (owner_id IS NOT NULL OR status IN ('running', 'waiting', 'interrupted'))
    ORDER BY updated_order DESC, query_id LIMIT 1
  `);
  function loadRow(key: CheckpointKey): CheckpointRow | undefined {
    return checkpointRow.get(key.agentId, key.threadId, key.queryId) as unknown as
      | CheckpointRow
      | undefined;
  }
  return {
    async findUnfinished(agentId, threadId) {
      connection.assertOpen();
      const row = unfinished.get(agentId, threadId);
      return row ? snapshot(JSON.parse(row.payload as string) as AgentCheckpoint) : null;
    },
    async acquire(key, ownerId, options) {
      const detachedKey = snapshot(key);
      if (!ownerId) throw new AgentError("invalid-owner", "Checkpoint owner must not be empty.");
      return connection.transaction<CheckpointAcquireResult>(() => {
        const row = loadRow(detachedKey);
        const replace = options?.replace;
        // 先比较完整旧租约，再保留目标 Query 的非重入 busy 优先级。
        if (replace && (!sameKey(detachedKey, replace.key) || !matches(row, replace))) {
          return { status: "stale" };
        }
        if (row?.owner_id !== null && row?.owner_id !== undefined && !replace) {
          return {
            status: "busy",
            lease: { key: detachedKey, ownerId: row.owner_id, generation: row.generation },
          };
        }
        // 检查与取得写权处于同一写事务；首存前及终态保存后未释放的 owner 均阻塞。
        const pending = pendingThreadQuery.get(
          detachedKey.agentId,
          detachedKey.threadId,
          detachedKey.queryId,
        );
        if (pending) return { status: "thread-pending", queryId: pending.query_id as string };
        // 被拒绝时不改目标；已释放空行仍保留并推进 generation，绝不重用围栏。
        const generation = row ? nextRevision(row.generation) : 1;
        if (row)
          acquireCheckpoint.run(
            ownerId,
            generation,
            detachedKey.agentId,
            detachedKey.threadId,
            detachedKey.queryId,
          );
        else
          insertCheckpoint.run(
            detachedKey.agentId,
            detachedKey.threadId,
            detachedKey.queryId,
            ownerId,
          );
        return {
          status: "acquired",
          lease: { key: detachedKey, ownerId, generation },
          currentRevision: row?.revision ?? 0,
          checkpoint: row?.payload ? snapshot(JSON.parse(row.payload) as AgentCheckpoint) : null,
        };
      });
    },
    async save(lease, expectedRevision, checkpoint) {
      assertRevision(expectedRevision);
      const detached = snapshot(checkpoint);
      if (!sameKey(lease.key, detached)) {
        throw new AgentError(
          "checkpoint-key-mismatch",
          "Checkpoint identity must match its lease key.",
        );
      }
      const payload = JSON.stringify(detached);
      return connection.transaction<CheckpointSaveResult>(() => {
        const row = loadRow(lease.key);
        // 围栏优先于 revision；旧 writer 不能通过 CAS 错误掩盖 stale。
        if (!matches(row, lease)) return { status: "stale" };
        if (row.revision !== expectedRevision)
          return { status: "conflict", currentRevision: row.revision };
        const revision = nextRevision(row.revision);
        saveCheckpoint.run(
          revision,
          payload,
          detached.status,
          lease.key.agentId,
          lease.key.threadId,
          lease.key.queryId,
        );
        return { status: "saved", revision };
      });
    },
    async release(lease) {
      connection.assertOpen();
      releaseCheckpoint.run(
        lease.key.agentId,
        lease.key.threadId,
        lease.key.queryId,
        lease.ownerId,
        lease.generation,
      );
    },
  };
}
