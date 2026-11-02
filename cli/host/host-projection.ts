import { AgentError } from "@agent-harness/core/protocol-errors";
import type { ProtocolError } from "@agent-harness/core/protocol-values";
import type { HostInteractionDisplay } from "./host-contract.js";
import { escapeDisplayControls as safe } from "./safe-display-text.js";

/** Only Core's public error class is trusted; SDK/server diagnostics stay private. */
export function projectHostError(error: unknown): ProtocolError {
  if (error instanceof AgentError) return { code: safe(error.code), message: safe(error.message) };
  return {
    code: "TERMINAL_OPERATION_FAILED",
    message: "The operation failed; private diagnostic details were withheld.",
  };
}

export function projectHostInteractionDisplay(
  display: HostInteractionDisplay,
): HostInteractionDisplay {
  if (display.support !== "supported") return { support: "unsupported" };
  return {
    support: "supported",
    summary: safe(display.summary),
    confirmation: display.confirmation,
    choices: display.choices.map((choice) => ({
      id: safe(choice.id),
      label: safe(choice.label),
      responseType: choice.responseType,
    })),
  };
}
