import type { DatabaseSync } from "node:sqlite";
import type { PptSideEffectDO } from "./ppt-side-effect.do.ts";
import type {
  CompletePptSideEffect,
  InsertPptSideEffect,
  PptSideEffectKey,
  PptSideEffectRecord,
} from "./ppt-side-effect.dto.ts";

export class PptSideEffectMapper {
  constructor(private readonly database: DatabaseSync) {}

  findByKey(input: PptSideEffectKey): PptSideEffectRecord | undefined {
    const row = this.database
      .prepare(`
      SELECT status, result_json, error FROM ppt_side_effects
      WHERE job_id = ? AND operation = ? AND effect_key = ?
    `)
      .get(input.jobId, input.operation, input.key) as
      | Pick<PptSideEffectDO, "status" | "result_json" | "error">
      | undefined;
    return row
      ? {
          status: row.status,
          result:
            row.status === "succeeded" && row.result_json ? JSON.parse(row.result_json) : undefined,
          error: row.error,
        }
      : undefined;
  }

  insertClaim(input: InsertPptSideEffect): void {
    this.database
      .prepare(`
      INSERT INTO ppt_side_effects(
        job_id, operation, effect_key, status, claimed_at
      ) VALUES(?, ?, ?, 'in_progress', ?)
    `)
      .run(input.jobId, input.operation, input.key, input.claimedAt);
  }

  completeIfInProgress(input: CompletePptSideEffect): boolean {
    const result = this.database
      .prepare(`
      UPDATE ppt_side_effects
      SET status = ?, result_json = ?, error = ?, completed_at = ?
      WHERE job_id = ? AND operation = ? AND effect_key = ?
        AND status = 'in_progress'
    `)
      .run(
        input.status,
        input.result === undefined ? null : JSON.stringify(input.result),
        input.error ?? null,
        input.completedAt,
        input.jobId,
        input.operation,
        input.key,
      );
    return result.changes === 1;
  }
}
