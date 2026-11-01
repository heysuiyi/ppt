import type { DatabaseSync } from "node:sqlite";
import {
  type PptProposal,
  type ProposalId,
  pptProposalSchema,
} from "@shared/presentation-lifecycle";
import type { PptProposalDO } from "./ppt-proposal.do.ts";

export class PptProposalMapper {
  constructor(private readonly database: DatabaseSync) {}

  insert(proposal: PptProposal): void {
    this.database
      .prepare(`
      INSERT INTO ppt_proposals(
        proposal_id, job_id, status, proposal_json, created_at, resolved_at
      ) VALUES(?, ?, ?, ?, ?, NULL)
    `)
      .run(
        proposal.proposalId,
        proposal.jobId,
        proposal.status,
        JSON.stringify(proposal),
        proposal.createdAt,
      );
  }

  findById(proposalId: ProposalId): PptProposal | undefined {
    const row = this.database
      .prepare("SELECT proposal_json FROM ppt_proposals WHERE proposal_id = ?")
      .get(proposalId) as Pick<PptProposalDO, "proposal_json"> | undefined;
    return row ? pptProposalSchema.parse(JSON.parse(row.proposal_json)) : undefined;
  }

  updateIfWaitingApproval(proposal: PptProposal): boolean {
    const result = this.database
      .prepare(`
      UPDATE ppt_proposals
      SET status = ?, proposal_json = ?, resolved_at = ?
      WHERE proposal_id = ? AND status = 'waiting_approval'
    `)
      .run(proposal.status, JSON.stringify(proposal), proposal.resolvedAt!, proposal.proposalId);
    return result.changes === 1;
  }
}
