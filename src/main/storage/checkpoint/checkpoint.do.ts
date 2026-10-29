export interface CheckpointDO {
  thread_id: string;
  run_id: string | null;
  active_run_id: string | null;
  writer_generation: number;
  writer_revision: number;
  checkpoint_json: string;
  lease_updated_at: string | null;
  updated_at: string;
}
