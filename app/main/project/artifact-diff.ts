export interface ArtifactDiff {
  path: string;
  before: string;
  after: string;
  changed: boolean;
  unifiedDiff: string;
}

export function createArtifactDiff(path: string, before: string, after: string): ArtifactDiff {
  return {
    path,
    before,
    after,
    changed: before !== after,
    unifiedDiff: before === after ? "" : createUnifiedDiff(path, before, after),
  };
}

function createUnifiedDiff(path: string, before: string, after: string): string {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const lines = [`--- a/${path}`, `+++ b/${path}`];

  for (const line of beforeLines) {
    lines.push(`-${line}`);
  }
  for (const line of afterLines) {
    lines.push(`+${line}`);
  }

  return `${lines.join("\n")}\n`;
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  return content.replace(/\r\n/g, "\n").split("\n");
}
