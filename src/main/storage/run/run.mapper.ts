import type { DatabaseSync } from "node:sqlite";
import type { RunDO } from "./run.do";
import type {
  BeginRunInput,
  FinishRunInput,
  LatestSessionRun,
  RunQueryBinding,
  RunRecord,
  RunSession,
  StoredRunResult,
} from "./run.dto";

export class RunMapper {
  constructor(private readonly database: DatabaseSync) {}

  findById(runId: string): RunRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT run_id, session_id, thread_id, query_id, status, result_json FROM runs WHERE run_id = ?",
      )
      .get(runId) as
      | Pick<RunDO, "run_id" | "session_id" | "thread_id" | "query_id" | "status" | "result_json">
      | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id,
      sessionId: row.session_id,
      threadId: row.thread_id ?? undefined,
      queryId: row.query_id ?? undefined,
      status: row.status,
      result: row.result_json === null ? undefined : JSON.parse(row.result_json),
    };
  }

  findQueryBinding(runId: string): RunQueryBinding | undefined {
    const row = this.database
      .prepare("SELECT session_id, thread_id, query_id FROM runs WHERE run_id = ?")
      .get(runId) as Pick<RunDO, "session_id" | "thread_id" | "query_id"> | undefined;
    return row
      ? {
          sessionId: row.session_id,
          threadId: row.thread_id ?? undefined,
          queryId: row.query_id ?? undefined,
        }
      : undefined;
  }

  findSession(runId: string): RunSession | undefined {
    const row = this.database
      .prepare("SELECT session_id, thread_id FROM runs WHERE run_id = ?")
      .get(runId) as Pick<RunDO, "session_id" | "thread_id"> | undefined;
    return row ? { sessionId: row.session_id, threadId: row.thread_id ?? undefined } : undefined;
  }

  findQueryId(runId: string): string | undefined {
    const row = this.database.prepare("SELECT query_id FROM runs WHERE run_id = ?").get(runId) as
      | Pick<RunDO, "query_id">
      | undefined;
    return row?.query_id ?? undefined;
  }

  findResult(runId: string): StoredRunResult | undefined {
    const row = this.database
      .prepare("SELECT status, result_json FROM runs WHERE run_id = ?")
      .get(runId) as Pick<RunDO, "status" | "result_json"> | undefined;
    return row ? { status: row.status, resultJson: row.result_json ?? undefined } : undefined;
  }

  exists(runId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId));
  }

  latestForSession(sessionId: string): LatestSessionRun | undefined {
    const row = this.database
      .prepare(
        "SELECT run_id, thread_id FROM runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get(sessionId) as Pick<RunDO, "run_id" | "thread_id"> | undefined;
    return row ? { runId: row.run_id, threadId: row.thread_id ?? undefined } : undefined;
  }

  markPreparing(runId: string): void {
    this.database.prepare("UPDATE runs SET status = 'preparing' WHERE run_id = ?").run(runId);
  }

  markRunning(runId: string): void {
    this.database
      .prepare("UPDATE runs SET status = 'running' WHERE run_id = ? AND status = 'preparing'")
      .run(runId);
  }

  upsertStarted(input: BeginRunInput, now: string): void {
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
  }

  bindQueryIdIfUnbound(runId: string, queryId: string, updatedAt: string): void {
    this.database
      .prepare("UPDATE runs SET query_id = ?, updated_at = ? WHERE run_id = ? AND query_id IS NULL")
      .run(queryId, updatedAt, runId);
  }

  finish(input: FinishRunInput, now: string): void {
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
  }

  listUnfinishedIds(): string[] {
    return (
      this.database
        .prepare(
          "SELECT run_id FROM runs WHERE status IN ('running', 'preparing') ORDER BY started_at",
        )
        .all() as Pick<RunDO, "run_id">[]
    ).map((row) => row.run_id);
  }

  isTerminal(runId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 FROM runs WHERE run_id = ? AND status IN ('completed', 'failed', 'interrupted')",
        )
        .get(runId),
    );
  }
}
