import type { DatabaseSync } from "node:sqlite";
import {
  type PptJobId,
  type PptStage,
  type PptStageAttempt,
  type PptStageRunId,
  pptStageAttemptSchema,
} from "@shared/presentation-lifecycle";
import type { PptStageAttemptDO } from "./ppt-stage-attempt.do";
import type { PptStageAttemptCountDTO } from "./ppt-stage-attempt.dto";

export class PptStageAttemptMapper {
  constructor(private readonly database: DatabaseSync) {}

  findById(stageRunId: PptStageRunId): PptStageAttempt | undefined {
    const row = this.database
      .prepare("SELECT attempt_json FROM ppt_stage_attempts WHERE stage_run_id = ?")
      .get(stageRunId) as Pick<PptStageAttemptDO, "attempt_json"> | undefined;
    return row ? pptStageAttemptSchema.parse(JSON.parse(row.attempt_json)) : undefined;
  }

  findByIdempotency(jobId: PptJobId, idempotencyKey: string): PptStageAttempt | undefined {
    const row = this.database
      .prepare(`
      SELECT attempt_json FROM ppt_stage_attempts
      WHERE job_id = ? AND idempotency_key = ?
    `)
      .get(jobId, idempotencyKey) as Pick<PptStageAttemptDO, "attempt_json"> | undefined;
    return row ? pptStageAttemptSchema.parse(JSON.parse(row.attempt_json)) : undefined;
  }

  countByStage(jobId: PptJobId, stage: PptStage): number {
    const row = this.database
      .prepare(`
      SELECT COUNT(*) AS count FROM ppt_stage_attempts
      WHERE job_id = ? AND stage = ?
    `)
      .get(jobId, stage) as unknown as PptStageAttemptCountDTO;
    return row.count;
  }

  insert(attempt: PptStageAttempt): void {
    this.database
      .prepare(`
      INSERT INTO ppt_stage_attempts(
        stage_run_id, job_id, stage, attempt, status,
        idempotency_key, attempt_json, started_at, completed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `)
      .run(
        attempt.stageRunId,
        attempt.jobId,
        attempt.stage,
        attempt.attempt,
        attempt.status,
        attempt.idempotencyKey,
        JSON.stringify(attempt),
        attempt.startedAt,
      );
  }

  updateIfRunning(attempt: PptStageAttempt): boolean {
    const result = this.database
      .prepare(`
      UPDATE ppt_stage_attempts
      SET status = ?, attempt_json = ?, completed_at = ?
      WHERE stage_run_id = ? AND status = 'running'
    `)
      .run(attempt.status, JSON.stringify(attempt), attempt.completedAt!, attempt.stageRunId);
    return result.changes === 1;
  }

  listByJob(jobId: PptJobId): PptStageAttempt[] {
    const rows = this.database
      .prepare(`
      SELECT attempt_json FROM ppt_stage_attempts
      WHERE job_id = ? ORDER BY started_at, attempt
    `)
      .all(jobId) as unknown as Pick<PptStageAttemptDO, "attempt_json">[];
    return rows.map((row) => pptStageAttemptSchema.parse(JSON.parse(row.attempt_json)));
  }
}
