import type { Stats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, win32 } from "node:path";
import { ToolsError } from "./errors";
import { globToRegExp, isAtomicInternalEntry } from "./workspace-glob";
import {
  assertContained,
  assertSafeDirectory,
  captureWorkspacePathGuard,
  sameFileIdentity,
} from "./workspace-path-guard";

export interface WorkspaceScanResult {
  paths: string[];
  truncated: boolean;
}

export function assertRelativeToolPath(path: string): void {
  if (
    !path.trim() ||
    path.length > 4096 ||
    path.includes("\0") ||
    path.includes(":") ||
    isAbsolute(path) ||
    win32.isAbsolute(path)
  )
    throw new ToolsError("INVALID_PATH");
  const portable = path.replace(/\\/g, "/");
  if (portable.split("/").some(isAtomicInternalEntry)) throw new ToolsError("INVALID_PATH");
  const normalized = posix.normalize(portable);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new ToolsError("OUTSIDE_WORKSPACE");
  }
}

export function workspacePattern(pattern: string): RegExp {
  assertRelativeToolPath(pattern);
  if (/[[\]{}]/.test(pattern)) throw new ToolsError("INVALID_INPUT");
  return globToRegExp(posix.normalize(pattern.replace(/\\/g, "/")));
}

export async function scanWorkspace(
  root: string,
  matcher: RegExp,
  maxEntries: number,
  signal: AbortSignal,
): Promise<WorkspaceScanResult> {
  const paths: string[] = [];
  const directories: Array<{ path: string; identity: Stats }> = [
    { path: root, identity: await lstat(root) },
  ];
  let scanned = 0;
  let truncated = false;
  while (directories.length) {
    signal.throwIfAborted();
    const directory = directories.pop()!;
    const guard = await captureWorkspacePathGuard(root, resolve(directory.path, ".scan"), ".");
    const before = await lstat(directory.path);
    assertSafeDirectory(before, directory.path, ".");
    if (!sameFileIdentity(before, directory.identity)) throw new ToolsError("STALE_FILE");
    await guard.validate();
    const entries: Array<{ path: string; stats: Stats }> = [];
    const handle = await opendir(directory.path);
    try {
      while (true) {
        signal.throwIfAborted();
        await guard.validate();
        const entry = await handle.read();
        if (!entry) break;
        if (scanned >= maxEntries) {
          truncated = true;
          break;
        }
        scanned += 1;
        if (isAtomicInternalEntry(entry.name)) continue;
        const absolute = resolve(directory.path, entry.name);
        assertContained(root, absolute, entry.name);
        let stats: Stats;
        try {
          stats = await lstat(absolute);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) continue;
        const canonical = await realpath(absolute);
        assertContained(root, canonical, entry.name);
        const after = await lstat(absolute);
        if (after.isSymbolicLink() || !sameFileIdentity(stats, after))
          throw new ToolsError("STALE_FILE");
        entries.push({ path: absolute, stats });
      }
    } finally {
      await handle.close();
    }
    await guard.validate();
    entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    for (const entry of entries) {
      if (entry.stats.isDirectory()) directories.push({ path: entry.path, identity: entry.stats });
      else {
        const path = relative(root, entry.path).replace(/\\/g, "/");
        if (matcher.test(path)) paths.push(path);
      }
    }
    if (truncated) break;
  }
  paths.sort();
  return { paths, truncated };
}
