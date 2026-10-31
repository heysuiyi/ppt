import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  type GuardedDirectoryIdentity,
  stalePathError,
  WorkspaceFileError,
  type WorkspacePathGuard,
} from "./workspace-file-types";

export async function resolveContainedWorkspacePath(
  workspaceRoot: string,
  path: string,
): Promise<string> {
  if (!path.trim()) {
    throw new WorkspaceFileError("OUTSIDE_WORKSPACE", "File path is required.");
  }

  const resolvedRoot = resolve(workspaceRoot);
  const rootStats = await lstat(resolvedRoot);
  assertSafeDirectory(rootStats, resolvedRoot, path);
  const candidate = isAbsolute(path) ? resolve(path) : resolve(resolvedRoot, path);
  assertContained(resolvedRoot, candidate, path);

  // Use realpath for containment only. Do not reject when resolve() and realpath()
  // differ: on Windows, 8.3 short names (e.g. GHA TEMP `...\RUNNER~1\...`) expand
  // under realpath without the workspace root being a symlink/junction. Symlink or
  // junction roots are already rejected by assertSafeDirectory via lstat above.
  const canonicalRoot = await realpath(resolvedRoot);
  let cursor = candidate;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonicalAncestor = await realpath(cursor);
      assertContained(canonicalRoot, canonicalAncestor, path);
      const canonicalPath = resolve(canonicalAncestor, ...missingSegments);
      assertContained(canonicalRoot, canonicalPath, path);
      await assertNoSymbolicLinkComponents(resolvedRoot, candidate, path);
      return canonicalPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (cursor === resolvedRoot) throw error;
      missingSegments.unshift(basename(cursor));
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new WorkspaceFileError(
          "OUTSIDE_WORKSPACE",
          `Path is outside the workspace sandbox: ${path}`,
        );
      }
      cursor = parent;
    }
  }
}

export async function captureWorkspacePathGuard(
  workspaceRoot: string,
  absolutePath: string,
  originalPath: string,
): Promise<WorkspacePathGuard> {
  const canonicalRoot = await realpath(resolve(workspaceRoot));
  const parentPath = dirname(absolutePath);
  assertContained(canonicalRoot, parentPath, originalPath);
  const pathFromRoot = relative(canonicalRoot, parentPath);
  const segments =
    pathFromRoot && pathFromRoot !== "." ? pathFromRoot.split(/[\\/]+/).filter(Boolean) : [];
  const paths = [canonicalRoot];
  let cursor = canonicalRoot;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    paths.push(cursor);
  }

  const directories: GuardedDirectoryIdentity[] = [];
  for (const directoryPath of paths) {
    const stats = await lstat(directoryPath);
    assertSafeDirectory(stats, directoryPath, originalPath);
    directories.push({
      path: directoryPath,
      dev: stats.dev,
      ino: stats.ino,
    });
  }

  return {
    canonicalRoot,
    directories,
    async validate() {
      for (const expected of directories) {
        const stats = await lstat(expected.path);
        assertSafeDirectory(stats, expected.path, originalPath);
        if (stats.dev !== expected.dev || stats.ino !== expected.ino) {
          throw stalePathError(
            originalPath,
            `Workspace directory identity changed during commit: ${expected.path}`,
          );
        }
        const canonical = await realpath(expected.path);
        assertContained(canonicalRoot, canonical, originalPath);
        // Identity is already pinned by dev/ino above. Do not treat resolve/realpath
        // string inequality as a junction: Windows 8.3 short names expand under realpath.
      }
    },
  };
}

export async function assertNoSymbolicLinkComponents(
  workspaceRoot: string,
  candidate: string,
  originalPath: string,
): Promise<void> {
  const pathFromRoot = relative(resolve(workspaceRoot), candidate);
  if (!pathFromRoot || pathFromRoot === ".") return;
  let cursor = resolve(workspaceRoot);
  const segments = pathFromRoot.split(/[\\/]+/).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    cursor = resolve(cursor, segments[index]!);
    let stats: Stats;
    try {
      stats = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new WorkspaceFileError(
        "UNSAFE_FILE_TYPE",
        `Symbolic links and junctions are not allowed in workspace file paths: ${originalPath}`,
      );
    }
    const isLast = index === segments.length - 1;
    if (!isLast && !stats.isDirectory()) {
      throw new WorkspaceFileError(
        "UNSAFE_FILE_TYPE",
        `Non-directory path component is not allowed: ${originalPath}`,
      );
    }
    if (isLast && !stats.isDirectory() && !stats.isFile()) {
      throw new WorkspaceFileError(
        "UNSAFE_FILE_TYPE",
        `Special files are not supported: ${originalPath}`,
      );
    }
  }
}

export function assertSafeDirectory(
  stats: Stats,
  absolutePath: string,
  originalPath: string,
): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new WorkspaceFileError(
      "UNSAFE_FILE_TYPE",
      `Unsafe workspace directory for ${originalPath}: ${absolutePath}`,
    );
  }
}

export function assertContained(root: string, target: string, originalPath: string): void {
  if (isOutside(root, target)) {
    throw new WorkspaceFileError(
      "OUTSIDE_WORKSPACE",
      `Path is outside the workspace sandbox: ${originalPath}`,
    );
  }
}

export function isOutside(root: string, target: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(root, target));
  return pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot);
}

export function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function sameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
