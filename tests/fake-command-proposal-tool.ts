import { z } from "zod";
import {
  type AgentCommandProposalResult,
  agentCommandProposalResultSchema,
} from "../app/main/agent/runtime/runtime-types";
import { assumptionsSchema } from "../app/main/agent/tools/assumptions-schema";
import type { ToolDefinition } from "../app/main/agent/tools/tool-definition";
import { presentationCommandSchema } from "../src/shared/commands";

/** Minimal terminal command_proposal tool for runtime-loop tests. */
export const fakeCommandProposalSchema = z.object({
  summary: z.string().trim().min(1),
  commands: z.array(presentationCommandSchema).min(1),
  risk: z.enum(["low", "medium", "high"]).default("low"),
  assumptions: assumptionsSchema,
});

export function createFakeCommandProposalTool(
  name = "FakeSubmitCommands",
): ToolDefinition<typeof fakeCommandProposalSchema, AgentCommandProposalResult> {
  return {
    name,
    description: "Test-only terminal command proposal tool.",
    category: "core",
    loadPolicy: "core",
    inputSchema: fakeCommandProposalSchema,
    outputSchema: agentCommandProposalResultSchema,
    behavior: {
      capabilities: ["command_proposal"],
      completion: {
        terminalResult: "command_proposal",
        expectation: "always",
        exclusiveBatch: true,
      },
    },
    risk: "low",
    execute: async (args) => ({
      type: "command_proposal",
      summary: args.summary,
      commands: args.commands,
      risk: args.risk,
      assumptions: args.assumptions,
    }),
  };
}
