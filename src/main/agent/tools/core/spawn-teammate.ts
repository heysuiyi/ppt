import { z } from "zod";
import { sanitizeAgentName } from "../../teammate/message-bus";
import type { ToolDefinition } from "../tool-definition";

export const spawnTeammateSchema = z.object({
  name: z.string().optional().describe("Stable teammate name, e.g. researcher or fact_checker"),
  role: z.string().describe("Short teammate role, e.g. researcher, editor, layout planner"),
  prompt: z.string().describe("Initial task prompt for the teammate"),
});

export type SpawnTeammateToolResult = {
  name: string;
  role: string;
  status: "running" | "idle" | "stopped" | "failed";
  message: string;
};

export const spawnTeammateTool: ToolDefinition<
  typeof spawnTeammateSchema,
  SpawnTeammateToolResult
> = {
  name: "spawn_teammate",
  description:
    "Start a long-lived teammate agent in the shared workspace. " +
    "The teammate runs asynchronously, can send messages through the inbox, and reports results back to lead.",
  category: "core",
  loadPolicy: "core",
  inputSchema: spawnTeammateSchema,
  risk: "low",
  permission: {
    profile: "teammate-spawn",
    description: "Delegate work to a long-lived teammate agent.",
    scopes: ["main"],
    effects: ["workflow.delegate"],
    sandbox: "workspace",
    approval: "never",
  },
  async execute(args, context) {
    if (!context.workspaceRoot) {
      throw new Error("Workspace root is not configured for teammate agents.");
    }
    if (!context.gateway) {
      throw new Error("Model gateway is not configured for teammate agents.");
    }
    if (!context.teammateManager) {
      throw new Error("Teammate manager is not configured.");
    }

    const trimmedRole = args.role.trim().toLowerCase();
    const roleName = trimmedRole ? sanitizeAgentName(trimmedRole) : "teammate";
    const fallbackName = sanitizeAgentName(`${roleName}_${crypto.randomUUID().slice(0, 8)}`);
    const handle = context.teammateManager.spawn({
      name: args.name?.trim() || fallbackName,
      role: args.role,
      prompt: args.prompt,
      workspaceRoot: context.workspaceRoot,
      gateway: context.gateway,
      model: context.model,
      agentStepLimits: context.agentStepLimits,
      onTaskListUpdated: context.notifyTaskListUpdated,
      onProgress: context.onTeammateProgress,
      taskStore: context.taskStore,
      skillRegistry: context.skillRegistry,
      filePolicy: context.filePolicy,
      domain: context.teammateDomain,
    });

    return {
      name: handle.name,
      role: handle.role,
      status: handle.status,
      message: `Started teammate ${handle.name} (${handle.role}). Results will arrive in lead inbox.`,
    };
  },
};
