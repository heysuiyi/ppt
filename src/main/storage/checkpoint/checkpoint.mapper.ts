import type { DatabaseSync } from "node:sqlite";
import type { CheckpointDO } from "./checkpoint.do";
import type { CheckpointCasInput, CheckpointLease } from "./checkpoint.dto";

export class CheckpointMapper {
  constructor(private readonly database: DatabaseSync) {}

  save(threadId: string, checkpoint: unknown, runId?: string): void {
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

  load<T>(threadId: string): T | undefined {
    const row = this.database
      .prepare("SELECT checkpoint_json FROM run_checkpoints WHERE thread_id = ?")
      .get(threadId) as Pick<CheckpointDO, "checkpoint_json"> | undefined;
    return row ? ((JSON.parse(row.checkpoint_json) as T | null) ?? undefined) : undefined;
  }

  findLease(threadId: string): CheckpointLease | undefined {
    const row = this.database
      .prepare(`
      SELECT active_run_id, writer_generation, writer_revision, checkpoint_json
      FROM run_checkpoints WHERE thread_id = ?
    `)
      .get(threadId) as
      | Pick<
          CheckpointDO,
          "active_run_id" | "writer_generation" | "writer_revision" | "checkpoint_json"
        >
      | undefined;
    return row
      ? {
          activeRunId: row.active_run_id ?? undefined,
          writerGeneration: row.writer_generation,
          writerRevision: row.writer_revision,
          checkpointJson: row.checkpoint_json,
        }
      : undefined;
  }

  acquireLease(threadId: string, runId: string, generation: number, now: string): void {
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
      .run(threadId, runId, generation, now, now);
  }

  updateIfLeaseMatches(input: CheckpointCasInput, payload: string): boolean {
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
    return result.changes === 1;
  }

  releaseLease(threadId: string, runId: string, generation: number): boolean {
    const result = this.database
      .prepare(`
      UPDATE run_checkpoints
      SET active_run_id = NULL, lease_updated_at = ?
      WHERE thread_id = ? AND active_run_id = ? AND writer_generation = ?
    `)
      .run(new Date().toISOString(), threadId, runId, generation);
    return result.changes === 1;
  }
}
