import type { DatabaseSync } from "node:sqlite";
import {
  type ArtifactRevision,
  type ArtifactRevisionId,
  artifactRevisionSchema,
  type PptJobId,
} from "@shared/presentation-lifecycle";
import type { PptArtifactRevisionDO } from "./ppt-artifact-revision.do.ts";

export function decodeArtifactRevision(
  row: Pick<PptArtifactRevisionDO, "revision_json">,
): ArtifactRevision {
  return artifactRevisionSchema.parse(JSON.parse(row.revision_json));
}

export class PptArtifactRevisionMapper {
  constructor(private readonly database: DatabaseSync) {}

  findById(revisionId: ArtifactRevisionId): ArtifactRevision | undefined {
    const row = this.database
      .prepare("SELECT revision_json FROM ppt_artifact_revisions WHERE revision_id = ?")
      .get(revisionId) as Pick<PptArtifactRevisionDO, "revision_json"> | undefined;
    return row ? decodeArtifactRevision(row) : undefined;
  }

  findByIdempotency(jobId: PptJobId, idempotencyKey: string): ArtifactRevision | undefined {
    const row = this.database
      .prepare(`
      SELECT revision_json FROM ppt_artifact_revisions
      WHERE job_id = ? AND idempotency_key = ?
    `)
      .get(jobId, idempotencyKey) as Pick<PptArtifactRevisionDO, "revision_json"> | undefined;
    return row ? decodeArtifactRevision(row) : undefined;
  }

  insert(revision: ArtifactRevision, idempotencyKey: string): void {
    this.database
      .prepare(`
      INSERT INTO ppt_artifact_revisions(
        revision_id, artifact_id, job_id, kind, stage, schema_version,
        content_hash, revision_json, idempotency_key, committed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        revision.revisionId,
        revision.artifactId,
        revision.jobId,
        revision.kind,
        revision.stage,
        revision.schemaVersion,
        revision.contentHash,
        JSON.stringify(revision),
        idempotencyKey,
        revision.committedAt,
      );
  }

  listByJob(jobId: PptJobId): ArtifactRevision[] {
    const rows = this.database
      .prepare(`
      SELECT revision_json FROM ppt_artifact_revisions
      WHERE job_id = ? ORDER BY committed_at, revision_id
    `)
      .all(jobId) as unknown as Pick<PptArtifactRevisionDO, "revision_json">[];
    return rows.map(decodeArtifactRevision);
  }
}
