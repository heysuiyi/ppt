/**
 * Agent Runtime 的稳定协议类型边界。
 */

import type { AgentExecutionStrategy, AgentModelSelection } from "@shared/agent";
import { agentQuestionSchema } from "@shared/agent-question";
import type { AgentStepLimits } from "@shared/agent-step-limits";
import { presentationCommandSchema } from "@shared/commands";
import type { Presentation } from "@shared/presentation";
import { z } from "zod";
import type { MessageBus } from "../teammate/message-bus";
import type { TeammateManager } from "../teammate/spawn-teammate";
import {
  type AgentQueryLoopEvent,
  asRunId,
  asThreadId,
  type QueryStartMode,
  type RunId,
  type ThreadId,
} from "./query/query-types";
import type { ToolApprovalHandler } from "./tools/permission-check";

export type AgentRuntimeRisk = "low" | "medium" | "high";

export const agentMessageResultSchema = z.object({
  type: z.literal("message"),
  content: z.string().trim().min(1),
});

export const agentAskUserResultSchema = z.object({
  type: z.literal("ask_user"),
  content: z.string().trim().min(1),
  missingFields: z.array(z.string()).optional(),
  question: agentQuestionSchema.optional(),
});

export const agentCommandProposalResultSchema = z.object({
  type: z.literal("command_proposal"),
  summary: z.string().trim().min(1),
  commands: z.array(presentationCommandSchema).min(1),
  risk: z.enum(["low", "medium", "high"]),
  assumptions: z.array(z.string()).optional(),
});

export type AgentMessageResult = z.infer<typeof agentMessageResultSchema>;
export type AgentAskUserResult = z.infer<typeof agentAskUserResultSchema>;
export type AgentCommandProposalResult = z.infer<typeof agentCommandProposalResultSchema>;
export type AgentRuntimeResult =
  | AgentMessageResult
  | AgentAskUserResult
  | AgentCommandProposalResult;

export type AgentRuntimeStreamEvent =
  | { type: "attempt_started"; attemptId: string }
  | { type: "delta"; attemptId: string; text: string }
  | { type: "attempt_reset"; attemptId: string; reason: string }
  | { type: "attempt_committed"; attemptId: string };

export interface AgentRuntimeOptions {
  threadId: ThreadId;
  request: string;
  presentationSnapshot?: Presentation;
  currentSlideId?: string;
  selectedElementIds: string[];
  model?: AgentModelSelection;
  fallbackModel?: AgentModelSelection;
  executionStrategy?: AgentExecutionStrategy;
  runId?: RunId;
  startMode: QueryStartMode;
  userContext?: Readonly<Record<string, string>>;
  systemContext?: Readonly<Record<string, string>>;
  maxOutputTokensOverride?: number;
  messageHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  requiredOutcome?: "any" | "command_proposal";
  workspaceRoot?: string;
  /** Application-owned runtime directory; never points at the user workspace. */
  runtimeRoot?: string;
  /** Explicit persistent task-list identity; inherited by fork/recovery runtimes. */
  taskListId?: string;
  /** Stable team identity when lead and teammates share one task list. */
  teamSessionId?: string;
  /** Trusted Task actor id. Defaults to "agent". */
  taskListOwner?: string;
  maxSteps?: number;
  agentStepLimits?: AgentStepLimits;
  onStreamEvent?: (event: AgentRuntimeStreamEvent) => void;
  /** Semantic query state changes; observational callbacks cannot affect execution. */
  onQueryEvent?: (event: AgentQueryLoopEvent) => void;
  onThinkingChunk?: (chunk: string, modelStep: number) => void;
  signal?: AbortSignal;
  onProgress?: (event: { type: string; message: string; [key: string]: unknown }) => void;
  requestToolApproval?: ToolApprovalHandler;
  /** File-backed inbox bus used by lead and teammates. */
  messageBus?: MessageBus;
  /** Long-lived teammate manager exposed through spawn_teammate. */
  teammateManager?: TeammateManager;
  /** Test/harness override; accepts merged or legacy stage names. */
  stageHint?: string;
}

export type AgentRuntimeInput = Omit<
  AgentRuntimeOptions,
  "threadId" | "runId" | "startMode" | "selectedElementIds"
> & {
  threadId: string;
  selectedElementIds?: string[];
  runId?: string;
  startMode?: QueryStartMode;
};

export function normalizeAgentRuntimeOptions(input: AgentRuntimeInput): AgentRuntimeOptions {
  return {
    ...input,
    selectedElementIds: input.selectedElementIds ?? [],
    threadId: asThreadId(input.threadId),
    runId: input.runId ? asRunId(input.runId) : undefined,
    startMode: input.startMode ?? { type: "new_query" },
  };
}
