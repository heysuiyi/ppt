import { stat } from "node:fs/promises";
import { join } from "node:path";
import { prepareWorkspaceRoot } from "@agent-harness/tools/tools";
import type { HostSessionSummary } from "./session-persistence-contract.js";
import { readSqliteAgentSessions } from "./sqlite-session-queries.js";

/** 查询只打开已有数据库；首次启动不会创建目录、存储或检查点租约。 */
export async function listHostSessions(
  dataRoot: string,
  workspaceRoot: string,
): Promise<readonly HostSessionSummary[]> {
  const canonicalWorkspaceRoot = await prepareWorkspaceRoot(workspaceRoot);
  const filePath = join(dataRoot, "sessions.sqlite");
  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return readSqliteAgentSessions(filePath, canonicalWorkspaceRoot);
}
