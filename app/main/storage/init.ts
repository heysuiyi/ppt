import type { DatabaseSync } from "node:sqlite";

/**
 * Initializes all application tables, indexes and existing checkpoint migrations.
 * The caller owns the connection; repeated initialization preserves stored data.
 */
export function init(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      ordinal INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      workspace_path TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      thread_id TEXT,
      message_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id, message_id),
      UNIQUE(session_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS messages_session_ordinal
      ON messages(session_id, ordinal);
    CREATE INDEX IF NOT EXISTS messages_thread
      ON messages(thread_id);

    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      thread_id TEXT,
      query_id TEXT,
      provider TEXT,
      model TEXT,
      status TEXT NOT NULL,
      request_text TEXT,
      result_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS runs_session_started
      ON runs(session_id, started_at);
    CREATE INDEX IF NOT EXISTS runs_thread
      ON runs(thread_id);
    CREATE INDEX IF NOT EXISTS runs_query
      ON runs(query_id);

    CREATE TABLE IF NOT EXISTS conversation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
      thread_id TEXT,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      visibility TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS events_session_sequence
      ON conversation_events(session_id, sequence);
    CREATE INDEX IF NOT EXISTS events_run
      ON conversation_events(run_id, id);

    CREATE TABLE IF NOT EXISTS run_checkpoints (
      thread_id TEXT PRIMARY KEY,
      run_id TEXT,
      checkpoint_json TEXT NOT NULL,
      active_run_id TEXT,
      writer_generation INTEGER NOT NULL DEFAULT 0,
      writer_revision INTEGER NOT NULL DEFAULT 0,
      lease_updated_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_threads (
      thread_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_conversation_histories (
      thread_id TEXT PRIMARY KEY,
      messages_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      thread_id TEXT,
      covered_sequence_start INTEGER NOT NULL,
      covered_sequence_end INTEGER NOT NULL,
      summary TEXT NOT NULL,
      model_context_json TEXT NOT NULL,
      token_estimate INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS context_session_boundary
      ON context_snapshots(session_id, covered_sequence_end DESC);

    CREATE TABLE IF NOT EXISTS blobs (
      hash TEXT PRIMARY KEY,
      media_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );


    CREATE TABLE IF NOT EXISTS ppt_jobs (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      presentation_id TEXT NOT NULL UNIQUE,
      state_revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ppt_capability_requests (
      request_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
      query_id TEXT,
      capability TEXT NOT NULL,
      request_json TEXT NOT NULL,
      requested_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ppt_requests_job_requested
      ON ppt_capability_requests(job_id, requested_at);
    CREATE UNIQUE INDEX IF NOT EXISTS ppt_requests_query
      ON ppt_capability_requests(job_id, query_id)
      WHERE query_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS ppt_artifact_revisions (
      revision_id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      stage TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      revision_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      UNIQUE(job_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS ppt_revisions_job_artifact
      ON ppt_artifact_revisions(job_id, artifact_id, committed_at);

    CREATE TABLE IF NOT EXISTS ppt_artifact_dependencies (
      artifact_revision_id TEXT NOT NULL
        REFERENCES ppt_artifact_revisions(revision_id) ON DELETE CASCADE,
      dependency_artifact_id TEXT NOT NULL,
      dependency_revision_id TEXT NOT NULL
        REFERENCES ppt_artifact_revisions(revision_id),
      dependency_content_hash TEXT NOT NULL,
      PRIMARY KEY(artifact_revision_id, dependency_revision_id)
    );

    CREATE TABLE IF NOT EXISTS ppt_artifact_heads (
      job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL,
      revision_id TEXT NOT NULL
        REFERENCES ppt_artifact_revisions(revision_id),
      PRIMARY KEY(job_id, artifact_id)
    );

    CREATE TABLE IF NOT EXISTS ppt_stage_attempts (
      stage_run_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      attempt_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(job_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS ppt_proposals (
      proposal_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      proposal_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ppt_side_effects (
      job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
      operation TEXT NOT NULL,
      effect_key TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      claimed_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY(job_id, operation, effect_key)
    );

    CREATE TABLE IF NOT EXISTS ppt_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
      state_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ppt_events_job_revision
      ON ppt_job_events(job_id, state_revision, id);
      `);
  const checkpointColumns = new Set(
    (
      database.prepare("PRAGMA table_info(run_checkpoints)").all() as unknown as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  const migrations = [
    ["active_run_id", "ALTER TABLE run_checkpoints ADD COLUMN active_run_id TEXT"],
    [
      "writer_generation",
      "ALTER TABLE run_checkpoints ADD COLUMN writer_generation INTEGER NOT NULL DEFAULT 0",
    ],
    [
      "writer_revision",
      "ALTER TABLE run_checkpoints ADD COLUMN writer_revision INTEGER NOT NULL DEFAULT 0",
    ],
    ["lease_updated_at", "ALTER TABLE run_checkpoints ADD COLUMN lease_updated_at TEXT"],
  ] as const;
  for (const [column, sql] of migrations) {
    if (!checkpointColumns.has(column)) database.exec(sql);
  }
}
