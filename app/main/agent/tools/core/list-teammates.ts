import { z } from "zod";
import type { TeammateHandle } from "../../teammate/spawn-teammate";
import type { ToolDefinition } from "../tool-definition";

export const listTeammatesSchema = z.object({});

export type ListTeammatesToolResult = {
  teammates: TeammateHandle[];
};

export const listTeammatesTool: ToolDefinition<
  typeof listTeammatesSchema,
  ListTeammatesToolResult
> = {
  name: "list_teammates",
  description:
    "List long-lived teammate agents in this session with their role, status, and activity timestamps.",
  category: "core",
  loadPolicy: "core",
  inputSchema: listTeammatesSchema,
  risk: "low",
  permission: {
    profile: "teammate-list",
    description: "List current teammate handles for this session.",
    scopes: ["main"],
    effects: [],
    sandbox: "none",
    approval: "never",
  },
  async execute(_args, context) {
    if (!context.teammateManager) {
      throw new Error("Teammate manager is not configured.");
    }
    return {
      teammates: context.teammateManager.list(),
    };
  },
};
