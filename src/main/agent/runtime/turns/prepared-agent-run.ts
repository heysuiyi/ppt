import type { AgentStepLimits } from "@shared/agent-step-limits";
import { buildMainStepLimitMessage } from "@shared/agent-step-limits";
import type { ConversationDatabase } from "../../../conversation-database";
import type { AgentModelGateway, AgentToolSchema } from "../../gateway";
import type { DurableQueryInflightSnapshot } from "../../persistence/durable-run-store";
import type { ToolContext, ToolRuntimeCapability } from "../../tools/tool-definition";
import { formatBackgroundNotifications } from "../background/background-task-manager";
import type { LeadInboxInputSource } from "../background/lead-inbox-input-source";
import type { PostToolUseBlock, StopBlock } from "../hooks/hook-blocks";
import type { AgentRendererEvent } from "../lifecycle/agent-event-ports";
import type { AgentRunScope } from "../lifecycle/agent-run-scope";
import type { PresentationCompletionPolicy } from "../presentation/presentation-completion-policy";
import { AgentQueryAssembler } from "../query/agent-query-assembler";
import {
  type AgentIterationWorkspace,
  type AgentQueryContinue,
  type AgentQueryLoopEvent,
  type AgentQueryParams,
  type AgentQueryState,
  createInitialQueryState,
  type ThreadId,
} from "../query/query-types";
import type { AgentRuntimeResult, AgentRuntimeStreamEvent } from "../runtime-types";
import type { ToolApprovalHandler } from "../tools/permission-check";
import type { ToolExecutionEngine } from "../tools/tool-execution-engine";
import type { ToolPreflight } from "../tools/tool-preflight";

export interface AgentLoopTerminalOutcome {
  type: "terminal";
  result: AgentRuntimeResult;
  reason?: StopBlock["reason"];
}

export type AgentLoopTurnOutcome =
  | AgentLoopTerminalOutcome
  | { type: "continue"; reason?: AgentQueryContinue["reason"] }
  | { type: "tool_batch" };

export interface PreparedAgentQueryDeps {
  gateway: AgentModelGateway;
  conversationDatabase?: ConversationDatabase;
  toolSchemas: AgentToolSchema[];
  workspaceRoot?: string;
  runtimeRoot?: string;
  threadId: ThreadId;
  signal: AbortSignal;
  externalSignal?: AbortSignal;
  requiredOutcome?: "any" | "command_proposal";
  requestToolApproval?: ToolApprovalHandler;
  onStreamEvent?: (event: AgentRuntimeStreamEvent) => void;
  onQueryEvent?: (event: AgentQueryLoopEvent) => void;
  onThinkingChunk?: (chunk: string, modelStep: number) => void;
  capabilityToolNames: Readonly<Partial<Record<ToolRuntimeCapability, readonly string[]>>>;
}

/** Prepared, invocation-scoped dependencies consumed by the stable loop and turn runners. */
export class PreparedAgentRun {
  readonly params: AgentQueryParams<PreparedAgentQueryDeps>;
  readonly initialState: AgentQueryState;
  readonly initialWorkspace?: AgentIterationWorkspace;
  readonly initialWorkspacePhase?: DurableQueryInflightSnapshot["phase"];

  private cachedSystemPrompt: string;
  private cachedPlanRevision: number | null;

