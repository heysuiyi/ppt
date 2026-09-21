import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AppendConversationEventInput,
  type ConversationEvent,
  type ConversationEventPage,
  conversationEventSchema,
} from "@shared/conversation-events";
import {
  migrateDisplayCardsToSvgOnly,
  migratePresentationToSvgOnly,
  repairPresentationIdentities,
} from "@shared/presentation-repair";
import {
  type SessionSnapshot,
  sessionChatMessageSchema,
  sessionSnapshotSchema,
} from "@shared/session";
import { withSqliteTransaction } from "./sqlite-transaction";

interface StoredSessionRow {
  id: string;
  ordinal: number;
  snapshot_json: string;
}

interface StoredMessageRow {
  message_json: string;
}

interface StoredEventRow {
  id: number;
  session_id: string;
  run_id: string | null;
  thread_id: string | null;
  sequence: number;
  kind: string;
  visibility: string;
  payload_json: string;
  created_at: string;
}

export interface ConversationDatabaseState {
  activeSessionId: string;
  sessions: SessionSnapshot[];
}

export interface StoredContextSnapshot {
  id: number;
  sessionId: string;
  threadId?: string;
  coveredSequenceStart: number;
  coveredSequenceEnd: number;
  summary: string;
  modelContext: unknown;
  tokenEstimate?: number;
  createdAt: string;
}

/**
 * Application-owned SQLite database. This is the only durable store for
 * conversations, model runs, checkpoints and context compaction snapshots.
 * Workspace directories are deliberately absent from all persistence paths.
 */
export class ConversationDatabase {
  private readonly database: DatabaseSync;

  constructor(readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.database = new DatabaseSync(filePath);
    this.initializeSchema();
  }

  close(): void {
    this.database.close();
  }

  get sqliteConnection(): DatabaseSync {
    return this.database;
  }

  withTransaction<T>(operation: () => T): T {
    return withSqliteTransaction(this.database, operation);
  }

