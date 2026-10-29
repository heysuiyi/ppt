export interface PptCapabilityRequestDO {
  request_id: string;
  job_id: string;
  query_id: string | null;
  capability: string;
  request_json: string;
  requested_at: string;
}
