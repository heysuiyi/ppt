import type { DatabaseSync } from "node:sqlite";
import type { AppendPptJobEvent } from "./ppt-job-event.dto.ts";

export class PptJobEventMapper {
  constructor(private readonly database: DatabaseSync) {}

  append(input: AppendPptJobEvent): void {
    this.database
      .prepare(`
      INSERT INTO ppt_job_events(
        job_id, state_revision, event_type, payload_json, created_at
      ) VALUES(?, ?, ?, ?, ?)
    `)
      .run(
        input.jobId,
        input.stateRevision,
        input.eventType,
        JSON.stringify(input.payload),
        input.createdAt,
      );
  }
}
