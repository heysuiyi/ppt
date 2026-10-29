export interface ConversationEventDO {
  id: number;
  session_id: string;
  run_id: string | null;
  thread_id: string | null;
  sequence: number;
  kind: string;
  visibility: string;
  payload_json: string;
  created_at: string;
}
