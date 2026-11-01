import type { DatabaseSync } from "node:sqlite";
import { PptArtifactDependencyMapper } from "./ppt-artifact-dependency/ppt-artifact-dependency.mapper";
import { PptArtifactHeadMapper } from "./ppt-artifact-head/ppt-artifact-head.mapper";
import { PptArtifactRevisionMapper } from "./ppt-artifact-revision/ppt-artifact-revision.mapper";
import { PptCapabilityRequestMapper } from "./ppt-capability-request/ppt-capability-request.mapper";
import { PptJobMapper } from "./ppt-job/ppt-job.mapper";
import { PptJobEventMapper } from "./ppt-job-event/ppt-job-event.mapper";
import { PptProposalMapper } from "./ppt-proposal/ppt-proposal.mapper";
import { PptSideEffectMapper } from "./ppt-side-effect/ppt-side-effect.mapper";
import { PptStageAttemptMapper } from "./ppt-stage-attempt/ppt-stage-attempt.mapper";

export interface PresentationMappers {
  readonly pptJobs: PptJobMapper;
  readonly pptCapabilityRequests: PptCapabilityRequestMapper;
  readonly pptArtifactRevisions: PptArtifactRevisionMapper;
  readonly pptArtifactDependencies: PptArtifactDependencyMapper;
  readonly pptArtifactHeads: PptArtifactHeadMapper;
  readonly pptStageAttempts: PptStageAttemptMapper;
  readonly pptProposals: PptProposalMapper;
  readonly pptSideEffects: PptSideEffectMapper;
  readonly pptJobEvents: PptJobEventMapper;
}

export function createPresentationMappers(database: DatabaseSync): PresentationMappers {
  return {
    pptJobs: new PptJobMapper(database),
    pptCapabilityRequests: new PptCapabilityRequestMapper(database),
    pptArtifactRevisions: new PptArtifactRevisionMapper(database),
    pptArtifactDependencies: new PptArtifactDependencyMapper(database),
    pptArtifactHeads: new PptArtifactHeadMapper(database),
    pptStageAttempts: new PptStageAttemptMapper(database),
    pptProposals: new PptProposalMapper(database),
    pptSideEffects: new PptSideEffectMapper(database),
    pptJobEvents: new PptJobEventMapper(database),
  };
}
