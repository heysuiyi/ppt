import { AgentError } from "@agent-harness/core/protocol-errors";

export function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentError("invalid-revision", "Revision must be a nonnegative safe integer.");
  }
}

export function nextRevision(value: number): number {
  assertRevision(value + 1);
  return value + 1;
}
