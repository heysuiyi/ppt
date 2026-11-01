import type { Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { AtomicFileIdentity } from "./atomic.js";
import { WorkspaceFileError } from "./workspace-file-contract.js";
import { stalePathError } from "./workspace-file-types.js";
import {
  assertContained,
  assertSafeDirectory,
  isOutside,
  sameFileIdentity,
} from "./workspace-path-guard.js";

export async function globWorkspaceFiles(
  workspaceRoot: string,
  pattern: string,
): Promise<string[]> {
  if (isOutside(workspaceRoot, patternPrefix(pattern))) {
    throw new WorkspaceFileError(
      "OUTSIDE_WORKSPACE",
      `Path is outside the workspace sandbox: ${pattern}`,
    );
  }

  const matcher = globToRegExp(pattern.replace(/\\/g, "/"));
  const results: string[] = [];
  const resolvedRoot = resolve(workspaceRoot);
  const rootStats = await lstat(resolvedRoot);
  assertSafeDirectory(rootStats, resolvedRoot, pattern);
  // See resolveContainedWorkspacePath: reject symlink/junction roots via lstat only.
  // resolve() vs realpath() string inequality is not a reliable junction signal on Windows.
  const canonicalRoot = await realpath(resolvedRoot);

  async function walk(relativeDir: string, expectedIdentity?: AtomicFileIdentity): Promise<void> {
    const absoluteDir = resolve(canonicalRoot, relativeDir || ".");
    assertContained(canonicalRoot, absoluteDir, pattern);
    const directoryIdentity = await validateGlobDirectory(
      canonicalRoot,
      absoluteDir,
      pattern,
      expectedIdentity,
    );
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    await validateGlobDirectory(canonicalRoot, absoluteDir, pattern, directoryIdentity);
    for (const entry of entries) {
      await validateGlobDirectory(canonicalRoot, absoluteDir, pattern, directoryIdentity);
      if (isAtomicInternalEntry(entry.name)) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolutePath = resolve(canonicalRoot, relativePath);
      assertContained(canonicalRoot, absolutePath, pattern);
      let stats: Stats;
      try {
        stats = await lstat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (stats.isSymbolicLink()) continue;
      const canonicalPath = await realpath(absolutePath);
      assertContained(canonicalRoot, canonicalPath, pattern);
      if (stats.isDirectory()) {
        await walk(relativePath, { dev: stats.dev, ino: stats.ino });
        continue;
      }
      if (!stats.isFile()) continue;
      const verified = await lstat(absolutePath);
      if (verified.isSymbolicLink() || !verified.isFile() || !sameFileIdentity(stats, verified)) {
        throw stalePathError(
          relativePath,
          "File identity changed while glob results were collected.",
        );
      }
      const normalized = relativePath.replace(/\\/g, "/");
      if (matcher.test(normalized)) {
        results.push(normalized);
      }
    }
    await validateGlobDirectory(canonicalRoot, absoluteDir, pattern, directoryIdentity);
  }

  await walk("");
  return results.sort((left, right) => left.localeCompare(right));
}

export function isAtomicInternalEntry(name: string): boolean {
  return (
    name.includes(".atomic-old.") ||
    name.includes(".atomic-replace.json") ||
    /^\..+\.\d+\.[a-f0-9-]+\.tmp$/i.test(name)
  );
}

async function validateGlobDirectory(
  canonicalRoot: string,
  directoryPath: string,
  originalPattern: string,
  expectedIdentity?: AtomicFileIdentity,
): Promise<AtomicFileIdentity> {
  const stats = await lstat(directoryPath);
  assertSafeDirectory(stats, directoryPath, originalPattern);
  if (expectedIdentity && !sameFileIdentity(expectedIdentity, stats)) {
    throw stalePathError(
      originalPattern,
      `Directory identity changed while glob was traversing: ${directoryPath}.`,
    );
  }
  const canonicalPath = await realpath(directoryPath);
  assertContained(canonicalRoot, canonicalPath, originalPattern);
  return { dev: stats.dev, ino: stats.ino };
}

function patternPrefix(pattern: string): string {
  const normalized = pattern.replace(/\\/g, "/");
  const wildcard = normalized.search(/[*?[\]{}]/);
  return wildcard < 0 ? normalized : normalized.slice(0, wildcard);
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        // `**/` spans zero or more directories, so **/*.md also matches
        // workspace-root files instead of requiring at least one slash.
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`);
}
