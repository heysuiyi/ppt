import type { AgentTransition } from "./agent-transition";

export type CheckpointDecision = "none" | "commit" | "commit_before_next" | "terminal";

/** The single mapping from state-machine facts to durable recovery boundaries. */
export class CheckpointPolicy {
  afterTransition(
    transition: AgentTransition,
    options?: { toolResultTerminates?: boolean },
  ): CheckpointDecision {
    switch (transition.type) {
      case "model_input_prepared":
      case "tool_claimed":
        return "commit";
      case "model_response_received":
        return transition.toolUses.length > 0 ? "commit" : "none";
      case "tool_processed":
        return options?.toolResultTerminates ? "terminal" : "commit_before_next";
      case "run_terminal":
        return "terminal";
    }
  }
}
