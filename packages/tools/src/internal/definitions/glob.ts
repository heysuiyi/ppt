import type {
  ImmediateToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "@agent-harness/core/tools/tool-contract";

import { z } from "zod";
import type { GlobInput, GlobOutput } from "../../tools-contract.js";

export const globInputSchema = z
  .object({
    pattern: z.string().min(1).max(4096),
    limit: z.number().int().min(1).max(1000).default(200),
  })
  .strict();

export const globOutputSchema = z
  .object({
    matches: z.array(z.string().min(1).max(4096)).max(1000),
    truncated: z.boolean(),
  })
  .strict();

export function createGlob(
  handler: (input: GlobInput, context: ToolExecutionContext) => Promise<ToolResult<GlobOutput>>,
): ImmediateToolDefinition<GlobInput, GlobOutput> {
  return {
    name: "glob",
    owner: "tools",
    version: "1",
    mode: "immediate",
    description:
      "Find regular files using a workspace-relative glob supporting only *, ** and ?. Returns sorted matches from bounded traversal; truncated means the search was incomplete. Links and internal atomic artifacts are skipped. Listing does not count as reading files for mutation permission.",
    inputSchema: globInputSchema,
    outputSchema: globOutputSchema,
    execute: handler,
    toModelContent(result) {
      return [
        {
          type: "text",
          text: JSON.stringify(
            result.status === "succeeded"
              ? result.output
              : {
                  status: result.status,
                  error: {
                    code: result.error.code.slice(0, 64),
                    message: result.error.message.slice(0, 256),
                  },
                  effects: result.effects,
                },
          ),
        },
      ];
    },
  };
}
