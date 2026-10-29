export interface PptSideEffectDO {
  job_id: string;
  operation: string;
  effect_key: string;
  status: string;
  result_json: string | null;
  error: string | null;
  claimed_at: string;
  completed_at: string | null;
}