  private initializeSchema(): void {
    this.database.exec(`
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
    `);
    const checkpointColumns = new Set(
      (
        this.database.prepare("PRAGMA table_info(run_checkpoints)").all() as unknown as Array<{
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
      if (!checkpointColumns.has(column)) this.database.exec(sql);
    }
  }

  loadState(): ConversationDatabaseState {
    const activeRow = this.database
      .prepare("SELECT value FROM app_state WHERE key = 'active_session_id'")
      .get() as { value?: string } | undefined;
    const rows = this.database
      .prepare("SELECT id, ordinal, snapshot_json FROM sessions ORDER BY ordinal ASC")
      .all() as unknown as StoredSessionRow[];

    const sessions = rows.map((row) => {
      const stored = JSON.parse(row.snapshot_json) as Omit<SessionSnapshot, "messages">;
      const repairedPresentation = migratePresentationToSvgOnly(
        repairPresentationIdentities(stored.presentation).value,
      ).value;
      const repairedDisplayCards = migrateDisplayCardsToSvgOnly(stored.displayCards ?? []).value;
      const messageRows = this.database
        .prepare("SELECT message_json FROM messages WHERE session_id = ? ORDER BY ordinal ASC")
        .all(row.id) as unknown as StoredMessageRow[];
      return sessionSnapshotSchema.parse({
        ...stored,
        presentation: repairedPresentation,
        displayCards: repairedDisplayCards,
        messages: messageRows.map((message) =>
          sessionChatMessageSchema.parse(JSON.parse(message.message_json)),
        ),
      });
    });

    const requestedActive = activeRow?.value ?? "";
    return {
      activeSessionId: sessions.some((item) => item.session.id === requestedActive)
        ? requestedActive
        : (sessions[0]?.session.id ?? ""),
      sessions,
    };
  }

  ensureProject(workspacePath: string, title: string): string {
    const existing = this.database
      .prepare("SELECT id FROM projects WHERE workspace_path = ?")
      .get(workspacePath) as { id: string } | undefined;
    const now = new Date().toISOString();
    if (existing) {
      this.database
        .prepare("UPDATE projects SET title = ?, updated_at = ? WHERE id = ?")
        .run(title, now, existing.id);
      return existing.id;
    }
    const id = crypto.randomUUID();
    this.database
      .prepare(`
      INSERT INTO projects(id, workspace_path, title, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?)
    `)
      .run(id, workspacePath, title, now, now);
    return id;
  }

  replaceState(state: ConversationDatabaseState): void {
    this.transaction(() => {
      this.database
        .prepare(
          "INSERT INTO app_state(key, value) VALUES('active_session_id', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(state.activeSessionId);

      const ids = new Set(state.sessions.map((snapshot) => snapshot.session.id));
      const existing = this.database.prepare("SELECT id FROM sessions").all() as unknown as Array<{
        id: string;
      }>;
      const deleteSession = this.database.prepare("DELETE FROM sessions WHERE id = ?");
      for (const row of existing) {
        if (!ids.has(row.id)) deleteSession.run(row.id);
      }

      const upsertSession = this.database.prepare(`
        INSERT INTO sessions(id, ordinal, snapshot_json, created_at, updated_at, workspace_path)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          ordinal = excluded.ordinal,
          snapshot_json = excluded.snapshot_json,
          updated_at = excluded.updated_at,
          workspace_path = excluded.workspace_path
      `);
      const deleteMessages = this.database.prepare("DELETE FROM messages WHERE session_id = ?");
      const insertMessage = this.database.prepare(`
        INSERT INTO messages(
          session_id, message_id, ordinal, role, thread_id,
          message_json, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const [sessionOrdinal, snapshot] of state.sessions.entries()) {
        const { messages: _messages, ...storedSnapshot } = snapshot;
        upsertSession.run(
          snapshot.session.id,
          sessionOrdinal,
          JSON.stringify(storedSnapshot),
          snapshot.session.createdAt,
          snapshot.session.updatedAt,
          snapshot.session.workspacePath ?? null,
        );
        deleteMessages.run(snapshot.session.id);
        for (const [ordinal, message] of snapshot.messages.entries()) {
          const now = new Date().toISOString();
          insertMessage.run(
            snapshot.session.id,
            message.id,
            ordinal,
            message.role,
            message.threadId ?? null,
            JSON.stringify(message),
            now,
            now,
          );
        }
      }
    });
  }

  hasRun(runId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId));
  }

  latestSessionRun(sessionId: string): { runId: string; threadId: string } | undefined {
    return this.database
      .prepare(
        "SELECT run_id AS runId, thread_id AS threadId FROM runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(sessionId) as { runId: string; threadId: string } | undefined;
  }

  acceptRun(
    state: ConversationDatabaseState,
    input: Parameters<ConversationDatabase["beginRun"]>[0],
  ): void {
    this.transaction(() => {
      if (this.hasRun(input.runId)) throw new Error("This request has already been accepted.");
      this.replaceState(state);
      this.beginRun(input);
      this.database
        .prepare("UPDATE runs SET status = 'preparing' WHERE run_id = ?")
        .run(input.runId);
    });
  }

  markRunRunning(runId: string): void {
    this.database
      .prepare("UPDATE runs SET status = 'running' WHERE run_id = ? AND status = 'preparing'")
      .run(runId);
  }

  beginRun(input: {
    runId: string;
    sessionId: string;
    threadId?: string;
    provider?: string;
    model?: string;
    request?: string;
  }): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
      INSERT INTO runs(
        run_id, session_id, thread_id, provider, model, status,
        request_text, started_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, 'running', ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        provider = excluded.provider,
        model = excluded.model,
        status = 'running',
        request_text = excluded.request_text,
        updated_at = excluded.updated_at,
        completed_at = NULL,
        error = NULL
    `)
      .run(
        input.runId,
        input.sessionId,
        input.threadId ?? input.runId,
        input.provider ?? null,
        input.model ?? null,
        input.request ?? null,
        now,
        now,
      );
    this.appendEvent({
      sessionId: input.sessionId,
      runId: input.runId,
      threadId: input.threadId ?? input.runId,
      kind: "run_started",
      payload: { request: input.request ?? "", provider: input.provider, model: input.model },
    });
    this.appendEvent({
      sessionId: input.sessionId,
      runId: input.runId,
      threadId: input.threadId ?? input.runId,
      kind: "user_message",
      payload: { content: input.request ?? "" },
    });
    this.appendEvent({
      sessionId: input.sessionId,
      runId: input.runId,
      threadId: input.threadId ?? input.runId,
      kind: "assistant_started",
      payload: {},
    });
  }

  bindRunQueryId(runId: string, queryId: string): void {
    const row = this.database
      .prepare("SELECT session_id, thread_id, query_id FROM runs WHERE run_id = ?")
      .get(runId) as
      | {
          session_id: string;
          thread_id: string | null;
          query_id: string | null;
        }
      | undefined;
    if (!row) throw new Error(`Run not found: ${runId}`);
    if (queryId === runId || queryId === row.thread_id) {
      throw new Error("QueryId must be distinct from runId and threadId.");
    }
    if (row.query_id === queryId) return;
    if (row.query_id) {
      throw new Error(`Run ${runId} is already bound to QueryId ${row.query_id}.`);
    }
    this.database
      .prepare("UPDATE runs SET query_id = ?, updated_at = ? WHERE run_id = ? AND query_id IS NULL")
      .run(queryId, new Date().toISOString(), runId);
    this.appendEvent({
      sessionId: row.session_id,
      runId,
      threadId: row.thread_id ?? undefined,
      kind: "query_started",
      visibility: "internal",
      payload: { queryId },
    });
  }

  getRunQueryId(runId: string): string | undefined {
    const row = this.database.prepare("SELECT query_id FROM runs WHERE run_id = ?").get(runId) as
      | { query_id: string | null }
      | undefined;
    return row?.query_id ?? undefined;
  }

  finishRun(input: {
    runId: string;
    status: "completed" | "failed" | "interrupted";
    result?: unknown;
    error?: string;
    threadId?: string;
  }): void {
    const row = this.database
      .prepare("SELECT session_id, thread_id FROM runs WHERE run_id = ?")
      .get(input.runId) as { session_id: string; thread_id?: string } | undefined;
    if (!row) return;
    const now = new Date().toISOString();
    this.database
      .prepare(`
      UPDATE runs SET status = ?, result_json = ?, error = ?,
        updated_at = ?, completed_at = ? WHERE run_id = ?
    `)
      .run(
        input.status,
        input.result === undefined ? null : JSON.stringify(input.result),
        input.error ?? null,
        now,
        now,
        input.runId,
      );
    this.appendEvent({
      sessionId: row.session_id,
      runId: input.runId,
      threadId: input.threadId ?? row.thread_id,
      kind:
        input.status === "completed"
          ? "run_completed"
          : input.status === "interrupted"
            ? "run_interrupted"
            : "run_failed",
      payload: { result: input.result, error: input.error },
    });
  }

  loadTerminalRunResult<T>(runId: string): T | undefined {
    const row = this.database
      .prepare("SELECT status, result_json FROM runs WHERE run_id = ?")
      .get(runId) as
      | {
          status: "preparing" | "running" | "completed" | "failed" | "interrupted";
          result_json: string | null;
        }
      | undefined;
    if (!row || row.status === "running" || row.result_json === null) return undefined;
    return JSON.parse(row.result_json) as T;
  }

  interruptRunningRuns(error = "Application restarted before the run completed."): string[] {
    const rows = this.database
      .prepare(
        "SELECT run_id FROM runs WHERE status IN ('running', 'preparing') ORDER BY started_at",
      )
      .all() as Array<{ run_id: string }>;
    for (const row of rows) {
      this.finishRun({
        runId: row.run_id,
        status: "interrupted",
        error,
      });
    }
    return rows.map((row) => row.run_id);
  }

  appendEvent(input: AppendConversationEventInput): ConversationEvent | undefined {
    const sessionId = input.sessionId ?? this.sessionIdForRun(input.runId);
    if (!sessionId) return undefined;
    const createdAt = input.createdAt ?? new Date().toISOString();
    const next = this.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM conversation_events WHERE session_id = ?",
      )
      .get(sessionId) as { next: number };
    const result = this.database
      .prepare(`
      INSERT INTO conversation_events(
        session_id, run_id, thread_id, sequence, kind,
        visibility, payload_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        sessionId,
        input.runId ?? null,
        input.threadId ?? null,
        next.next,
        input.kind,
        input.visibility ?? "user_visible",
        JSON.stringify(input.payload ?? {}),
        createdAt,
      );
    return conversationEventSchema.parse({
      id: Number(result.lastInsertRowid),
      sessionId,
      runId: input.runId,
      threadId: input.threadId,
      sequence: next.next,
      kind: input.kind,
      visibility: input.visibility ?? "user_visible",
      payload: input.payload ?? {},
      createdAt,
    });
  }

  appendRuntimeEvent(
    runId: string,
    kind: AppendConversationEventInput["kind"],
    payload: Record<string, unknown>,
    visibility: AppendConversationEventInput["visibility"] = "user_visible",
  ): ConversationEvent | undefined {
    return this.appendEvent({ runId, kind, payload, visibility });
  }

  listEvents(sessionId: string, cursor = 0, limit = 200): ConversationEventPage {
    const safeLimit = Math.max(1, Math.min(500, limit));
    const rows = this.database
      .prepare(`
      SELECT id, session_id, run_id, thread_id, sequence, kind,
        visibility, payload_json, created_at
      FROM conversation_events
      WHERE session_id = ? AND sequence >= ?
      ORDER BY sequence ASC
      LIMIT ?
    `)
      .all(sessionId, cursor, safeLimit + 1) as unknown as StoredEventRow[];
    const hasMore = rows.length > safeLimit;
    const pageRows = rows.slice(0, safeLimit);
    return {
      events: pageRows.map((row) => this.toConversationEvent(row)),
      nextCursor: hasMore ? pageRows.at(-1)!.sequence + 1 : undefined,
    };
  }

  listRunEvents(runId: string): ConversationEvent[] {
    const rows = this.database
      .prepare(`
      SELECT id, session_id, run_id, thread_id, sequence, kind,
        visibility, payload_json, created_at
      FROM conversation_events
      WHERE run_id = ?
      ORDER BY sequence ASC
    `)
      .all(runId) as unknown as StoredEventRow[];
    return rows.map((row) => this.toConversationEvent(row));
  }

  saveRunCheckpoint(threadId: string, checkpoint: unknown, runId?: string): void {
    this.database
      .prepare(`
      INSERT INTO run_checkpoints(thread_id, run_id, checkpoint_json, updated_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        run_id = excluded.run_id,
        checkpoint_json = excluded.checkpoint_json,
        updated_at = excluded.updated_at
    `)
      .run(threadId, runId ?? null, JSON.stringify(checkpoint), new Date().toISOString());
  }

  loadRunCheckpoint<T>(threadId: string): T | undefined {
    const row = this.database
      .prepare("SELECT checkpoint_json FROM run_checkpoints WHERE thread_id = ?")
      .get(threadId) as { checkpoint_json: string } | undefined;
    if (!row) return undefined;
    const parsed = JSON.parse(row.checkpoint_json) as T | null;
    return parsed ?? undefined;
  }

  openRunCheckpointLease(input: {
    threadId: string;
    runId: string;
    resume: boolean;
    allowTakeover?: boolean;
  }):
    | { type: "opened"; generation: number; revision: number; checkpoint?: unknown }
    | { type: "lease_busy"; activeRunId: string; generation: number } {
    return this.transaction(() => {
      const row = this.database
        .prepare(`
        SELECT checkpoint_json, active_run_id, writer_generation, writer_revision
        FROM run_checkpoints WHERE thread_id = ?
      `)
        .get(input.threadId) as
        | {
            checkpoint_json: string;
            active_run_id: string | null;
            writer_generation: number;
            writer_revision: number;
          }
        | undefined;

      if (row?.active_run_id && row.active_run_id !== input.runId && !input.allowTakeover) {
        // A crash can leave a lease after startup recovery interrupts its owner.
        // Only a known terminal owner is safe to fence out; unknown owners stay busy.
        const terminalOwner = this.database
          .prepare(
            "SELECT 1 FROM runs WHERE run_id = ? AND status IN ('completed', 'failed', 'interrupted')",
          )
          .get(row.active_run_id);
        if (!terminalOwner) {
          return {
            type: "lease_busy" as const,
            activeRunId: row.active_run_id,
            generation: row.writer_generation,
          };
        }
      }
      if (row?.active_run_id === input.runId) {
        const checkpoint = JSON.parse(row.checkpoint_json) as unknown;
        return {
          type: "opened" as const,
          generation: row.writer_generation,
          revision: row.writer_revision,
          ...(checkpoint ? { checkpoint } : {}),
        };
      }

      const generation = (row?.writer_generation ?? 0) + 1;
      const now = new Date().toISOString();
      this.database
        .prepare(`
        INSERT INTO run_checkpoints(
          thread_id, run_id, checkpoint_json, active_run_id,
          writer_generation, writer_revision, lease_updated_at, updated_at
        ) VALUES(?, NULL, 'null', ?, ?, 0, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          active_run_id = excluded.active_run_id,
          writer_generation = excluded.writer_generation,
          writer_revision = 0,
          lease_updated_at = excluded.lease_updated_at
      `)
        .run(input.threadId, input.runId, generation, now, now);
      const checkpoint = row ? (JSON.parse(row.checkpoint_json) as unknown) : undefined;
      return {
        type: "opened" as const,
        generation,
        revision: 0,
        ...(checkpoint ? { checkpoint } : {}),
      };
    });
  }

  saveRunCheckpointCas(input: {
    threadId: string;
    runId: string;
    generation: number;
    expectedRevision: number;
    nextRevision: number;
    checkpoint: unknown;
  }): "saved" | "already_applied" | "stale_generation" | "revision_conflict" {
    return this.transaction(() => {
      const row = this.database
        .prepare(`
        SELECT active_run_id, writer_generation, writer_revision, checkpoint_json
        FROM run_checkpoints WHERE thread_id = ?
      `)
        .get(input.threadId) as
        | {
            active_run_id: string | null;
            writer_generation: number;
            writer_revision: number;
            checkpoint_json: string;
          }
        | undefined;
      if (!row || row.active_run_id !== input.runId || row.writer_generation !== input.generation)
        return "stale_generation";

      const payload = JSON.stringify(input.checkpoint);
      if (row.writer_revision === input.nextRevision) {
        return row.checkpoint_json === payload ? "already_applied" : "revision_conflict";
      }
      if (
        row.writer_revision !== input.expectedRevision ||
        input.nextRevision !== input.expectedRevision + 1
      )
        return "revision_conflict";

      const result = this.database
        .prepare(`
        UPDATE run_checkpoints
        SET run_id = ?, checkpoint_json = ?, writer_revision = ?,
            lease_updated_at = ?, updated_at = ?
        WHERE thread_id = ? AND active_run_id = ?
          AND writer_generation = ? AND writer_revision = ?
      `)
        .run(
          input.runId,
          payload,
          input.nextRevision,
          new Date().toISOString(),
          new Date().toISOString(),
          input.threadId,
          input.runId,
          input.generation,
          input.expectedRevision,
        );
      return result.changes === 1 ? "saved" : "revision_conflict";
    });
  }

  closeRunCheckpointLease(input: { threadId: string; runId: string; generation: number }): boolean {
    const result = this.database
      .prepare(`
      UPDATE run_checkpoints
      SET active_run_id = NULL, lease_updated_at = ?
      WHERE thread_id = ? AND active_run_id = ? AND writer_generation = ?
    `)
      .run(new Date().toISOString(), input.threadId, input.runId, input.generation);
    return result.changes === 1;
  }

  inspectRunCheckpointLease(input: {
    threadId: string;
    runId: string;
    generation: number;
  }): { type: "active"; revision: number; checkpoint?: unknown } | { type: "stale" } {
    const row = this.database
      .prepare(`
      SELECT active_run_id, writer_generation, writer_revision, checkpoint_json
      FROM run_checkpoints WHERE thread_id = ?
    `)
      .get(input.threadId) as
      | {
          active_run_id: string | null;
          writer_generation: number;
          writer_revision: number;
          checkpoint_json: string;
        }
      | undefined;
    if (!row || row.active_run_id !== input.runId || row.writer_generation !== input.generation)
      return { type: "stale" };
    const checkpoint = JSON.parse(row.checkpoint_json) as unknown;
    return {
      type: "active",
      revision: row.writer_revision,
      ...(checkpoint ? { checkpoint } : {}),
    };
  }

  saveServiceThread(threadId: string, state: unknown): void {
    this.database
      .prepare(`
      INSERT INTO service_threads(thread_id, state_json, updated_at)
      VALUES(?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `)
      .run(threadId, JSON.stringify(state), new Date().toISOString());
  }

  loadServiceThread<T>(threadId: string): T | undefined {
    const row = this.database
      .prepare("SELECT state_json FROM service_threads WHERE thread_id = ?")
      .get(threadId) as { state_json: string } | undefined;
    return row ? (JSON.parse(row.state_json) as T) : undefined;
  }

  saveAgentConversationHistory(threadId: string, messages: unknown): void {
    this.database
      .prepare(`
      INSERT INTO agent_conversation_histories(thread_id, messages_json, updated_at)
      VALUES(?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        messages_json = excluded.messages_json,
        updated_at = excluded.updated_at
    `)
      .run(threadId, JSON.stringify(messages), new Date().toISOString());
  }

  loadAgentConversationHistory<T>(threadId: string): T | undefined {
    const row = this.database
      .prepare("SELECT messages_json FROM agent_conversation_histories WHERE thread_id = ?")
      .get(threadId) as { messages_json: string } | undefined;
    return row ? (JSON.parse(row.messages_json) as T) : undefined;
  }

  saveContextSnapshot(
    input: Omit<StoredContextSnapshot, "id" | "createdAt">,
  ): StoredContextSnapshot {
    const createdAt = new Date().toISOString();
    const result = this.database
      .prepare(`
      INSERT INTO context_snapshots(
        session_id, thread_id, covered_sequence_start, covered_sequence_end,
        summary, model_context_json, token_estimate, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        input.sessionId,
        input.threadId ?? null,
        input.coveredSequenceStart,
        input.coveredSequenceEnd,
        input.summary,
        JSON.stringify(input.modelContext),
        input.tokenEstimate ?? null,
        createdAt,
      );
    return { ...input, id: Number(result.lastInsertRowid), createdAt };
  }

  saveContextSnapshotForRun(
    runId: string,
    modelContext: unknown,
    notes: string[],
  ): StoredContextSnapshot | undefined {
    const run = this.database
      .prepare("SELECT session_id, thread_id FROM runs WHERE run_id = ?")
      .get(runId) as { session_id: string; thread_id?: string } | undefined;
    if (!run) return undefined;
    const boundary = this.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM conversation_events WHERE session_id = ?",
      )
      .get(run.session_id) as { sequence: number };
    const previous = this.latestContextSnapshot(run.session_id);
    return this.saveContextSnapshot({
      sessionId: run.session_id,
      threadId: run.thread_id,
      coveredSequenceStart: previous ? previous.coveredSequenceEnd + 1 : 0,
      coveredSequenceEnd: boundary.sequence,
      summary: notes.join("\n") || "Prepared model context snapshot.",
      modelContext,
    });
  }

  latestContextSnapshot(sessionId: string): StoredContextSnapshot | undefined {
    const row = this.database
      .prepare(`
      SELECT id, session_id, thread_id, covered_sequence_start, covered_sequence_end,
        summary, model_context_json, token_estimate, created_at
      FROM context_snapshots WHERE session_id = ?
      ORDER BY covered_sequence_end DESC, id DESC LIMIT 1
    `)
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      sessionId: String(row.session_id),
      threadId: row.thread_id ? String(row.thread_id) : undefined,
      coveredSequenceStart: Number(row.covered_sequence_start),
      coveredSequenceEnd: Number(row.covered_sequence_end),
      summary: String(row.summary),
      modelContext: JSON.parse(String(row.model_context_json)),
      tokenEstimate:
        row.token_estimate === null || row.token_estimate === undefined
          ? undefined
          : Number(row.token_estimate),
      createdAt: String(row.created_at),
    };
  }

  private sessionIdForRun(runId: string | undefined): string | undefined {
    if (!runId) return undefined;
    const row = this.database.prepare("SELECT session_id FROM runs WHERE run_id = ?").get(runId) as
      | { session_id: string }
      | undefined;
    return row?.session_id;
  }

  private toConversationEvent(row: StoredEventRow): ConversationEvent {
    return conversationEventSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id ?? undefined,
      threadId: row.thread_id ?? undefined,
      sequence: row.sequence,
      kind: row.kind,
      visibility: row.visibility,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at,
    });
  }

  private transaction<T>(task: () => T): T {
    return this.withTransaction(task);
  }
}
