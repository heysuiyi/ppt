import type { ProjectArtifact } from "@shared/session";

export function findArtifactByProjectPath(
  artifacts: ProjectArtifact[],
  relativePath: string,
): ProjectArtifact | undefined {
  const normalizedPath = normalizeProjectPath(relativePath);
  return artifacts.find((artifact) => {
    const artifactPath = normalizeProjectPath(artifact.path);
    if (artifact.path.endsWith("/")) {
      return normalizedPath === artifactPath || normalizedPath.startsWith(`${artifactPath}/`);
    }
    return normalizedPath === artifactPath;
  });
}

function normalizeProjectPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}
