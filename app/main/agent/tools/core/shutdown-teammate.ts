import { z } from "zod";
import type { ProtocolState } from "../../teammate/protocol-state";
import type { TeammateHandle } from "../../teammate/spawn-teammate";
import type { ToolDefinition } from "../tool-definition";

export const shutdownTeammateSchema = z.object({
  name: z.string().describe("Existing teammate name to ask to stop"),
  reason: z.string().optional().describe("Why lead is asking the teammate to stop"),
});

export type ShutdownTeammateToolResult = {
  teammate: TeammateHandle;
  request: ProtocolState;
  message: string;
};

export const shutdownTeammateTool: ToolDefinition<
  typeof shutdownTeammateSchema,
  ShutdownTeammateToolResult
> = {
  name: "shutdown_teammate",
  description: "Ask an existing long-lived teammate agent to stop cleanly.",
  category: "core",
  loadPolicy: "core",
  inputSchema: shutdownTeammateSchema,
  risk: "low",
  permission: {
    profile: "teammate-shutdown",
    description: "Request graceful shutdown for an existing teammate.",
    scopes: ["main"],
    effects: ["workflow.delegate"],
    sandbox: "workspace",
    approval: "never",
  },
  async execute(args, context) {
    if (!context.teammateManager) {
      throw new Error("Teammate manager is not configured.");
    }

    const request = await context.teammateManager.requestShutdown(args.name, args.reason);
    const teammate = context.teammateManager.get(args.name);
    if (!teammate) {
      throw new Error(`Unknown teammate: ${args.name}`);
    }

    return {
      teammate,
      request,
      message: `Requested graceful shutdown for ${teammate.name}; ${request.requestId} is pending acknowledgement.`,
    };
  },
};
