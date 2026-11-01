import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ToolsError } from "../tools-errors.js";
import { assertSafeDirectory, sameFileIdentity } from "./files/workspace-path-guard.js";

export async function prepareWorkspaceRoot(root: string): Promise<string> {
  if (typeof root !== "string" || !root.trim() || root.includes("\0")) {
    throw new ToolsError("INVALID_OPTIONS");
  }
  try {
    const path = resolve(root);
    const before = await lstat(path);
    assertSafeDirectory(before, path, ".");
    const canonical = await realpath(path);
    const after = await lstat(path);
    assertSafeDirectory(after, path, ".");
    if (!sameFileIdentity(before, after)) throw new ToolsError("STALE_FILE");
    return canonical;
  } catch {
    throw new ToolsError("INVALID_WORKSPACE");
  }
}
