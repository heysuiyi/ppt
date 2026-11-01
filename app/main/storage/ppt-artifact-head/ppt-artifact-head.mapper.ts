import type { DatabaseSync } from "node:sqlite";
import type {
  ArtifactId,
  ArtifactRevision,
  ArtifactRevisionId,
  PptJobId,
} from "@shared/presentation-lifecycle";
import type { PptArtifactRevisionDO } from "../ppt-artifact-revision/ppt-artifact-revision.do.ts";
import { decodeArtifactRevision } from "../ppt-artifact-revision/ppt-artifact-revision.mapper";
import type { PptArtifactHeadDO } from "./ppt-artifact-head.do.ts";

export class PptArtifactHeadMapper {
  constructor(private readonly database: DatabaseSync) {}

  upsert(jobId: PptJobId, artifactId: ArtifactId, revisionId: ArtifactRevisionId): void {
    this.database
      .prepare(`
      INSERT INTO ppt_artifact_heads(job_id, artifact_id, revision_id)
      VALUES(?, ?, ?)
      ON CONFLICT(job_id, artifact_id)
      DO UPDATE SET revision_id = excluded.revision_id
    `)
      .run(jobId, artifactId, revisionId);
  }

  findRevisionId(jobId: PptJobId, artifactId: ArtifactId): ArtifactRevisionId | undefined {
    const row = this.database
      .prepare(`
      SELECT revision_id FROM ppt_artifact_heads
      WHERE job_id = ? AND artifact_id = ?
    `)
      .get(jobId, artifactId) as Pick<PptArtifactHeadDO, "revision_id"> | undefined;
    return row?.revision_id as ArtifactRevisionId | undefined;
  }

  listRevisionsByJob(jobId: PptJobId): ArtifactRevision[] {
    const rows = this.database
      .prepare(`
      SELECT r.revision_json
      FROM ppt_artifact_heads h
      JOIN ppt_artifact_revisions r ON r.revision_id = h.revision_id
      WHERE h.job_id = ?
      ORDER BY r.committed_at, r.revision_id
    `)
      .all(jobId) as unknown as Pick<PptArtifactRevisionDO, "revision_json">[];
    return rows.map(decodeArtifactRevision);
  }
}
