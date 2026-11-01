import type {
  AgentModelContentBlock,
  AgentModelToolResultBlock,
  AgentModelToolUseBlock,
} from "../../gateway";
import type { DurableRunStatus } from "../../persistence/durable-run-store";
import type { AgentRuntimeResult } from "../runtime-types";

export type AgentTransition =
  | { type: "model_input_prepared" }
  | {
      type: "model_response_received";
      content: AgentModelContentBlock[];
      toolUses: AgentModelToolUseBlock[];
    }
  | { type: "tool_claimed"; toolUse: AgentModelToolUseBlock }
  | { type: "tool_processed"; result: AgentModelToolResultBlock }
  | {
      type: "run_terminal";
      status: DurableRunStatus;
      result?: AgentRuntimeResult;
      error?: string;
    };
