import { isAbsolute, relative, resolve } from "node:path";

/**
 * Resolves a tool path relative to the workspace root, or as an absolute path.
 * Outside-workspace access is gated by permission-check before execution.
 */
export function resolveAgentPath(workspaceRoot: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    return resolve(relativePath);
  }
  const root = resolve(workspaceRoot);
  return resolve(root, relativePath);
}

/** Returns true when the resolved path escapes the workspace sandbox. */
export function isOutsideWorkspace(workspaceRoot: string, path: string): boolean {
  if (!path.trim()) return false;
  if (isAbsolute(path)) {
    const root = resolve(workspaceRoot);
    const filePath = resolve(path);
    const pathFromRoot = relative(root, filePath);
    return pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot);
  }
  const root = resolve(workspaceRoot);
  const filePath = resolve(root, path);
  const pathFromRoot = relative(root, filePath);
  return pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot);
}

/** @deprecated Prefer resolveAgentPath; kept for callers that need strict sandbox errors. */
export function resolveWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const filePath = resolveAgentPath(workspaceRoot, relativePath);
  if (isOutsideWorkspace(workspaceRoot, relativePath)) {
    throw new Error(`Path is outside the workspace sandbox: ${relativePath}`);
  }
  return filePath;
}
