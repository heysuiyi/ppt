import type { AgentModelSelection } from "@shared/agent";
import { asQueryId, type QueryId } from "@shared/presentation-lifecycle";
import type {
  AgentModelMessage,
  AgentModelToolResultBlock,
  AgentModelToolUseBlock,
} from "../../gateway";
import type { ToolContext } from "../../tools/tool-definition";

declare const identityBrand: unique symbol;

export type SessionId = string & { readonly [identityBrand]: "SessionId" };
export type ThreadId = string & { readonly [identityBrand]: "ThreadId" };
export type RunId = string & { readonly [identityBrand]: "RunId" };
export type { QueryId };
export { asQueryId };

export function asThreadId(value: string): ThreadId {
  return value as ThreadId;
}

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function asRunId(value: string): RunId {
  return value as RunId;
}

export type QueryStartMode =
  | { type: "new_query" }
  | {
      type: "resume_query";
      reason: "waiting_user" | "interrupted" | "crash_recovery";
    };

export type AgentQuerySource = "user" | "continuation" | "recovery";

export type CanUseToolFn = (
  toolUse: AgentModelToolUseBlock,
  context: ToolContext,
) => boolean | Promise<boolean>;

/**
 * Stable input assembled once for one logical user query.
 *
 * Runtime dependencies deliberately stay opaque at this layer. The Presentation
 * factory supplies them, while the loop consumes only this assembled boundary.
 */
export interface AgentQueryParams<TDeps = unknown> {
  queryId: QueryId;
  messages: readonly AgentModelMessage[];
  systemPrompt: string;
  userContext: Readonly<Record<string, string>>;
  systemContext: Readonly<Record<string, string>>;
  canUseTool: CanUseToolFn;
  toolUseContext: ToolContext;
  model?: AgentModelSelection;
  fallbackModel?: AgentModelSelection;
  querySource: AgentQuerySource;
  maxOutputTokensOverride?: number;
  maxTurns: number;
  deps: TDeps;
}

export interface AgentQueryContinue {
  reason: "next_turn" | "required_outcome" | "background_result" | "inbox" | "completed";
}

/**
 * Observable, provider-neutral events emitted by the query state machine.
 *
 * These events intentionally describe control-flow facts rather than UI copy or
 * persistence payloads. Consumers can project progress without reaching into
 * AgentRuntime, and tests can assert state movement without depending on the
 * concrete loop implementation.
 */
export type AgentQueryLoopEvent = (
  | { type: "query_started"; turnCount: number }
  | {
      type: "workspace_recovered";
      turnCount: number;
      phase: "model_streaming" | "model_received" | "tool_running" | "waiting_user";
      toolUseCount: number;
      toolResultCount: number;
    }
  | {
      type: "model_turn_completed";
      turnCount: number;
      decision: "terminal" | "continue" | "tool_batch";
      toolUseCount: number;
    }
  | {
      type: "tool_batch_completed";
      turnCount: number;
      toolUseCount: number;
      toolResultCount: number;
      terminal: boolean;
    }
  | {
      type: "state_committed";
      turnCount: number;
      reason: AgentQueryContinue["reason"];
    }
  | {
      type: "query_completed";
      turnCount: number;
      reason: "terminal" | "step_limit";
      resultType: "message" | "ask_user" | "command_proposal";
    }
  | {
      type: "query_failed";
      turnCount: number;
      error: string;
    }
) & { queryId: QueryId };

/** The committed snapshot shared by consecutive agentic turns in one query. */
export interface AgentQueryState {
  messages: AgentModelMessage[];
  toolUseContext: ToolContext;
  turnCount: number;
  transition?: AgentQueryContinue;
  maxOutputTokensOverride?: number;
  maxOutputTokensRecoveryCount: number;
  hasAttemptedReactiveCompact: boolean;
  validationFailuresByTool: ReadonlyMap<string, number>;
}

