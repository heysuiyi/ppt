import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelMessage } from "../../agent/model/model-contract";
import { AgentError, sameValue, snapshot } from "../../agent/protocol-utils";
import type {
  CheckpointAcquireResult,
  CheckpointKey,
  CheckpointLease,
  CheckpointSaveResult,
  CheckpointStore,
} from "../../agent/session/checkpoint-contract";
import type {
  AgentCheckpoint,
  SessionHistoryAppendResult,
  SessionHistoryStore,
} from "../../agent/session/session-contract";
import {
  type HostSessionBinding,
  type HostSessionBindingStore,
  snapshotHostSessionBinding,
} from "./host-session-binding";

export interface SqliteAgentStores {
  readonly history: SessionHistoryStore;
  readonly checkpoints: CheckpointStore;
  readonly bindings: HostSessionBindingStore;
  dispose(): Promise<void>;
}

interface CheckpointRow {
  owner_id: string | null;
  generation: number;
  revision: number;
  payload: string | null;
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentError("invalid-revision", "Revision must be a nonnegative safe integer.");
  }
}

function nextRevision(value: number): number {
  assertRevision(value + 1);
  return value + 1;
}

function sameKey(left: CheckpointKey, right: CheckpointKey): boolean {
  return (
    left.agentId === right.agentId &&
    left.threadId === right.threadId &&
    left.queryId === right.queryId
  );
}

/** 新内核独立表；同步事务在 promise 解析之前完成落盘，不借用旧生产检查点。 */
export function createSqliteAgentStores(filePath: string): SqliteAgentStores {
  if (filePath === ":memory:" || filePath.length === 0) {
    throw new AgentError(
      "invalid-database-path",
      "Agent stores require a persistent database file.",
    );
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  try {
    database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS general_agent_history (
        thread_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision >= 0)
      );
      CREATE TABLE IF NOT EXISTS general_agent_history_batches (
        thread_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (thread_id, batch_id),
        UNIQUE (thread_id, revision),
        FOREIGN KEY (thread_id) REFERENCES general_agent_history(thread_id)
      );
      CREATE TABLE IF NOT EXISTS general_agent_checkpoints (
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        query_id TEXT NOT NULL,
        owner_id TEXT,
        generation INTEGER NOT NULL CHECK (generation > 0),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        payload TEXT,
        status TEXT,
        updated_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, thread_id, query_id)
      );
      CREATE INDEX IF NOT EXISTS general_agent_unfinished
        ON general_agent_checkpoints(agent_id, thread_id, status, updated_order);
      CREATE TABLE IF NOT EXISTS general_agent_host_bindings (
        thread_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
    `);
    const historyHead = database.prepare(
      "SELECT revision FROM general_agent_history WHERE thread_id = ?",
    );
    const historyBatches = database.prepare(
      "SELECT payload FROM general_agent_history_batches WHERE thread_id = ? ORDER BY revision",
    );
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
    const bindingRow = database.prepare(
      "SELECT payload FROM general_agent_host_bindings WHERE thread_id = ?",
    );
    const insertBinding = database.prepare(
      "INSERT INTO general_agent_host_bindings(thread_id, payload) VALUES (?, ?)",
    );
    const existingThreadCheckpoint = database.prepare(
      "SELECT 1 FROM general_agent_checkpoints WHERE thread_id = ? LIMIT 1",
    );
    let closed = false;
    function assertOpen(): void {
      if (closed) throw new AgentError("store-disposed", "Agent stores have been disposed.");
    }
    function transaction<T>(operation: () => T): T {
      assertOpen();
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    function loadRow(key: CheckpointKey): CheckpointRow | undefined {
      return checkpointRow.get(key.agentId, key.threadId, key.queryId) as unknown as
        | CheckpointRow
        | undefined;
    }
    function matches(row: CheckpointRow | undefined, lease: CheckpointLease): row is CheckpointRow {
      return (
        row !== undefined &&
        row.owner_id !== null &&
        row.owner_id === lease.ownerId &&
        row.generation === lease.generation
      );
    }
    const bindings: HostSessionBindingStore = {
      async read(threadId) {
        assertOpen();
        const row = bindingRow.get(threadId);
        return row
          ? snapshotHostSessionBinding(JSON.parse(row.payload as string) as HostSessionBinding)
          : null;
      },
      async ensure(binding) {
        assertOpen();
        const detached = snapshotHostSessionBinding(binding);
        const payload = JSON.stringify(detached);
        transaction(() => {
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
          if (
            historyHead.get(detached.threadId) ||
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
    const history: SessionHistoryStore = {
      async read(threadId) {
        return transaction(() => {
          const head = historyHead.get(threadId) as { revision: number } | undefined;
          const messages: ModelMessage[] = [];
          for (const row of historyBatches.all(threadId)) {
            messages.push(...snapshot(JSON.parse(row.payload as string) as ModelMessage[]));
          }
          return { threadId, revision: head?.revision ?? 0, messages };
        });
      },
      async append(threadId, expectedRevision, messages, batchId) {
        assertRevision(expectedRevision);
        if (!batchId)
          throw new AgentError("invalid-batch-id", "History batch ID must not be empty.");
        const detached = snapshot(messages);
        const payload = JSON.stringify(detached);
        return transaction<SessionHistoryAppendResult>(() => {
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
          if (revision !== expectedRevision)
            return { status: "conflict", currentRevision: revision };
          const next = nextRevision(revision);
          insertHead.run(threadId);
          insertBatch.run(threadId, batchId, next, payload);
          updateHead.run(next, threadId);
          return { status: "appended", revision: next };
        });
      },
    };
    const checkpoints: CheckpointStore = {
      async findUnfinished(agentId, threadId) {
        assertOpen();
        const row = unfinished.get(agentId, threadId);
        return row ? snapshot(JSON.parse(row.payload as string) as AgentCheckpoint) : null;
      },
      async acquire(key, ownerId, options) {
        const detachedKey = snapshot(key);
        if (!ownerId) throw new AgentError("invalid-owner", "Checkpoint owner must not be empty.");
        return transaction<CheckpointAcquireResult>(() => {
          const row = loadRow(detachedKey);
          const replace = options?.replace;
          if (replace && (!sameKey(detachedKey, replace.key) || !matches(row, replace))) {
            return { status: "stale" };
          }
          if (row?.owner_id !== null && row?.owner_id !== undefined && !replace) {
            return {
              status: "busy",
              lease: { key: detachedKey, ownerId: row.owner_id, generation: row.generation },
            };
          }
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
        return transaction<CheckpointSaveResult>(() => {
          const row = loadRow(lease.key);
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
        assertOpen();
        releaseCheckpoint.run(
          lease.key.agentId,
          lease.key.threadId,
          lease.key.queryId,
          lease.ownerId,
          lease.generation,
        );
      },
    };
    return {
      history,
      checkpoints,
      bindings,
      async dispose() {
        if (closed) return;
        closed = true;
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
