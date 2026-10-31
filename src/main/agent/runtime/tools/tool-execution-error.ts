import { WorkspaceFileError } from "../../../../tools/internal/workspace-file-service";

export interface ToolExecutionErrorClassification {
  message: string;
  guidance: string;
  sideEffects: "none" | "uncertain";
  errorCode?: string;
}

export function classifyToolExecutionError(error: unknown): ToolExecutionErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof WorkspaceFileError) {
    return {
      message,
      guidance:
        `[${error.code}] ${message}\n` +
        "The file operation was rejected before mutation; no side effects were committed.",
      sideEffects: "none",
      errorCode: error.code,
    };
  }
  return {
    message,
    guidance:
      `${message}\n` +
      "The tool threw after execution started; side effects may be uncertain. " +
      "Inspect durable artifacts before retrying.",
    sideEffects: "uncertain",
  };
}
