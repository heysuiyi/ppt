import type {
  ImmediateToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "@agent-harness/core/tools/tool-contract";

import { z } from "zod";
import type { EditInput, EditOutput } from "../../tools-contract.js";

const textSchema = z
  .string()
  .max(16 * 1024 * 1024)
  .refine((text) => Buffer.byteLength(text, "utf8") <= 16 * 1024 * 1024, {
    message: "Text exceeds the maximum UTF-8 byte size",
  });

export const editInputSchema = z
  .object({
    path: z.string().min(1).max(4096),
    oldText: textSchema.refine((text) => text.length > 0, {
      message: "oldText must not be empty",
    }),
    newText: textSchema,
    expectedVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    replaceAll: z.boolean().optional(),
  })
  .strict();

export const editOutputSchema = z
  .object({
    path: z.string().min(1).max(4096),
    version: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024),
    replacements: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024),
  })
  .strict();

export function createEdit(
  handler: (input: EditInput, context: ToolExecutionContext) => Promise<ToolResult<EditOutput>>,
): ImmediateToolDefinition<EditInput, EditOutput> {
  return {
    name: "edit",
    owner: "tools",
    version: "1",
    mode: "immediate",
    description:
      "Replace literal nonempty oldText with newText in a workspace-relative UTF-8 file. Requires expectedVersion and a complete read of the unchanged file in this installation. By default oldText must occur exactly once; replaceAll explicitly replaces all non-overlapping occurrences.",
    inputSchema: editInputSchema,
    outputSchema: editOutputSchema,
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
