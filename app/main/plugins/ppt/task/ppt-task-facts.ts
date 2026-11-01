import type {
  WorkspaceArtifactProbeDetails,
  WorkspaceArtifacts,
} from "../presentation/workspace-artifacts";
import type { TaskFacts } from "./ppt-task-types";

function verified(
  details: WorkspaceArtifactProbeDetails | undefined,
  key: keyof WorkspaceArtifactProbeDetails,
  artifacts: WorkspaceArtifacts | undefined,
): boolean {
  if (details?.[key]?.verified) return true;
  return Boolean(artifacts?.[key]);
}

export function hasTeammateCapability(
  availableTools: readonly string[],
  teammateCapabilities: readonly string[],
): boolean {
  if (teammateCapabilities.some((item) => item.trim())) return true;
  return availableTools.some((name) => name === "SpawnTeammate" || name === "SendTeammateMessage");
}

export function deriveTaskFacts(input: {
  queryId: string;
  inputRevision: string;
  artifacts?: WorkspaceArtifacts;
  artifactDetails?: WorkspaceArtifactProbeDetails;
  availableTools?: readonly string[];
  teammateCapabilities?: readonly string[];
  staleRefs?: readonly string[];
}): TaskFacts {
  const details = input.artifactDetails;
  const artifacts = input.artifacts;
  return {
    queryId: input.queryId,
    inputRevision: input.inputRevision,
    hasDesign: verified(details, "designSpec", artifacts),
    hasPlan: verified(details, "pagePlan", artifacts),
    hasPages: verified(details, "pageSvg", artifacts),
    canDelegate: hasTeammateCapability(
      input.availableTools ?? [],
      input.teammateCapabilities ?? [],
    ),
    hasStaleEvidence: (input.staleRefs?.length ?? 0) > 0,
  };
}
