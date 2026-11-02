import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCheckpoint } from "@agent-harness/core/session/session-contract";
import { prepareWorkspaceRoot } from "@agent-harness/tools/tools";
import type { HostSessionBinding } from "./host-session-binding.js";
import type { HostSessionSummary } from "./session-persistence-contract.js";
import {
  readSqliteAgentSessions,
  readSqliteHostBinding,
  readSqliteHostCheckpoint,
} from "./sqlite-session-queries.js";

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

/** 仅宿主读取恢复事实，不将检查点交给终端或 renderer。 */
export async function readHostCheckpoint(
  dataRoot: string,
  workspaceRoot: string,
  threadId: string,
): Promise<AgentCheckpoint | undefined> {
  const canonicalRoot = await prepareWorkspaceRoot(workspaceRoot);
  const filePath = join(dataRoot, "sessions.sqlite");
  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return readSqliteHostCheckpoint(filePath, canonicalRoot, threadId);
}

/** 默认策略变化不改写旧会话的执行定义；只从当前工作区权威绑定恢复。 */
export async function readHostSessionBinding(
  dataRoot: string,
  workspaceRoot: string,
  threadId: string,
): Promise<HostSessionBinding | undefined> {
  const canonicalRoot = await prepareWorkspaceRoot(workspaceRoot);
  const filePath = join(dataRoot, "sessions.sqlite");
  try {
    await stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return readSqliteHostBinding(filePath, canonicalRoot, threadId);
}
