export interface PptProposalDO {
  proposal_id: string;
  job_id: string;
  status: string;
  proposal_json: string;
  created_at: string;
  resolved_at: string | null;
}
