import { MESSAGES } from "./internal/tools-error-messages.js";

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
