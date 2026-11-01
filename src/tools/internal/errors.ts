import type { ToolResult } from "@agent-harness/core/tools/tool-contract";
import { AtomicWriteConflictError } from "./atomic";
import { WorkspaceFileError } from "./workspace-file-types";

const MESSAGES = {
  INVALID_OPTIONS: "Tools options are invalid.",
  INVALID_INPUT: "Tool input is invalid.",
  INVALID_PATH: "A workspace-relative path without drive, stream or URI syntax is required.",
  INVALID_WORKSPACE: "The workspace must be an existing regular directory without symbolic links.",
  OUTSIDE_WORKSPACE: "Only workspace-relative paths inside the workspace are allowed.",
  READ_REQUIRED: "Read every window of this file in this installation before changing it.",
  STALE_FILE: "The file or its path changed. Read it again before retrying.",
  INVALID_EXPECTED_VERSION: "The expected version does not match the observed file version.",
  INVALID_EDIT: "Edit text must be nonempty and different from its replacement.",
  OLD_STRING_NOT_FOUND: "The exact text to replace was not found.",
  AMBIGUOUS_EDIT: "The exact text has multiple matches. Supply more context or replaceAll.",
  UNSAFE_FILE_TYPE: "Symbolic links, junctions and special files are not supported.",
  INVALID_UTF8: "Only valid UTF-8 text is supported.",
  FILE_TOO_LARGE: "The file exceeds the configured byte limit.",
  INVALID_READ_RANGE: "The requested text window is invalid. Use the returned nextOffset.",
  BINARY_FILE: "Binary files are not supported.",
  NOT_FOUND: "The requested file or workspace does not exist.",
  ALREADY_EXISTS: "Create requires a destination that does not exist.",
  ACCESS_DENIED: "The workspace operation was denied by the filesystem.",
  IO_ERROR: "The workspace operation could not be completed safely.",
  CANCELLED: "The workspace operation was cancelled.",
} as const;

export type ToolsErrorCode = keyof typeof MESSAGES;
export type ToolsEffects = "none" | "applied" | "unknown";

export class ToolsError extends Error {
  constructor(
    readonly code: ToolsErrorCode,
    readonly effects: ToolsEffects = "none",
  ) {
    super(MESSAGES[code]);
    this.name = "ToolsError";
  }
}

export function safeToolsError(error: unknown, effects: ToolsEffects = "none"): ToolsError {
  if (error instanceof ToolsError) {
    return effects === "none" ? error : new ToolsError(error.code, effects);
  }
  if (error instanceof AtomicWriteConflictError) {
    return new ToolsError(
      "STALE_FILE",
      effects === "applied" ? effects : error.sideEffects === "uncertain" ? "unknown" : effects,
    );
  }
  if (error instanceof WorkspaceFileError && error.code in MESSAGES) {
    return new ToolsError(error.code as ToolsErrorCode, effects);
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const name = (error as Error | undefined)?.name;
  if (name === "AbortError") return new ToolsError("CANCELLED", effects);
  if (code === "ENOENT") return new ToolsError("NOT_FOUND", effects);
  if (code === "EACCES" || code === "EPERM") return new ToolsError("ACCESS_DENIED", effects);
  if (code === "EEXIST") return new ToolsError("ALREADY_EXISTS", effects);
  return new ToolsError("IO_ERROR", effects);
}

export function failedResult<T>(error: unknown, effects: ToolsEffects = "none"): ToolResult<T> {
  const safe = safeToolsError(error, effects);
  return {
    status: safe.effects === "unknown" ? "unknown" : "failed",
    error: { code: safe.code, message: safe.message },
    effects: safe.effects,
  };
}
