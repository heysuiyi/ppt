import type { VersionedData } from "@agent-harness/core/protocol-values";
import type {
  ImmediateToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "@agent-harness/core/tools/tool-contract";

import { z } from "zod";
import type { ReadInput, ReadOutput } from "../../tools-contract.js";
import { presentationPreview } from "../presentation-preview.js";

export const readInputSchema = z
  .object({
    path: z.string().min(1).max(4096),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(2).max(4000).default(4000),
    expectedVersion: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine((input) => !input.offset || input.expectedVersion !== undefined, {
    message: "Reading a later window requires expectedVersion",
    path: ["expectedVersion"],
  });

export const readOutputSchema = z
  .object({
    path: z.string().min(1).max(4096),
    version: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024),
    content: z.string().max(4000),
    startOffset: z
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024),
    endOffset: z
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024),
    totalCharacters: z
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024),
    hasMore: z.boolean(),
    nextOffset: z
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024)
      .optional(),
  })
  .strict()
  .refine(
    (output) =>
      output.endOffset >= output.startOffset &&
      output.endOffset <= output.totalCharacters &&
      output.content.length === output.endOffset - output.startOffset &&
      output.hasMore === output.endOffset < output.totalCharacters &&
      (output.hasMore ? output.nextOffset === output.endOffset : output.nextOffset === undefined),
    { message: "Invalid read window" },
  );

export function createRead(
  handler: (input: ReadInput, context: ToolExecutionContext) => Promise<ToolResult<ReadOutput>>,
): ImmediateToolDefinition<ReadInput, ReadOutput> {
  return {
    name: "read",
    owner: "tools",
    version: "1",
    mode: "immediate",
    description:
      "Read a bounded UTF-8 text window at a workspace-relative path. Offsets and limits count UTF-16 code units. Continue using nextOffset and expectedVersion until hasMore is false; reading every window at one version is required before replacing or editing a file.",
    inputSchema: readInputSchema,
    outputSchema: readOutputSchema,
    execute: handler,
    toPresentation(result): VersionedData {
      return {
        type: "tools.read",
        version: 1,
        data:
          result.status === "succeeded"
            ? {
                path: result.output.path,
                size: result.output.size,
                startOffset: result.output.startOffset,
                endOffset: result.output.endOffset,
                totalCharacters: result.output.totalCharacters,
                hasMore: result.output.hasMore,
                ...presentationPreview(result.output.content),
              }
            : { status: result.status },
      };
    },
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
