import type { ArtifactDependency, ArtifactRevisionId } from "@shared/presentation-lifecycle";

export interface InsertArtifactDependencies {
  revisionId: ArtifactRevisionId;
  dependencies: ArtifactDependency[];
}