/** Uncommitted assistant/tool work owned by exactly one loop iteration. */
export interface AgentIterationWorkspace {
  messagesForQuery: AgentModelMessage[];
  assistantMessages: AgentModelMessage[];
  toolUseBlocks: AgentModelToolUseBlock[];
  toolResults: AgentModelToolResultBlock[];
  userContent: string[];
  followUpMessages: AgentModelMessage[];
  needsFollowUp: boolean;
  updatedToolUseContext: ToolContext;
  maxOutputTokensOverride?: number;
  maxOutputTokensRecoveryCount: number;
  hasAttemptedReactiveCompact: boolean;
  validationFailuresByTool: Map<string, number>;
}

export function createInitialQueryState(
  params: AgentQueryParams,
  recovered?: Partial<AgentQueryState>,
): AgentQueryState {
  return {
    messages: structuredClone([...(recovered?.messages ?? params.messages)]),
    toolUseContext: recovered?.toolUseContext ?? params.toolUseContext,
    turnCount: recovered?.turnCount ?? 0,
    transition: recovered?.transition,
    maxOutputTokensOverride: recovered?.maxOutputTokensOverride ?? params.maxOutputTokensOverride,
    maxOutputTokensRecoveryCount: recovered?.maxOutputTokensRecoveryCount ?? 0,
    hasAttemptedReactiveCompact: recovered?.hasAttemptedReactiveCompact ?? false,
    validationFailuresByTool: new Map(recovered?.validationFailuresByTool ?? []),
  };
}

export function createIterationWorkspace(state: AgentQueryState): AgentIterationWorkspace {
  return {
    messagesForQuery: structuredClone(state.messages),
    assistantMessages: [],
    toolUseBlocks: [],
    toolResults: [],
    userContent: [],
    followUpMessages: [],
    needsFollowUp: false,
    updatedToolUseContext: state.toolUseContext,
    maxOutputTokensOverride: state.maxOutputTokensOverride,
    maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount,
    hasAttemptedReactiveCompact: state.hasAttemptedReactiveCompact,
    validationFailuresByTool: new Map(state.validationFailuresByTool),
  };
}

export function reduceQueryState(
  state: AgentQueryState,
  workspace: AgentIterationWorkspace,
  transition: AgentQueryContinue = { reason: "next_turn" },
): AgentQueryState {
  if (workspace.toolUseBlocks.length !== workspace.toolResults.length) {
    throw new Error(
      "Cannot commit an incomplete tool batch: every tool_use requires one tool_result.",
    );
  }
  const resultIds = new Set(workspace.toolResults.map((result) => result.toolUseId));
  if (workspace.toolUseBlocks.some((toolUse) => !resultIds.has(toolUse.id))) {
    throw new Error(
      "Cannot commit a mismatched tool batch: tool_result ids must match tool_use ids.",
    );
  }

  const userContent = workspace.userContent
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ type: "text" as const, text }));
  const toolResultMessage: AgentModelMessage[] =
    workspace.toolResults.length > 0 || userContent.length > 0
      ? [
          {
            role: "user",
            content: [...structuredClone(workspace.toolResults), ...userContent],
          },
        ]
      : [];
  return {
    ...state,
    messages: [
      ...structuredClone(workspace.messagesForQuery),
      ...structuredClone(workspace.assistantMessages),
      ...toolResultMessage,
      ...structuredClone(workspace.followUpMessages),
    ],
    toolUseContext: workspace.updatedToolUseContext,
    turnCount: state.turnCount + 1,
    transition,
    maxOutputTokensOverride: workspace.maxOutputTokensOverride,
    maxOutputTokensRecoveryCount: workspace.maxOutputTokensRecoveryCount,
    hasAttemptedReactiveCompact: workspace.hasAttemptedReactiveCompact,
    validationFailuresByTool: new Map(workspace.validationFailuresByTool),
  };
}
