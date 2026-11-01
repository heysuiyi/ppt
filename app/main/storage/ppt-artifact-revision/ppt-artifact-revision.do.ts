export interface PptArtifactRevisionDO {
  revision_id: string;
  artifact_id: string;
  job_id: string;
  kind: string;
  stage: string;
  schema_version: number;
  content_hash: string;
  revision_json: string;
  idempotency_key: string;
  committed_at: string;
}
