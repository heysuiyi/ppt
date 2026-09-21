import type { ConversationDatabase } from "../../../conversation-database";
import type { AgentModelMessage } from "../../gateway";
import { DurableConversationHistoryStore } from "../../persistence/conversation-history-store";
import {
  type DurableIterationWorkspaceSnapshot,
  type DurableQueryInflightSnapshot,
  type DurableQueryStateSnapshot,
  type DurableRunCheckpoint,
  type DurableRunPhase,
  type DurableRunStatus,
  DurableRunStore,
  type LegacyDurableRunCheckpoint,
} from "../../persistence/durable-run-store";
import type { SkillSession } from "../../skills/skill-types";
import { resolveTaskListIdentity } from "../../task/task-list-identity";
import { createTaskStore } from "../../task/task-store";
import { TaskSubscriptionService } from "../../task/task-subscription-service";
import type { ToolDiscoverySession } from "../../tools/tool-definition";
import { BackgroundTaskManager } from "../background/background-task-manager";
import {
  type AgentIterationWorkspace,
  type AgentQueryState,
  asQueryId,
  asRunId,
  type QueryId,
  type RunId,
} from "../query/query-types";
import type { RuntimeDomainState } from "../runtime-plugin";
import type { AgentRuntimeOptions, AgentRuntimeResult } from "../runtime-types";
import { AgentEventPorts } from "./agent-event-ports";
import { AgentSession } from "./agent-session";
import { CheckpointCoordinator } from "./checkpoint-coordinator";
import { CheckpointPolicy } from "./checkpoint-policy";

export interface AgentRunScopeOpenInput {
  options: AgentRuntimeOptions;
  conversationDatabase?: ConversationDatabase;
  resolveDiscoverySession(recovered?: DurableRunCheckpoint): ToolDiscoverySession;
  resolveSkillSession(recovered?: DurableRunCheckpoint): SkillSession;
  resolveDomainState?(recovered?: DurableRunCheckpoint): RuntimeDomainState;
}

/**
 * Owns every resource whose lifetime is bounded by one AgentRuntime invocation.
 * `open()` rolls back partial acquisition; `close()` is idempotent and best effort.
 */
