import type { DatabaseSync } from "node:sqlite";
import type { InsertArtifactDependencies } from "./ppt-artifact-dependency.dto";

export class PptArtifactDependencyMapper {
  constructor(private readonly database: DatabaseSync) {}

  insertForRevision(input: InsertArtifactDependencies): void {
    const statement = this.database.prepare(`
      INSERT INTO ppt_artifact_dependencies(
        artifact_revision_id, dependency_artifact_id,
        dependency_revision_id, dependency_content_hash
      ) VALUES(?, ?, ?, ?)
    `);
    for (const dependency of input.dependencies) {
      statement.run(
        input.revisionId,
        dependency.artifactId,
        dependency.revisionId,
        dependency.contentHash,
      );
    }
  }
}
