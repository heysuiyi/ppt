import type { z } from "zod";
export class ToolOutputValidationError extends Error {
  constructor(
    readonly toolName: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(
      `Tool ${toolName} returned invalid output: ${issues.map((issue) => issue.message).join("; ")}`,
    );
    this.name = "ToolOutputValidationError";
  }
}

/** Apply a tool's optional output schema at the central execution boundary. */
export function validateToolOutput<TResult>(
  tool: {
    name: string;
    outputSchema?: z.ZodType<TResult>;
  },
  output: unknown,
): TResult {
  if (!tool.outputSchema) return output as TResult;
  const parsed = tool.outputSchema.safeParse(output);
  if (!parsed.success) {
    throw new ToolOutputValidationError(tool.name, parsed.error.issues);
  }
  return parsed.data;
}