export class AgentRunScope {
  static async open(input: AgentRunScopeOpenInput): Promise<AgentRunScope> {
    const { options } = input;
    const abortController = new AbortController();
    const forwardAbort = (): void => abortController.abort(options.signal?.reason);
    if (options.signal?.aborted) forwardAbort();
    else options.signal?.addEventListener("abort", forwardAbort, { once: true });

    let checkpoints: CheckpointCoordinator | undefined;
    try {
      const durableRunStore = input.conversationDatabase
        ? new DurableRunStore(input.conversationDatabase)
        : options.workspaceRoot
          ? new DurableRunStore(options.workspaceRoot)
          : undefined;
      const historyStore = input.conversationDatabase
        ? new DurableConversationHistoryStore(input.conversationDatabase)
        : options.workspaceRoot
          ? new DurableConversationHistoryStore(options.workspaceRoot)
          : undefined;
      const startMode = options.startMode;
      const runId = options.runId ?? asRunId(crypto.randomUUID());
      const openedCheckpoint = durableRunStore
        ? await durableRunStore.openLease({
            threadId: options.threadId,
            runId,
            resume: startMode.type === "resume_query",
          })
        : undefined;
      if (openedCheckpoint?.type === "lease_busy") {
        throw new Error(
          `Agent thread ${options.threadId} is already owned by active run ${openedCheckpoint.activeRunId}.`,
        );
      }

      checkpoints = new CheckpointCoordinator(
        durableRunStore,
        openedCheckpoint?.type === "opened" ? openedCheckpoint.lease : undefined,
        openedCheckpoint?.type === "opened" ? openedCheckpoint.currentRevision : 0,
      );
      const previousCheckpoint =
        openedCheckpoint?.type === "opened" ? openedCheckpoint.checkpoint : undefined;
      const recovered = startMode.type === "resume_query" ? previousCheckpoint : undefined;
      const storedHistory =
        startMode.type === "new_query" ? await historyStore?.load(options.threadId) : undefined;
      const completedCheckpoint = startMode.type === "new_query" ? previousCheckpoint : undefined;

      const transcript: Array<Record<string, unknown>> = recovered
        ? [...structuredClone(recovered.transcript), { role: "user", content: options.request }]
        : [{ role: "user", content: options.request }];
      const migratedHistory = completedConversationHistory(completedCheckpoint);
      const recoveredCommittedMessages = checkpointState(recovered)?.messages;
      const recoveredInflight = checkpointInflight(recovered);
      const legacyInflightAssistantIndex =
        recovered?.version === 1 ? findLegacyInflightAssistantIndex(recovered) : -1;
      const modelMessages: AgentModelMessage[] = recovered
        ? structuredClone(
            recoveredCommittedMessages ??
              (legacyInflightAssistantIndex >= 0
                ? legacyMessages(recovered).slice(0, legacyInflightAssistantIndex)
                : legacyMessages(recovered)),
          )
        : [
            ...structuredClone(
              migratedHistory ??
                storedHistory ??
                legacyVisibleHistory(options).map((entry) => ({
                  role: entry.role,
                  content: [{ type: "text" as const, text: entry.content }],
                })),
            ),
            { role: "user", content: [{ type: "text", text: options.request }] },
          ];
      if (recovered && !recoveredInflight && legacyInflightAssistantIndex < 0) {
        appendUserText(modelMessages, options.request);
      }
      const session = new AgentSession({
        transcript,
        pendingUserContent: [...(recovered?.pendingUserContent ?? [])],
        processedInboxMessageIds: recovered?.processedInboxMessageIds,
        phase: recovered?.phase,
        totalModelSteps: recovered
          ? recovered.version === 1
            ? recovered.modelStep
            : recovered.committedState.turnCount
          : undefined,
      });
      const backgroundTasks = new BackgroundTaskManager({
        runId,
        recovered: recovered?.backgroundTasks,
      });
      const eventPorts = new AgentEventPorts({
        threadId: options.threadId,
        runId,
        onProgress: options.onProgress,
        conversationDatabase: input.conversationDatabase,
        appendTranscript: (entry) => session.appendTranscript(entry),
      });
      const scope = new AgentRunScope({
        options,
        abortController,
        forwardAbort,
        runId,
        recovered,
        checkpointCreatedAt: recovered?.createdAt ?? new Date().toISOString(),
        checkpoints,
        session,
        backgroundTasks,
        eventPorts,
        discoverySession: input.resolveDiscoverySession(recovered),
        skillSession: input.resolveSkillSession(recovered),
        domainState: input.resolveDomainState?.(recovered),
        historyStore,
        queryId: asQueryId(
          recovered
            ? recovered.version === 1
              ? (recovered.queryLifecycle?.queryId ?? crypto.randomUUID())
              : recovered.queryId
            : crypto.randomUUID(),
        ),
        initialMessages: modelMessages,
      });
      scope.restoreBackgroundRecovery();
      scope.attachBackgroundCheckpoint();
      await scope.startTaskSubscription();
      return scope;
    } catch (error) {
      abortController.abort(error);
      options.signal?.removeEventListener("abort", forwardAbort);
      if (checkpoints) {
        try {
          await checkpoints.close();
        } catch {
          // Partial-open rollback cannot replace the acquisition error.
        }
      }
      throw error;
    }
  }

  readonly options: AgentRuntimeOptions;
  readonly runId: RunId;
  readonly recovered?: DurableRunCheckpoint;
  readonly checkpoints: CheckpointCoordinator;
  readonly session: AgentSession;
  readonly backgroundTasks: BackgroundTaskManager;
  readonly eventPorts: AgentEventPorts;
  readonly discoverySession: ToolDiscoverySession;
  readonly skillSession: SkillSession;
  readonly domainState?: RuntimeDomainState;
  readonly taskStore;
  readonly taskSubscription?: TaskSubscriptionService;
  readonly taskListOwner: string;
  readonly checkpointPolicy = new CheckpointPolicy();
  readonly historyStore?: DurableConversationHistoryStore;
  readonly queryId: QueryId;
  readonly initialMessages: readonly AgentModelMessage[];

