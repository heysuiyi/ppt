import type { PptJobProjection } from "@shared/presentation-lifecycle";
import {
  CAPABILITY_LABELS,
  JOB_STATUS_LABELS,
  PROPOSAL_STATUS_LABELS,
  STAGE_LABELS,
} from "./pptJobLabels";

interface PptJobStatusBarProps {
  pptJob: PptJobProjection;
}

export function PptJobStatusBar({ pptJob }: PptJobStatusBarProps) {
  return (
    <div
      className={`ppt-job-status-bar is-${pptJob.status}`}
      role="status"
      aria-label="演示文稿任务状态"
    >
      <span className="ppt-job-status-bar__label">演示任务</span>
      <strong>{JOB_STATUS_LABELS[pptJob.status]}</strong>
      <span>{CAPABILITY_LABELS[pptJob.capability]}</span>
      <span>阶段：{STAGE_LABELS[pptJob.stage]}</span>
      {pptJob.proposalId && pptJob.proposalStatus ? (
        <span>提案：{PROPOSAL_STATUS_LABELS[pptJob.proposalStatus]}</span>
      ) : null}
      {pptJob.waitingReason ? (
        <span className="ppt-job-status-bar__reason">{pptJob.waitingReason}</span>
      ) : null}
      {pptJob.staleArtifacts.length > 0 ? (
        <span className="ppt-job-status-bar__stale">
          {pptJob.staleArtifacts.length} 个产物待更新
        </span>
      ) : null}
    </div>
  );
}
