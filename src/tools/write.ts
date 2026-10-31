import type {
  ImmediateToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "@agent-ppt/harness/tools/tool-contract";
import { z } from "zod";

export interface WriteCreateInput {
  path: string;
  content: string;
  mode: "create";
}

export interface WriteReplaceInput {
  path: string;
  content: string;
  mode: "replace";
  expectedVersion: string;
}

export type WriteInput = WriteCreateInput | WriteReplaceInput;

export interface WriteOutput {
  path: string;
  version: string;
  size: number;
  operation: "created" | "replaced";
}

const contentSchema = z
  .string()
  .max(16 * 1024 * 1024)
  .refine((content) => Buffer.byteLength(content, "utf8") <= 16 * 1024 * 1024, {
    message: "Content exceeds the maximum UTF-8 byte size",
  });

export const writeInputSchema = z
  .object({
    path: z.string().min(1).max(4096),
    content: contentSchema,
    mode: z.enum(["create", "replace"]),
    expectedVersion: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .transform((input, context): WriteInput => {
    if (input.mode === "create") {
      if ("expectedVersion" in input) {
        context.addIssue({
          code: "custom",
          message: "Create mode must not include expectedVersion",
          path: ["expectedVersion"],
        });
        return z.NEVER;
      }
      return { path: input.path, content: input.content, mode: "create" };
    }
    if (input.expectedVersion === undefined) {
      context.addIssue({
        code: "custom",
        message: "Replace mode requires expectedVersion",
        path: ["expectedVersion"],
      });
      return z.NEVER;
    }
    return {
      path: input.path,
      content: input.content,
      mode: "replace",
      expectedVersion: input.expectedVersion,
    };
  });

export const writeOutputSchema = z
  .object({
    path: z.string().min(1).max(4096),
    version: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    size: z
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024),
    operation: z.enum(["created", "replaced"]),
  })
  .strict();

export function createWrite(
  handler: (input: WriteInput, context: ToolExecutionContext) => Promise<ToolResult<WriteOutput>>,
): ImmediateToolDefinition<WriteInput, WriteOutput> {
  return {
    name: "write",
    owner: "tools",
    version: "1",
    mode: "immediate",
    description:
      "Write UTF-8 text at a workspace-relative path. Explicit mode create requires a missing file. Mode replace requires expectedVersion and a complete read of the unchanged existing file in this installation; it never blindly overwrites. The configured file-byte limit applies.",
    inputSchema: writeInputSchema,
    outputSchema: writeOutputSchema,
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
