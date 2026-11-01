import type {
  ImmediateToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "@agent-harness/core/tools/tool-contract";

import { z } from "zod";
import type { GrepInput, GrepOutput } from "../../tools-contract.js";

export const grepInputSchema = z
  .object({
    pattern: z.string().min(1).max(4000),
    glob: z.string().min(1).max(4096).optional(),
    caseSensitive: z.boolean().optional(),
    limit: z.number().int().min(1).max(1000).default(200),
  })
  .strict();

export const grepOutputSchema = z
  .object({
    matches: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            version: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            line: z
              .number()
              .int()
              .min(1)
              .max(16 * 1024 * 1024 + 1),
            text: z.string().max(4000),
            truncated: z.boolean(),
          })
          .strict(),
      )
      .max(1000),
    truncated: z.boolean(),
    skipped: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            reason: z.enum(["binary", "too-large"]),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();

export function createGrep(
  handler: (input: GrepInput, context: ToolExecutionContext) => Promise<ToolResult<GrepOutput>>,
): ImmediateToolDefinition<GrepInput, GrepOutput> {
  return {
    name: "grep",
    owner: "tools",
    version: "1",
    mode: "immediate",
    description:
      "Search UTF-8 file lines for a literal string, not a regular expression. Matching is case-sensitive unless caseSensitive is false. Optional glob supports only *, ** and ? and defaults to **/*. Results have one-based line numbers, bounded line text, and explicit binary/too-large skips. Global truncated means scanning or output was incomplete. Search does not grant permission to mutate files.",
    inputSchema: grepInputSchema,
    outputSchema: grepOutputSchema,
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