  private readonly abortController: AbortController;
  private readonly forwardAbort: () => void;
  private readonly checkpointCreatedAt: string;
  private closed = false;
  private committedQueryState?: DurableQueryStateSnapshot;
  private inflightQuery?: DurableQueryInflightSnapshot;
  private conversationHistorySnapshot?: AgentModelMessage[];
  private terminalConversationHistoryStaged = false;

  private constructor(input: {
    options: AgentRuntimeOptions;
    abortController: AbortController;
    forwardAbort: () => void;
    runId: RunId;
    recovered?: DurableRunCheckpoint;
    checkpointCreatedAt: string;
    checkpoints: CheckpointCoordinator;
    session: AgentSession;
    backgroundTasks: BackgroundTaskManager;
    eventPorts: AgentEventPorts;
    discoverySession: ToolDiscoverySession;
    skillSession: SkillSession;
    domainState?: RuntimeDomainState;
    historyStore?: DurableConversationHistoryStore;
    queryId: QueryId;
    initialMessages: AgentModelMessage[];
  }) {
    this.options = input.options;
    this.abortController = input.abortController;
    this.forwardAbort = input.forwardAbort;
    this.runId = input.runId;
    this.recovered = input.recovered;
    this.checkpointCreatedAt = input.checkpointCreatedAt;
    this.checkpoints = input.checkpoints;
    this.session = input.session;
    this.backgroundTasks = input.backgroundTasks;
    this.eventPorts = input.eventPorts;
    this.discoverySession = input.discoverySession;
    this.skillSession = input.skillSession;
    this.domainState = input.domainState;
    this.historyStore = input.historyStore;
    this.queryId = input.queryId;
    this.initialMessages = structuredClone(input.initialMessages);
    this.taskStore = createTaskStore(
      input.options.runtimeRoot,
      resolveTaskListIdentity({
        taskListId: input.options.taskListId,
        teamSessionId: input.options.teamSessionId,
        threadId: input.options.threadId,
      }),
    );
    this.taskSubscription = this.taskStore
      ? new TaskSubscriptionService(this.taskStore)
      : undefined;
    this.taskListOwner = input.options.taskListOwner ?? "agent";
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  abort(reason?: unknown): void {
    this.abortController.abort(reason);
  }

  private async startTaskSubscription(): Promise<void> {
    await this.taskSubscription?.subscribe((snapshot) => {
      this.eventPorts.renderer({
        type: "task-list-updated",
        message: "任务列表已更新",
        tasks: snapshot.tasks,
        goal: null,
        listRevision: snapshot.listRevision,
        state: snapshot.state,
        archive: snapshot.archive,
      });
    });
  }

  applyTransition(transition: Parameters<AgentSession["apply"]>[0]) {
    this.session.apply(transition);
    return this.checkpointPolicy.afterTransition(transition);
  }

  createCheckpoint(input?: {
    status?: DurableRunStatus;
    phase?: DurableRunPhase;
    result?: AgentRuntimeResult;
    error?: string;
  }): DurableRunCheckpoint {
    const now = new Date().toISOString();
    const status = input?.status ?? this.session.terminalState?.status ?? "running";
    const committedState = this.committedQueryState ?? {
      messages: structuredClone([...this.initialMessages]),
      turnCount: 0,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      validationFailuresByTool: [],
    };
    return {
      version: 2,
      threadId: this.options.threadId,
      queryId: this.queryId,
      lastRunId: this.runId,
      status,
      phase: input?.phase ?? (this.session.terminalState ? "finished" : this.session.phase),
      request: this.options.request,
      model: this.options.model,
      executionStrategy: this.options.executionStrategy,
      ...this.domainState?.checkpoint(),
      transcript: structuredClone([...this.session.transcript]),
      pendingUserContent: [...this.session.pendingUserContent],
      discoveredToolNames: [...this.discoverySession.discoveredToolNames].sort(),
      loadedSkillNames: [...this.skillSession.loadedSkillNames].sort(),
      backgroundTasks: this.backgroundTasks.snapshot(),
      processedInboxMessageIds: [...this.session.processedInboxMessageIds].sort(),
      committedState: structuredClone(committedState),
      ...(this.inflightQuery ? { inflight: structuredClone(this.inflightQuery) } : {}),
      ...(status === "completed"
        ? {
            terminalHistory: structuredClone(
              this.conversationHistorySnapshot ?? committedState.messages,
            ),
          }
        : {}),
      result: input?.result ?? this.session.terminalState?.result,
      error: input?.error ?? this.session.terminalState?.error,
      createdAt: this.checkpointCreatedAt,
      updatedAt: now,
    };
  }

  async persistCheckpoint(input?: Parameters<AgentRunScope["createCheckpoint"]>[0]): Promise<void> {
    await this.checkpoints.commit(this.createCheckpoint(input));
  }

  async commitConversationHistory(): Promise<void> {
    if (!this.historyStore) return;
    await this.historyStore.save(
      this.options.threadId,
      this.conversationHistorySnapshot ??
        this.committedQueryState?.messages ??
        this.initialMessages,
    );
  }

  restoreQueryState(
    toolUseContext: AgentQueryState["toolUseContext"],
  ): Partial<AgentQueryState> | undefined {
    const snapshot = checkpointState(this.recovered);
    if (!snapshot) return undefined;
    return {
      ...structuredClone(snapshot),
      toolUseContext,
      validationFailuresByTool: new Map(snapshot.validationFailuresByTool),
      transition: snapshot.transition?.reason
        ? {
            reason: snapshot.transition.reason as NonNullable<
              AgentQueryState["transition"]
            >["reason"],
          }
        : undefined,
    };
  }

  restoreIterationWorkspace(
    state: AgentQueryState,
    toolUseContext: AgentQueryState["toolUseContext"],
  ): AgentIterationWorkspace | undefined {
    if (this.options.startMode.type !== "resume_query") return undefined;
    const inflight = checkpointInflight(this.recovered);
    const snapshot = inflight?.workspace;
    const workspace = snapshot
      ? {
          messagesForQuery: structuredClone(snapshot.messagesForQuery),
          assistantMessages: structuredClone(snapshot.assistantMessages),
          toolUseBlocks: structuredClone(snapshot.toolUseBlocks),
          toolResults: structuredClone(snapshot.toolResults),
          userContent: [...(snapshot.userContent ?? [])],
          followUpMessages: structuredClone(snapshot.followUpMessages),
          needsFollowUp: snapshot.needsFollowUp,
          updatedToolUseContext: toolUseContext,
          maxOutputTokensOverride:
            snapshot.maxOutputTokensOverride ?? state.maxOutputTokensOverride,
          maxOutputTokensRecoveryCount:
            snapshot.maxOutputTokensRecoveryCount ?? state.maxOutputTokensRecoveryCount,
          hasAttemptedReactiveCompact:
            snapshot.hasAttemptedReactiveCompact ?? state.hasAttemptedReactiveCompact,
          validationFailuresByTool: new Map<string, number>(
            snapshot.validationFailuresByTool ?? state.validationFailuresByTool,
          ),
        }
      : legacyIterationWorkspace(this.recovered, state, toolUseContext);
    if (!workspace) return undefined;

    const resumedUserContent = [this.options.request, ...this.session.takePendingUserContent()]
      .map((part) => part.trim())
      .filter(Boolean);
    if (inflight?.phase === "model_streaming") {
      for (const text of [...workspace.userContent, ...resumedUserContent]) {
        appendUserText(workspace.messagesForQuery, text);
      }
      workspace.userContent = [];
      workspace.assistantMessages = [];
      workspace.toolUseBlocks = [];
      workspace.toolResults = [];
      workspace.followUpMessages = [];
      return workspace;
    }

    const activeToolUses =
      inflight?.activeToolUses ??
      (inflight?.activeToolUse ? [inflight.activeToolUse] : undefined) ??
      (this.recovered?.version === 1 && this.recovered.activeToolUse
        ? [this.recovered.activeToolUse]
        : []);
    for (const activeToolUse of activeToolUses) {
      if (workspace.toolResults.some((result) => result.toolUseId === activeToolUse.id)) {
        continue;
      }
      workspace.toolResults.push(interruptedToolResult(activeToolUse.id));
      this.session.appendTranscript({
        role: "system",
        kind: "recovery",
        toolUseId: activeToolUse.id,
        toolName: activeToolUse.name,
        content: "Recovered an interrupted tool boundary; side effects require reconciliation.",
      });
    }
    workspace.userContent.push(...resumedUserContent);
    return workspace;
  }

  restoredInflightPhase(): DurableQueryInflightSnapshot["phase"] | undefined {
    return checkpointInflight(this.recovered)?.phase;
  }

  setCommittedQueryState(state: AgentQueryState): void {
    this.committedQueryState = queryStateSnapshot(state);
    this.inflightQuery = undefined;
    this.conversationHistorySnapshot = structuredClone(state.messages);
  }

  stageConversationHistory(state: AgentQueryState, workspace: AgentIterationWorkspace): void {
    this.conversationHistorySnapshot = materializeWorkspaceMessages(state, workspace);
    this.terminalConversationHistoryStaged = true;
  }

  stageTerminalConversationHistory(result: AgentRuntimeResult): void {
    if (result.type === "ask_user" || this.terminalConversationHistoryStaged) return;
    const content = result.type === "message" ? result.content : result.summary;
    const messages = structuredClone(
      this.conversationHistorySnapshot ??
        this.committedQueryState?.messages ?? [...this.initialMessages],
    );
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: content }],
    });
    this.conversationHistorySnapshot = messages;
    this.terminalConversationHistoryStaged = true;
  }

  setInflightQuery(
    phase: DurableQueryInflightSnapshot["phase"],
    workspace: AgentIterationWorkspace,
    activeToolUses?: readonly import("../../gateway/types").AgentModelToolUseBlock[],
  ): void {
    this.inflightQuery = {
      phase,
      workspace: iterationWorkspaceSnapshot(workspace),
      ...(activeToolUses?.length ? { activeToolUses: structuredClone([...activeToolUses]) } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const task of this.backgroundTasks.snapshot()) {
      if ((task.status === "scheduled" || task.status === "running") && task.toolUseId) {
        this.eventPorts.renderer({
          type: "tool-state",
          toolCallId: task.toolUseId,
          toolName: task.toolName,
          status: "denied",
          message: `后台任务 ${task.bgId} 随运行结束而取消`,
        });
      }
    }
    this.abortController.abort();
    this.options.signal?.removeEventListener("abort", this.forwardAbort);
    this.backgroundTasks.setOnStateChange(undefined);
    this.taskSubscription?.dispose();

    try {
      await this.checkpoints.close();
    } catch (error) {
      this.warn(`Checkpoint cleanup failed: ${errorMessage(error)}`);
    }
  }

  private attachBackgroundCheckpoint(): void {
    this.backgroundTasks.setOnStateChange(async () => {
      try {
        await this.persistCheckpoint();
      } catch (error) {
        this.session.appendTranscript({
          role: "system",
          kind: "background_checkpoint_error",
          content: errorMessage(error),
        });
      }
    });
  }

  private restoreBackgroundRecovery(): void {
    const { recovered, session } = this;
    if (
      recovered &&
      recovered.backgroundTasks === undefined &&
      (recovered.status === "running" ||
        recovered.status === "interrupted" ||
        recovered.status === "failed")
    ) {
      const interruptedBackgroundTasks = recovered.transcript.flatMap((entry) => {
        const result = entry.result;
        if (!result || typeof result !== "object" || Array.isArray(result)) return [];
        const record = result as Record<string, unknown>;
        if (record.status !== "running" || typeof record.backgroundTaskId !== "string") return [];
        return [
          {
            id: record.backgroundTaskId,
            toolName: typeof entry.toolName === "string" ? entry.toolName : "background-task",
          },
        ];
      });
      if (interruptedBackgroundTasks.length > 0) {
        const recoveryNotice = interruptedBackgroundTasks
          .map((task) =>
            [
              "<task_notification>",
              `  <task_id>${task.id}</task_id>`,
              "  <status>failed</status>",
              `  <tool>${task.toolName}</tool>`,
              "  <error>The application restarted before this background task committed its result. Inspect durable artifacts before retrying.</error>",
              "</task_notification>",
            ].join("\n"),
          )
          .join("\n\n");
        session.appendPendingUserContent(recoveryNotice);
        session.appendTranscript({ role: "system", kind: "recovery", content: recoveryNotice });
      }
    }
  }

  private warn(message: string): void {
    this.eventPorts.renderer({ type: "workflow-warning", message });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pairPendingToolResults(
  messages: readonly AgentModelMessage[],
  pendingToolResults: readonly import("../../gateway/types").AgentModelToolResultBlock[],
): AgentModelMessage[] {
  const cloned = structuredClone([...messages]);
  if (pendingToolResults.length === 0) return cloned;
  cloned.push({
    role: "user",
    content: structuredClone([...pendingToolResults]),
  });
  return cloned;
}

function completedConversationHistory(
  checkpoint: DurableRunCheckpoint | undefined,
): AgentModelMessage[] | undefined {
  if (checkpoint?.status !== "completed") return undefined;
  if (checkpoint.version === 2) {
    return checkpoint.terminalHistory ? structuredClone(checkpoint.terminalHistory) : undefined;
  }
  return pairPendingToolResults(checkpoint.modelMessages, checkpoint.pendingToolResults);
}

function legacyVisibleHistory(
  options: AgentRuntimeOptions,
): Array<{ role: "user" | "assistant"; content: string }> {
  const history = structuredClone(options.messageHistory ?? []);
  const last = history.at(-1);
  if (last?.role === "user" && last.content === options.request) history.pop();
  return history;
}

function queryStateSnapshot(state: AgentQueryState): DurableQueryStateSnapshot {
  return {
    messages: structuredClone(state.messages),
    turnCount: state.turnCount,
    transition: state.transition ? { ...state.transition } : undefined,
    maxOutputTokensOverride: state.maxOutputTokensOverride,
    maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount,
    hasAttemptedReactiveCompact: state.hasAttemptedReactiveCompact,
    validationFailuresByTool: [...state.validationFailuresByTool.entries()],
  };
}

function iterationWorkspaceSnapshot(
  workspace: AgentIterationWorkspace,
): DurableIterationWorkspaceSnapshot {
  return {
    messagesForQuery: structuredClone(workspace.messagesForQuery),
    assistantMessages: structuredClone(workspace.assistantMessages),
    toolUseBlocks: structuredClone(workspace.toolUseBlocks),
    toolResults: structuredClone(workspace.toolResults),
    userContent: [...workspace.userContent],
    followUpMessages: structuredClone(workspace.followUpMessages),
    needsFollowUp: workspace.needsFollowUp,
    maxOutputTokensOverride: workspace.maxOutputTokensOverride,
    maxOutputTokensRecoveryCount: workspace.maxOutputTokensRecoveryCount,
    hasAttemptedReactiveCompact: workspace.hasAttemptedReactiveCompact,
    validationFailuresByTool: [...workspace.validationFailuresByTool.entries()],
  };
}

function findLegacyInflightAssistantIndex(checkpoint: LegacyDurableRunCheckpoint): number {
  const inflightIds = new Set([
    ...checkpoint.queuedToolUses.map((toolUse) => toolUse.id),
    ...checkpoint.pendingToolResults.map((result) => result.toolUseId),
    ...(checkpoint.activeToolUse ? [checkpoint.activeToolUse.id] : []),
  ]);
  if (inflightIds.size === 0) return -1;
  for (let index = checkpoint.modelMessages.length - 1; index >= 0; index -= 1) {
    const message = checkpoint.modelMessages[index];
    if (
      message?.role === "assistant" &&
      message.content.some((block) => block.type === "tool_use" && inflightIds.has(block.id))
    )
      return index;
  }
  return -1;
}

function legacyIterationWorkspace(
  checkpoint: DurableRunCheckpoint | undefined,
  state: AgentQueryState,
  toolUseContext: AgentQueryState["toolUseContext"],
): AgentIterationWorkspace | undefined {
  if (checkpoint?.version !== 1 || checkpoint.queryLifecycle) return undefined;
  const assistantIndex = findLegacyInflightAssistantIndex(checkpoint);
  if (assistantIndex < 0) return undefined;
  const assistant = checkpoint.modelMessages[assistantIndex];
  if (assistant?.role !== "assistant") return undefined;
  const toolUseBlocks = assistant.content.filter((block) => block.type === "tool_use");
  return {
    messagesForQuery: structuredClone(state.messages),
    assistantMessages: [structuredClone(assistant)],
    toolUseBlocks: structuredClone(toolUseBlocks),
    toolResults: structuredClone(checkpoint.pendingToolResults),
    userContent: [],
    followUpMessages: [],
    needsFollowUp: false,
    updatedToolUseContext: toolUseContext,
    maxOutputTokensOverride: state.maxOutputTokensOverride,
    maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount,
    hasAttemptedReactiveCompact: state.hasAttemptedReactiveCompact,
    validationFailuresByTool: new Map(state.validationFailuresByTool),
  };
}

function checkpointState(
  checkpoint: DurableRunCheckpoint | undefined,
): DurableQueryStateSnapshot | undefined {
  if (!checkpoint) return undefined;
  return checkpoint.version === 1
    ? checkpoint.queryLifecycle?.committedState
    : checkpoint.committedState;
}

function checkpointInflight(
  checkpoint: DurableRunCheckpoint | undefined,
): DurableQueryInflightSnapshot | undefined {
  if (!checkpoint) return undefined;
  return checkpoint.version === 1 ? checkpoint.queryLifecycle?.inflight : checkpoint.inflight;
}

function legacyMessages(checkpoint: DurableRunCheckpoint): AgentModelMessage[] {
  return checkpoint.version === 1 ? checkpoint.modelMessages : checkpoint.committedState.messages;
}

function interruptedToolResult(toolUseId: string) {
  return {
    type: "tool_result" as const,
    toolUseId,
    isError: true,
    content: [
      {
        type: "text" as const,
        text: "The application restarted while this tool was running. Its side effects are uncertain. Inspect durable workspace artifacts and task state before deciding whether to retry; do not assume either success or failure.",
      },
    ],
  };
}

function appendUserText(messages: AgentModelMessage[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const last = messages.at(-1);
  if (last?.role === "user" && !last.content.some((block) => block.type === "tool_result")) {
    last.content.push({ type: "text", text: trimmed });
    return;
  }
  messages.push({
    role: "user",
    content: [{ type: "text", text: trimmed }],
  });
}

function materializeWorkspaceMessages(
  state: AgentQueryState,
  workspace: AgentIterationWorkspace,
): AgentModelMessage[] {
  const messages = [
    ...structuredClone(workspace.messagesForQuery),
    ...structuredClone(workspace.assistantMessages),
  ];
  if (workspace.toolResults.length > 0 || workspace.userContent.length > 0) {
    messages.push({
      role: "user",
      content: [
        ...structuredClone(workspace.toolResults),
        ...workspace.userContent.map((text) => ({
          type: "text" as const,
          text,
        })),
      ],
    });
  }
  messages.push(...structuredClone(workspace.followUpMessages));
  return messages.length > 0 ? messages : structuredClone(state.messages);
}
