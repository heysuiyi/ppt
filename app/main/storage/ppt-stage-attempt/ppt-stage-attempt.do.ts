export interface PptStageAttemptDO {
  stage_run_id: string;
  job_id: string;
  stage: string;
  attempt: number;
  status: string;
  idempotency_key: string;
  attempt_json: string;
  started_at: string;
  completed_at: string | null;
}
