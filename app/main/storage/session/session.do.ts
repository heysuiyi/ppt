export interface SessionDO {
  id: string;
  ordinal: number;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
  workspace_path: string | null;
}
