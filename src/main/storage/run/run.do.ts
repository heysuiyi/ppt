import type { RunStatus } from "./run.dto";

export interface RunDO {
  run_id: string;
  session_id: string;
  thread_id: string | null;
  query_id: string | null;
  provider: string | null;
  model: string | null;
  status: RunStatus;
  request_text: string | null;
  result_json: string | null;
  error: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}
