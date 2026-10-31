import type { ProtocolError } from "./protocol-values";

export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export function asProtocolError(error: unknown): ProtocolError {
  return error instanceof AgentError
    ? { code: error.code, message: error.message }
    : { code: "EXECUTION_FAILED", message: "Agent execution failed" };
}
