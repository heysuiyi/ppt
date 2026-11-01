import type { PresentationId } from "@shared/presentation-lifecycle";

export type ArtifactChangeObservationSource =
  | "capability_probe"
  | "agent_read"
  | "agent_write"
  | "preview"
  | "submit"
  | "project_read"
  | "project_edit";

export interface ObserveArtifactChangesInput {
  presentationId: PresentationId;
  workspaceRoot: string;
  paths?: readonly string[];
  source: ArtifactChangeObservationSource;
  detectedAt?: string;
}

export interface ArtifactChangeObserverPort {
  observe(input: ObserveArtifactChangesInput): Promise<void>;
}
