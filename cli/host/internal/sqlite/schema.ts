import type { DatabaseSync } from "node:sqlite";

/** 规范历史格式不变；宿主展示副本独立于 Core 检查点与恢复状态。 */
export function initializeSqliteSchema(database: DatabaseSync): void {
  database.exec(`
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
    CREATE TABLE IF NOT EXISTS general_agent_host_tool_displays (
      agent_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      query_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      message_index INTEGER NOT NULL,
      content_index INTEGER NOT NULL,
      call_id TEXT NOT NULL,
      name TEXT NOT NULL,
      tool_version TEXT,
      payload TEXT NOT NULL,
      PRIMARY KEY (agent_id, thread_id, query_id, step, message_index, content_index, call_id)
    );
  `);
}
