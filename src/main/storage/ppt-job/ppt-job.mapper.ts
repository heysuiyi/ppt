import type { DatabaseSync } from "node:sqlite";
import {
  type PptJobId,
  type PptJobState,
  type PresentationId,
  pptJobStateSchema,
} from "@shared/presentation-lifecycle";
import type { PptJobDO } from "./ppt-job.do";

export class PptJobMapper {
  constructor(private readonly database: DatabaseSync) {}

  insert(state: PptJobState): void {
    this.database
      .prepare(`
      INSERT INTO ppt_jobs(
        job_id, project_id, presentation_id, state_revision,
        state_json, created_at, updated_at
      ) VALUES(?, ?, ?, 0, ?, ?, ?)
    `)
      .run(
        state.jobId,
        state.params.projectId,
        state.params.presentationId,
        JSON.stringify(state),
        state.createdAt,
        state.updatedAt,
      );
  }

  findById(jobId: PptJobId): PptJobState | undefined {
    const row = this.database
      .prepare("SELECT state_json FROM ppt_jobs WHERE job_id = ?")
      .get(jobId) as Pick<PptJobDO, "state_json"> | undefined;
    return row ? pptJobStateSchema.parse(JSON.parse(row.state_json)) : undefined;
  }

  findByPresentationId(presentationId: PresentationId): PptJobState | undefined {
    const row = this.database
      .prepare("SELECT state_json FROM ppt_jobs WHERE presentation_id = ?")
      .get(presentationId) as Pick<PptJobDO, "state_json"> | undefined;
    return row ? pptJobStateSchema.parse(JSON.parse(row.state_json)) : undefined;
  }

  updateStateIfRevision(state: PptJobState, expectedStateRevision: number): boolean {
    const result = this.database
      .prepare(`
      UPDATE ppt_jobs
      SET state_revision = ?, state_json = ?, updated_at = ?
      WHERE job_id = ? AND state_revision = ?
    `)
      .run(
        state.stateRevision,
        JSON.stringify(state),
        state.updatedAt,
        state.jobId,
        expectedStateRevision,
      );
    return result.changes === 1;
  }
}
