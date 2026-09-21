import type { AgentModelToolResultBlock } from "../../gateway";
import type { ToolContext, ToolDefinition } from "../../tools/tool-definition";
import {
  type AgentRuntimeResult,
  agentAskUserResultSchema,
  agentCommandProposalResultSchema,
} from "../runtime-types";
import type { ToolExecutionOutcome } from "./tool-execution-engine";

export type ToolCompletionDecision =
  | {
      type: "terminal";
      result: AgentRuntimeResult;
      modelResult?: AgentModelToolResultBlock;
    }
  | {
      type: "continue";
      modelResult: AgentModelToolResultBlock;
      transcriptEntry: Record<string, unknown>;
    };

/** Interprets validated tool facts without executing tools or mutating AgentSession. */
export class ToolCompletionPolicy {
  canTerminate(tool: ToolDefinition<any, any>): boolean {
    return Boolean(tool.behavior?.completion);
  }

  async interpret(input: {
    tool: ToolDefinition<any, any>;
    toolUseId: string;
    outcome: ToolExecutionOutcome;
    context: ToolContext;
    emitProgress(event: { type: string; message: string; [key: string]: unknown }): void;
  }): Promise<ToolCompletionDecision> {
    const toolName = input.tool.name;
    const result = input.outcome.validatedResult;
    const completion = input.tool.behavior?.completion;
    const commandProposalResult =
      completion?.terminalResult === "command_proposal"
        ? agentCommandProposalResultSchema.safeParse(result)
        : undefined;
    if (
      commandProposalResult &&
      !commandProposalResult.success &&
      result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      (result as { type?: unknown }).type === "command_proposal"
    ) {
      throw new Error(
        `${toolName} returned an invalid command proposal: ${commandProposalResult.error.message}`,
      );
    }
    const commandProposal = commandProposalResult?.success ? commandProposalResult.data : undefined;

    if (commandProposal) {
      return {
        type: "terminal",
        result: commandProposal,
        // Even terminal tools must close the provider protocol pair in canonical
        // history. The result is not sent to another model turn, but it is
        // required for resume, export, and cross-provider replay.
        modelResult: input.outcome.modelResult,
      };
    }

    if (completion?.terminalResult === "ask_user") {
      const askUserResult = agentAskUserResultSchema.safeParse(result);
      if (!askUserResult.success) {
        if (completion.expectation === "always") {
          throw new Error(
            `${toolName} must return an ask_user result: ${askUserResult.error.message}`,
          );
        }
      } else {
        const askUser = askUserResult.data;
        return {
          type: "terminal",
          result: askUser,
          modelResult: textResult(input.toolUseId, askUser.content),
        };
      }
    }
    if (completion?.terminalResult === "command_proposal" && completion.expectation === "always") {
      const error =
        commandProposalResult && !commandProposalResult.success
          ? commandProposalResult.error.message
          : "result did not match command_proposal";
      throw new Error(`${toolName} must return a command proposal result: ${error}`);
    }

    if (completion?.terminalResult === "ask_user" && completion.expectation === "always") {
      // The invalid-result branch above always throws; this is an exhaustive
      // guard for future schema/control-flow changes.
      throw new Error(`${toolName} must return an ask_user result.`);
    }

    if (input.outcome.deliveryStatus === "postprocessing_failed") {
      return {
        type: "continue",
        modelResult: input.outcome.modelResult,
        transcriptEntry: {
          role: "tool",
          toolName,
          result,
          postProcessingError: input.outcome.error,
          executionStatus: "returned",
          sideEffects: input.outcome.sideEffects,
        },
      };
    }

    const prepared = input.outcome.preparedResult;
    if (!prepared) throw new Error("Delivered tool result is missing prepared model data.");
    return {
      type: "continue",
      modelResult: input.outcome.modelResult,
      transcriptEntry: {
        role: "tool",
        toolName,
        result: prepared.data,
        toolUseId: input.toolUseId,
        ...(prepared.truncated
          ? {
              modelResult: {
                truncated: true,
                originalChars: prepared.originalChars,
                persistedPath: prepared.persistedPath,
                persistenceError: prepared.persistenceError,
              },
            }
          : {}),
      },
    };
  }
}

function textResult(toolUseId: string, text: string): AgentModelToolResultBlock {
  return { type: "tool_result", toolUseId, content: [{ type: "text", text }] };
}