  constructor(
    readonly input: {
      scope: AgentRunScope;
      gateway: AgentModelGateway;
      conversationDatabase?: ConversationDatabase;
      systemPrompt: string;
      toolSchemas: AgentToolSchema[];
      context: ToolContext;
      maxSteps: number;
      stepLimits: AgentStepLimits;
      leadInbox: LeadInboxInputSource;
      toolPreflight: ToolPreflight;
      toolExecutionEngine: ToolExecutionEngine;
      presentationCompletionPolicy: PresentationCompletionPolicy;
      runPostToolUseHook(block: PostToolUseBlock): Promise<string[]>;
      /** Rebuild dynamic system prompt after task-plan revision changes. */
      refreshSystemPrompt?: (input: {
        toolUseContext: ToolContext;
        planRevision: number | null;
      }) => Promise<string> | string;
    },
  ) {
    const { options } = input.scope;
    const exposedToolNames = new Set(input.toolSchemas.map((schema) => schema.name));
    const capabilityToolNames: Partial<Record<ToolRuntimeCapability, string[]>> = {};
    for (const tool of input.context.registry.getCoreTools(input.context)) {
      if (!exposedToolNames.has(tool.name)) continue;
      for (const capability of tool.behavior?.capabilities ?? []) {
        const names = capabilityToolNames[capability];
        if (names) {
          names.push(tool.name);
        } else {
          capabilityToolNames[capability] = [tool.name];
        }
      }
    }
    this.cachedSystemPrompt = input.systemPrompt;
    this.cachedPlanRevision = input.context.pptTaskSession?.plan?.revision ?? null;
    this.params = new AgentQueryAssembler().assemble({
      queryId: input.scope.queryId,
      options,
      messages: input.scope.initialMessages,
      systemPrompt: input.systemPrompt,
      toolUseContext: input.context,
      maxTurns: input.maxSteps,
      canUseTool: (toolUse) => exposedToolNames.has(toolUse.name),
      deps: {
        gateway: input.gateway,
        conversationDatabase: input.conversationDatabase,
        toolSchemas: input.toolSchemas,
        workspaceRoot: options.workspaceRoot,
        runtimeRoot: options.runtimeRoot,
        threadId: options.threadId,
        signal: input.scope.signal,
        externalSignal: options.signal,
        requiredOutcome: options.requiredOutcome,
        requestToolApproval: options.requestToolApproval,
        onStreamEvent: options.onStreamEvent,
        onQueryEvent: options.onQueryEvent,
        onThinkingChunk: options.onThinkingChunk,
        capabilityToolNames,
      },
    });
    this.initialState = createInitialQueryState(
      this.params,
      input.scope.restoreQueryState(input.context),
    );
    this.initialWorkspace = input.scope.restoreIterationWorkspace(this.initialState, input.context);
    this.initialWorkspacePhase = input.scope.restoredInflightPhase();
  }

  /**
   * Resolve the system prompt for the upcoming model turn.
   * Rebuilds dynamic sections when the PPT task-plan revision changed after
   * SetPptTaskAssessment. QueryParams are frozen by AgentQueryAssembler —
   * never mutate params.systemPrompt; callers must use the returned string.
   */
  async resolveSystemPrompt(toolUseContext: ToolContext): Promise<string> {
    const refresh = this.input.refreshSystemPrompt;
    const planRevision = toolUseContext.pptTaskSession?.plan?.revision ?? null;
    if (!refresh) return this.cachedSystemPrompt;
    if (planRevision === this.cachedPlanRevision) return this.cachedSystemPrompt;
    this.cachedSystemPrompt = await refresh({ toolUseContext, planRevision });
    this.cachedPlanRevision = planRevision;
    return this.cachedSystemPrompt;
  }

  get scope(): AgentRunScope {
    return this.input.scope;
  }

  emitProgress(event: AgentRendererEvent): void {
    this.scope.eventPorts.renderer(event);
  }

  appendRuntimeEvent(
    kind: Parameters<AgentRunScope["eventPorts"]["audit"]>[0],
    payload: Record<string, unknown>,
    visibility?: Parameters<AgentRunScope["eventPorts"]["audit"]>[2],
  ): void {
    this.scope.eventPorts.audit(kind, payload, visibility);
  }

  async drainLeadInboxForModel(): Promise<string | undefined> {
    return await this.input.leadInbox.drain();
  }

  async drainBackgroundForModel(
    workspace: AgentIterationWorkspace,
    instruction: string,
  ): Promise<boolean> {
    const { backgroundTasks } = this.scope;
    if (!backgroundTasks.hasRunning() && !backgroundTasks.hasPendingNotifications()) return false;
    const notifications = await backgroundTasks.drain(this.scope.signal);
    if (notifications.length === 0) return false;
    const content = `${formatBackgroundNotifications(notifications)}\n\n${instruction}`;
    workspace.followUpMessages.push({
      role: "user",
      content: [{ type: "text", text: content }],
    });
    return true;
  }

  async resolveStepLimit(): Promise<AgentLoopTerminalOutcome> {
    const { backgroundTasks, session } = this.scope;
    const notifications = backgroundTasks.hasRunning()
      ? await backgroundTasks.drain(this.scope.signal)
      : backgroundTasks.collect();
    const backgroundContent =
      notifications.length > 0 ? formatBackgroundNotifications(notifications) : "";
    if (backgroundContent) {
      session.appendTranscript({
        role: "system",
        kind: "background_step_limit_results",
        content: backgroundContent,
      });
    }
    if (this.params.deps.requiredOutcome === "command_proposal") {
      throw new Error(
        "Agent reached the tool-step limit before resolving the presentation action. " +
          "The conversation remains active and can be continued." +
          (backgroundContent ? `\n\n${backgroundContent}` : ""),
      );
    }
    return {
      type: "terminal",
      result: {
        type: "message",
        content: [buildMainStepLimitMessage(this.input.stepLimits), backgroundContent]
          .filter(Boolean)
          .join("\n\n"),
      },
      reason: "step_limit",
    };
  }
}
