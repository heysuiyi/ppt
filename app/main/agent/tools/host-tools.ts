import { askUserTool } from "./core/ask-user";
import { listTeammatesTool } from "./core/list-teammates";
import { loadSkillTool } from "./core/load-skill";
import { respondPlanApprovalTool } from "./core/respond-plan-approval";
import { sendTeammateMessageTool } from "./core/send-teammate-message";
import { shutdownTeammateTool } from "./core/shutdown-teammate";
import { spawnTeammateTool } from "./core/spawn-teammate";
import { taskTools } from "./core/task-tools";
import { webSearchTool } from "./core/web-search";
import { workspaceFileTools } from "./core/workspace-files";
import type { ToolDefinition } from "./tool-definition";
import { ToolRegistry } from "./tool-registry";

export const hostTools: readonly ToolDefinition[] = [
  askUserTool,
  listTeammatesTool,
  respondPlanApprovalTool,
  sendTeammateMessageTool,
  shutdownTeammateTool,
  spawnTeammateTool,
  ...taskTools,
  loadSkillTool,
  webSearchTool,
];

export function createHostToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [...hostTools, ...workspaceFileTools]) registry.register(tool);
  return registry;
}
