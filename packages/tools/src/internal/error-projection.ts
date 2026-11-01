import type { ToolResult } from "@agent-harness/core/tools/tool-contract";
import { type ToolsEffects, ToolsError, type ToolsErrorCode } from "../tools-errors.js";
import { AtomicWriteConflictError } from "./files/atomic-errors.js";
import { WorkspaceFileError } from "./files/workspace-file-contract.js";
import { MESSAGES } from "./tools-error-messages.js";

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
