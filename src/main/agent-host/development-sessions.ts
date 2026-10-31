import { stat } from "node:fs/promises";
import { join } from "node:path";
import { prepareWorkspaceRoot } from "../../tools/internal/workspace";
import { type HostSessionSummary, readSqliteAgentSessions } from "./sqlite-agent-stores";

export type DevelopmentSessionSummary = HostSessionSummary;

/** 查询只打开已有数据库；首次启动不会创建目录、存储或检查点租约。 */
export async function listDevelopmentSessions(
  applicationDataRoot: string,
  workspaceRoot: string,
): Promise<readonly DevelopmentSessionSummary[]> {
  const canonicalWorkspaceRoot = await prepareWorkspaceRoot(workspaceRoot);
  const filePath = join(applicationDataRoot, "agent-development.sqlite");
  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return readSqliteAgentSessions(filePath, canonicalWorkspaceRoot);
}
