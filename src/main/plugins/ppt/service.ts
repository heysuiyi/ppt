import { canonicalJson, hashArtifactValue } from "@ppt/core/artifact-hash";
import type { AgentExecutionStrategy, AgentModelSelection } from "@shared/agent";
import type { AgentStepLimits } from "@shared/agent-step-limits";
import type { AgentTaskNode } from "@shared/agent-task-list";
import {
  type CommandBus,
  type PresentationCommand,
  presentationCommandSchema,
} from "@shared/commands";
import type { AgentEditorContext, AgentRunResult } from "@shared/ipc";
import type { Presentation } from "@shared/presentation";
import {
  type ArtifactDependency,
  asPresentationId,
  asProposalId,
  type BlobReference,
  type PptJobId,
  type PptStageRunId,
  type ProposalId,
  type QueryId,
} from "@shared/presentation-lifecycle";
import type { AgentConversationMessage } from "@shared/session-recovery";
import type { TeammateProgressEvent } from "@shared/teammate-progress";
import {
  DurableServiceStore,
  type DurableServiceThread,
} from "../../agent/persistence/durable-service-store";
import type { AgentRuntime } from "../../agent/runtime/agent-runtime";
import { formatRecoverableAgentError } from "../../agent/runtime/errors/user-facing";
import { isRuntimeCancellation } from "../../agent/runtime/lifecycle/runtime-cancellation";
import type { QueryStartMode } from "../../agent/runtime/query/query-types";
import type { ToolApprovalHandler } from "../../agent/runtime/tools/permission-check";
import type { ToolApprovalBroker } from "../../agent/runtime/tools/tool-approval-broker";
import type { MessageBus } from "../../agent/teammate/message-bus";
import type { TeammateManager } from "../../agent/teammate/spawn-teammate";
import type { ConversationDatabase } from "../../conversation-database";
import type { ContentAddressedBlobStore } from "../../presentation-lifecycle/content-addressed-blob-store";
import type { PresentationLifecycleOrchestrator } from "../../presentation-lifecycle/presentation-lifecycle-orchestrator";
import type { CommitGate, CommitGateResult } from "./gate/commit-gate";

export type AgentServiceEvent =
  | { type: "request-status"; message: string; progress: number }
  | { type: "workflow-progress"; message: string; progress: number }
  | {
      type: "text-chunk";
      chunk: string;
      attemptId?: string;
    }
  | { type: "text-reset"; attemptId: string }
  | { type: "text-commit"; attemptId: string }
  | { type: "thinking-chunk"; chunk: string; modelStep?: number }
  | { type: "stage-started"; message: string; stage: string }
  | {
      type: "tool-state";
      message: string;
      toolCallId: string;
      toolName: string;
      status: "running" | "completed" | "failed" | "denied" | "invalid-input";
      error?: string;
    }
  | {
      type: "slide-preview-ready";
      message: string;
      toolCallId: string;
      toolName?: "PreviewSlide" | "PreviewSvgPage";
      slideId: string;
      title: string;
      description: string;
      thumbnail: {
        pngBase64: string;
        width: number;
        height: number;
        mimeType: "image/png";
      } | null;
      thumbnailError?: string;
    }
  | { type: "approval-waiting"; message: string }
  | {
      type: "tool-approval-waiting";
      message: string;
      approvalId: string;
      toolName: string;
      reason: string;
      detail: string;
    }
  | {
      type: "tool-approval-resolved";
      message: string;
      approvalId: string;
      toolName: string;
      status: "approved" | "denied";
    }
  | {
      type: "task-list-updated";
      message: string;
      tasks: AgentTaskNode[];
      goal?: string | null;
      listRevision?: number;
      state?: "open" | "closed" | "archived";
      archive?: {
        outcome: "completed" | "abandoned";
        reason?: string;
        archivedBy: string;
        archivedAt: string;
      };
    }
  | TeammateProgressEvent;

export type AgentServiceEventListener = (event: AgentServiceEvent) => void;

type LifecycleCandidateAttempt = {
  stageRunId: PptStageRunId;
  commandsBlob: BlobReference;
  commandCount: number;
};

type ContinuedConversation = {
  messages: AgentConversationMessage[];
  model?: AgentModelSelection;
  executionStrategy: AgentExecutionStrategy;
  suspendedQuery: boolean;
};

export interface DirectCommandProposal {
  threadId: string;
  request: string;
  commands: PresentationCommand[];
  summary: string;
  assumptions?: string[];
  risk: "low" | "medium" | "high";
  model?: AgentModelSelection;
  executionStrategy?: AgentExecutionStrategy;
  listener?: AgentServiceEventListener;
}

export interface PresentationProposalCommitService {
  applyProposal(
    commands: PresentationCommand[],
    identity: { jobId: PptJobId; proposalId: ProposalId },
  ): Promise<Presentation>;
}

/** Coordinates Runtime, Commit Gate, approval persistence and CommandBus writes. */
export class AgentService {
  private readonly conversations = new Map<string, ContinuedConversation>();
  private readonly runningThreads = new Set<string>();
  private readonly durableStore?: DurableServiceStore;

  constructor(
    private readonly commandBus: CommandBus,
    private readonly runtime: AgentRuntime,
    private readonly commitGate: CommitGate,
    private readonly workspaceRoot?: string,
    private readonly toolApprovalBroker?: ToolApprovalBroker,
    private readonly messageBus?: MessageBus,
    private readonly teammateManager?: TeammateManager,
    conversationDatabase?: ConversationDatabase,
    private readonly runtimeRoot?: string,
    private readonly presentationLifecycle?: PresentationLifecycleOrchestrator,
    private readonly presentationCommitService?: PresentationProposalCommitService,
    private readonly lifecycleBlobStore?: ContentAddressedBlobStore,
  ) {
    this.durableStore = conversationDatabase
      ? new DurableServiceStore(conversationDatabase)
      : workspaceRoot
        ? new DurableServiceStore(workspaceRoot)
        : undefined;
  }

  hasActiveConversation(threadId: string): boolean {
    return this.conversations.has(threadId);
  }

  private async withThreadRun<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    if (this.runningThreads.has(threadId)) {
      throw new Error(`Agent thread ${threadId} already has an active run.`);
    }
    this.runningThreads.add(threadId);
    try {
      return await operation();
    } finally {
      this.runningThreads.delete(threadId);
    }
  }

  restoreAgentRunConversation(
    threadId: string,
    messages: AgentConversationMessage[],
    model?: AgentModelSelection,
    executionStrategy: AgentExecutionStrategy = "REQUEST_APPROVAL",
  ): void {
    this.conversations.set(threadId, {
      messages: structuredClone(messages),
      model,
      executionStrategy,
      suspendedQuery: false,
    });
  }

  async restoreDurableThread(threadId: string): Promise<boolean> {
    const state = await this.durableStore?.load(threadId);
    if (!state) return false;
    if (state.status === "active" || state.status === "waiting_user") {
      this.conversations.set(threadId, {
        messages: structuredClone(state.messages),
        model: state.model,
        executionStrategy: state.executionStrategy,
        suspendedQuery: state.status === "waiting_user",
      });
      return true;
    }
    return false;
  }

  private async persistThread(
    threadId: string,
    state: Omit<DurableServiceThread, "version" | "threadId" | "updatedAt">,
  ): Promise<void> {
    await this.durableStore?.save({
      version: 1,
      threadId,
      ...state,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 开启新的可恢复 Agent 会话，并以稳定 threadId 保存首轮上下文。
   * 此处只建立服务级生命周期；模型与工具循环由 run() 统一编排。
   */
  async start(
    request: string,
    model?: AgentModelSelection,
    executionStrategy: AgentExecutionStrategy = "REQUEST_APPROVAL",
    listener?: AgentServiceEventListener,
    editorContext?: AgentEditorContext,
    messageHistory: AgentConversationMessage[] = [],
    signal?: AbortSignal,
    runId?: string,
    agentStepLimits?: AgentStepLimits,
  ): Promise<AgentRunResult> {
    // A caller-provided run id is stable across renderer/main persistence and
    // doubles as the recoverable thread id for an interrupted first turn.
    const threadId = runId ?? crypto.randomUUID();
    const invocationRunId = runId ?? crypto.randomUUID();
    return this.withThreadRun(threadId, async () => {
      this.conversations.set(threadId, {
        messages: [...structuredClone(messageHistory), { role: "user", content: request }],
        model,
        executionStrategy,
        suspendedQuery: false,
      });
      await this.persistThread(threadId, {
        status: "active",
        messages: structuredClone(this.conversations.get(threadId)!.messages),
        model,
        executionStrategy,
      });
      return this.run(
        threadId,
        request,
        model,
        executionStrategy,
        messageHistory,
        listener,
        editorContext,
        "any",
        false,
        signal,
        invocationRunId,
        agentStepLimits,
      );
    });
  }

  async continueAgentRun(
    threadId: string,
    request: string,
    listener?: AgentServiceEventListener,
    editorContext?: AgentEditorContext,
    signal?: AbortSignal,
    runId?: string,
    agentStepLimits?: AgentStepLimits,
    modelOverride?: AgentModelSelection,
    executionStrategyOverride?: AgentExecutionStrategy,
  ): Promise<AgentRunResult> {
    const invocationRunId = runId ?? crypto.randomUUID();
    return this.withThreadRun(threadId, async () => {
      const conversation = this.conversations.get(threadId);
      if (!conversation) throw new Error("Agent conversation not found or already completed.");
      const model = modelOverride ?? conversation.model;
      if (executionStrategyOverride) {
        conversation.executionStrategy = executionStrategyOverride;
      }
      const startMode: QueryStartMode = conversation.suspendedQuery
        ? { type: "resume_query", reason: "waiting_user" }
        : { type: "new_query" };
      if (modelOverride) conversation.model = modelOverride;
      conversation.messages.push({ role: "user", content: request });
      await this.persistThread(threadId, {
        status: "active",
        messages: structuredClone(conversation.messages),
        model,
        executionStrategy: conversation.executionStrategy,
      });
      return this.run(
        threadId,
        request,
        model,
        conversation.executionStrategy,
        conversation.messages,
        listener,
        editorContext,
        "any",
        true,
        signal,
        invocationRunId,
        agentStepLimits,
        startMode,
      );
    });
  }

  /**
   * 协调 AgentRuntime、CommitGate 与 CommandBus 的主提交链。
   * Runtime 只能返回消息、追问或命令提案；真实 Presentation 仅在门禁通过后修改。
   */
  private async run(
    threadId: string,
    request: string,
    model: AgentModelSelection | undefined,
    executionStrategy: AgentExecutionStrategy,
    messageHistory: AgentConversationMessage[],
    listener?: AgentServiceEventListener,
    editorContext?: AgentEditorContext,
    requiredOutcome: "any" | "command_proposal" = "any",
    requestAlreadyInHistory = false,
    signal?: AbortSignal,
    runId?: string,
    agentStepLimits?: AgentStepLimits,
    startMode: QueryStartMode = { type: "new_query" },
  ): Promise<AgentRunResult> {
    if (signal?.aborted) {
      this.conversations.delete(threadId);
      this.runtime.clearSession(threadId);
      await this.persistThread(threadId, {
        status: "interrupted",
        messages: structuredClone(messageHistory),
        model,
        executionStrategy,
      });
      return {
        status: "interrupted",
      };
    }
    listener?.({
      type: "stage-started",
      message: "开始处理您的请求...",
      stage: requiredOutcome,
    });
    const before = this.commandBus.getSnapshot();
    let activeQueryId: QueryId | undefined;
    let runtimeResult;
    try {
      runtimeResult = await this.runtime.run({
        threadId,
        request,
        presentationSnapshot: before,
        currentSlideId: editorContext?.currentSlideId,
        selectedElementIds: editorContext?.selectedElementIds ?? [],
        model,
        executionStrategy,
        runId,
        startMode,
        messageHistory,
        requiredOutcome,
        signal,
        workspaceRoot: this.workspaceRoot,
        runtimeRoot: this.runtimeRoot,
        agentStepLimits,
        messageBus: this.messageBus,
        teammateManager: this.teammateManager,
        requestToolApproval: this.resolveToolApprovalHandler(executionStrategy, runId, listener),
        onQueryEvent: (event) => {
          activeQueryId ??= event.queryId;
        },
        onProgress: (ev) => {
          listener?.(ev as AgentServiceEvent);
        },
        ...(listener && {
          onStreamEvent: (event) => {
            if (event.type === "delta") {
              listener({
                type: "text-chunk",
                chunk: event.text,
                attemptId: event.attemptId,
              });
            } else if (event.type === "attempt_reset") {
              listener({ type: "text-reset", attemptId: event.attemptId });
            } else if (event.type === "attempt_committed") {
              listener({ type: "text-commit", attemptId: event.attemptId });
            }
          },
          onThinkingChunk: (chunk: string, modelStep: number) => {
            listener({ type: "thinking-chunk", chunk, modelStep });
          },
        }),
      });
    } catch (error) {
      if (isRuntimeCancellation(error, signal)) {
        this.cancelActivePptQuery(before, activeQueryId);
        this.runtime.clearSession(threadId);
        this.conversations.delete(threadId);
        await this.persistThread(threadId, {
          status: "interrupted",
          messages: structuredClone(messageHistory),
          model,
          executionStrategy,
        });
        return { status: "interrupted" };
      }
      const recoveryMessage = formatRecoverableAgentError(error, signal);
      if (recoveryMessage) {
        this.failActivePptQuery(before, activeQueryId);
        if (!this.conversations.has(threadId)) {
          this.runtime.clearSession(threadId);
        }
        return {
          status: "failed",
          error: recoveryMessage,
          ...(this.conversations.has(threadId) ? { threadId } : {}),
        };
      }
      if (!this.conversations.has(threadId)) {
        this.runtime.clearSession(threadId);
      }
      this.failActivePptQuery(before, activeQueryId);
      throw error;
    }

    if (runtimeResult.type === "message") {
      this.waitForActivePptQuery(
        before,
        activeQueryId,
        "The Query ended without a Presentation lifecycle terminal proof.",
      );
      this.runtime.clearSession(threadId);
      this.conversations.delete(threadId);
      await this.persistThread(threadId, {
        status: "completed",
        messages: [
          ...structuredClone(messageHistory),
          ...(requestAlreadyInHistory ? [] : [{ role: "user" as const, content: request }]),
          { role: "assistant", content: runtimeResult.content },
        ],
        model,
        executionStrategy,
      });
      return { status: "chat", message: runtimeResult.content };
    }

    if (runtimeResult.type === "ask_user") {
      this.waitForActivePptQuery(before, activeQueryId, runtimeResult.content);
      this.conversations.set(threadId, {
        messages: [
          ...messageHistory,
          ...(requestAlreadyInHistory ? [] : [{ role: "user" as const, content: request }]),
          { role: "assistant", content: runtimeResult.content },
        ],
        model,
        executionStrategy,
        suspendedQuery: true,
      });
      await this.persistThread(threadId, {
        status: "waiting_user",
        messages: structuredClone(this.conversations.get(threadId)!.messages),
        model,
        executionStrategy,
      });
      return {
        status: "waiting-user",
        message: runtimeResult.content,
        threadId,
        question: runtimeResult.question,
      };
    }

    if (runtimeResult.type !== "command_proposal") {
      throw new Error(`Unexpected agent runtime result: ${runtimeResult.type}`);
    }

    listener?.({ type: "workflow-progress", message: "正在进行安全校验...", progress: 70 });
    const proposal = runtimeResult;
    let candidateAttempt: LifecycleCandidateAttempt | undefined;
    try {
      candidateAttempt = await this.startLifecycleCandidateAttempt(before, proposal);
    } catch (error) {
      this.failActivePptQuery(before, activeQueryId);
      throw error;
    }
    let gate: CommitGateResult;
    try {
      gate = await this.commitGate.evaluate(before, proposal.commands, proposal.risk, {
        workspaceRoot: this.workspaceRoot,
      });
    } catch (error) {
      this.failLifecycleCandidateAttempt(candidateAttempt, error);
      this.failActivePptQuery(before, activeQueryId);
      throw error;
    }
    if (!gate.success || !gate.preview) {
      this.failLifecycleCandidateAttempt(
        candidateAttempt,
        new Error(gate.errors.join("; ") || "Commit Gate rejected the candidate."),
        gate.errors,
      );
      this.failActivePptQuery(before, activeQueryId);
      throw new Error(`Commit Gate rejected proposal: ${gate.errors.join("; ")}`);
    }

    const canAutoApply = executionStrategy === "AUTO" && gate.decision === "AUTO";
    let lifecycleProposal;
    try {
      lifecycleProposal = await this.recordLifecycleProposal(
        before,
        proposal,
        gate,
        candidateAttempt,
      );
    } catch (error) {
      this.failLifecycleCandidateAttempt(candidateAttempt, error);
      this.failActivePptQuery(before, activeQueryId);
      throw error;
    }
    const completedMessages = [
      ...structuredClone(messageHistory),
      ...(requestAlreadyInHistory ? [] : [{ role: "user" as const, content: request }]),
      { role: "assistant" as const, content: proposal.summary },
    ];
    await this.persistThread(threadId, {
      status: "completed",
      messages: completedMessages,
      model,
      executionStrategy,
    });
    if (canAutoApply) {
      const applied = await this.resumeProposal(lifecycleProposal.proposalId, true);
      this.runtime.clearSession(threadId);
      this.conversations.delete(threadId);
      listener?.({ type: "workflow-progress", message: "修改已完成。", progress: 100 });
      return applied;
    }

    this.runtime.clearSession(threadId);
    this.conversations.delete(threadId);
    listener?.({ type: "approval-waiting", message: "修改方案等待确认。" });
    return {
      status: "approval-required",
      approval: {
        threadId,
        ...lifecycleProposal,
        summary: proposal.summary,
        commands: proposal.commands,
        risk: gate.risk,
        assumptions: proposal.assumptions,
        diff: gate.diff,
        preview: gate.preview,
      },
    };
  }

  /**
   * Submits commands produced by a bounded non-agent pipeline through the exact
   * same gate, preview and durable approval path as an AgentRuntime command
   * proposal.
   */
  async submitDirectProposal(input: DirectCommandProposal): Promise<AgentRunResult> {
    const { threadId, request, commands, summary, assumptions, risk, model, listener } = input;
    const executionStrategy = input.executionStrategy ?? "REQUEST_APPROVAL";
    const before = this.commandBus.getSnapshot();

    listener?.({ type: "workflow-progress", message: "正在进行安全校验...", progress: 70 });
    const candidateAttempt = await this.startLifecycleCandidateAttempt(before, {
      commands,
      summary,
      assumptions,
      risk,
    });
    let gate: CommitGateResult;
    try {
      gate = await this.commitGate.evaluate(before, commands, risk, {
        workspaceRoot: this.workspaceRoot,
      });
    } catch (error) {
      this.failLifecycleCandidateAttempt(candidateAttempt, error);
      throw error;
    }
    if (!gate.success || !gate.preview) {
      this.failLifecycleCandidateAttempt(
        candidateAttempt,
        new Error(gate.errors.join("; ") || "Commit Gate rejected the candidate."),
        gate.errors,
      );
      throw new Error(`Commit Gate rejected proposal: ${gate.errors.join("; ")}`);
    }

    const canAutoApply = executionStrategy === "AUTO" && gate.decision === "AUTO";
    let lifecycleProposal;
    try {
      lifecycleProposal = await this.recordLifecycleProposal(
        before,
        { commands, summary, assumptions, risk },
        gate,
        candidateAttempt,
      );
    } catch (error) {
      this.failLifecycleCandidateAttempt(candidateAttempt, error);
      throw error;
    }
    await this.persistThread(threadId, {
      status: "completed",
      messages: [
        { role: "user", content: request },
        { role: "assistant", content: summary },
      ],
      model,
      executionStrategy,
    });
    if (canAutoApply) {
      const applied = await this.resumeProposal(lifecycleProposal.proposalId, true);
      listener?.({ type: "workflow-progress", message: "修改已完成。", progress: 100 });
      return applied;
    }

    this.runtime.clearSession(threadId);
    this.conversations.delete(threadId);
    listener?.({ type: "approval-waiting", message: "生成结果等待确认。" });
    return {
      status: "approval-required",
      approval: {
        threadId,
        ...lifecycleProposal,
        summary,
        commands,
        risk: gate.risk,
        assumptions,
        diff: gate.diff,
        preview: gate.preview,
      },
    };
  }

  /**
   * Resolves a durable lifecycle Proposal. Commands and risk are reloaded from
   * its immutable command_proposal artifact, so process reconstruction does not
   * depend on an AgentService memory map or service-thread pending state.
   */
  async resumeProposal(
    proposalIdInput: ProposalId | string,
    approved: boolean,
  ): Promise<AgentRunResult> {
    if (!this.presentationLifecycle) {
      throw new Error(
        "Presentation proposal resolution requires the durable lifecycle repository.",
      );
    }

    const proposalId = asProposalId(proposalIdInput);
    const proposal = this.presentationLifecycle.repository.getProposal(proposalId);
    if (!proposal) {
      throw new Error("Approval request not found or already completed.");
    }
    const job = this.presentationLifecycle.repository.getJob(proposal.jobId);
    if (!job) throw new Error(`Unknown PptJob ${proposal.jobId}.`);
    const currentPresentationId = asPresentationId(this.commandBus.getSnapshot().id);
    if (job.params.presentationId !== currentPresentationId) {
      throw new Error(
        `Proposal ${proposalId} belongs to Presentation ` +
          `${job.params.presentationId}, not ${currentPresentationId}.`,
      );
    }
    if (proposal.status === "applied") {
      if (!approved) {
        throw new Error("The proposal was already applied and cannot be rejected.");
      }
      if (!this.presentationCommitService) {
        throw new Error("Presentation proposal application requires PresentationCommitService.");
      }
      const artifact = this.presentationLifecycle.getCommandProposalArtifact(proposalId);
      const commands = await this.loadLifecycleCommands(
        artifact.value.commandsBlob,
        artifact.value.commandCount,
      );
      const presentation = await this.presentationCommitService.applyProposal(commands, {
        jobId: proposal.jobId,
        proposalId,
      });
      return { status: "completed", presentation };
    }
    if (proposal.status === "rejected") {
      if (approved) {
        throw new Error("The proposal was already rejected and cannot be applied.");
      }
      return { status: "rejected", presentation: this.commandBus.getSnapshot() };
    }
    if (proposal.status !== "waiting_approval") {
      throw new Error(`Proposal ${proposalId} is ${proposal.status} and cannot be resolved.`);
    }

    if (!approved) {
      this.presentationLifecycle.rejectProposal(proposalId);
      return { status: "rejected", presentation: this.commandBus.getSnapshot() };
    }

    if (
      job.status !== "waiting_approval" ||
      job.proposalId !== proposalId ||
      job.currentRequest.requestId !== proposal.requestId
    ) {
      throw new Error("The proposal is no longer the active approval for this Presentation.");
    }
    const artifact = this.presentationLifecycle.getCommandProposalArtifact(proposalId);
    const commands = await this.loadLifecycleCommands(
      artifact.value.commandsBlob,
      artifact.value.commandCount,
    );
    const current = this.commandBus.getSnapshot();
    const artifactIsStale = job.staleArtifacts.some(
      (stale) => stale.revisionId === proposal.artifactRevisionId,
    );
    const baseIdentityChanged =
      proposal.basePresentationRevisionId !== undefined &&
      job.presentationRevisionId !== proposal.basePresentationRevisionId;
    if (
      artifactIsStale ||
      baseIdentityChanged ||
      current.revision !== proposal.basePresentationRevisionNumber
    ) {
      this.presentationLifecycle.rejectProposal(proposalId);
      throw new Error(
        artifactIsStale
          ? "The proposal became stale. Generate a new proposal before applying."
          : "The presentation changed after preview. Generate a new proposal before applying.",
      );
    }

    const gate = await this.commitGate.evaluate(current, commands, artifact.value.modelRisk, {
      workspaceRoot: this.workspaceRoot,
    });
    if (!gate.success || !gate.preview) {
      this.presentationLifecycle.rejectProposal(proposalId);
      throw new Error(`Commit Gate rejected approved proposal: ${gate.errors.join("; ")}`);
    }

    if (!this.presentationCommitService) {
      throw new Error("Presentation proposal application requires PresentationCommitService.");
    }
    const presentation = await this.presentationCommitService.applyProposal(commands, {
      jobId: proposal.jobId,
      proposalId,
    });
    return { status: "completed", presentation };
  }

  private async recordLifecycleProposal(
    before: Presentation,
    proposal: {
      commands: PresentationCommand[];
      summary: string;
      assumptions?: string[];
      risk: "low" | "medium" | "high";
    },
    gate: CommitGateResult,
    candidateAttempt?: LifecycleCandidateAttempt,
  ): Promise<{
    jobId: PptJobId;
    queryId: QueryId;
    proposalId: ProposalId;
  }> {
    if (!this.presentationLifecycle) {
      throw new Error("Presentation proposals require the durable lifecycle repository.");
    }
    return this.presentationLifecycle.withTransaction(() => {
      const state = this.presentationLifecycle!.getState(asPresentationId(before.id));
      if (!state?.currentRequest.queryId) {
        throw new Error(
          "Presentation proposal tools require BeginPptCapability in the current Query.",
        );
      }
      if (!candidateAttempt) {
        throw new Error(
          "Presentation lifecycle command candidates require durable blob preparation.",
        );
      }
      const committedAt = new Date().toISOString();
      const isCandidateDeck = proposal.commands.some((command) => command.type === "add-slide");
      const dependencyStages = isCandidateDeck
        ? new Set(["design_spec", "page_plan", "page_svg", "preview", "presentation"])
        : new Set(["presentation"]);
      const staleRevisionIds = new Set(state.staleArtifacts.map((artifact) => artifact.revisionId));
      const baseDependencies = state.committedArtifacts
        .filter(
          (pointer) =>
            dependencyStages.has(pointer.stage) && !staleRevisionIds.has(pointer.revisionId),
        )
        .map(toDependency);
      const candidate = this.presentationLifecycle!.commitArtifact({
        jobId: state.jobId,
        artifactId: `candidate:${state.currentRequest.requestId}`,
        kind: isCandidateDeck ? "candidate_deck" : "candidate_commands",
        stage: "candidate",
        value: {
          commandsBlob: candidateAttempt.commandsBlob,
          commandCount: candidateAttempt.commandCount,
          summary: proposal.summary,
          risk: proposal.risk,
          ...(proposal.assumptions ? { assumptions: proposal.assumptions } : {}),
        },
        dependencies: baseDependencies,
        validation: passedLifecycleValidation("presentation-command-schema", committedAt),
        idempotencyKey: `candidate:${state.currentRequest.requestId}`,
        committedAt,
      });
      this.presentationLifecycle!.finishStageAttempt({
        stageRunId: candidateAttempt.stageRunId,
        status: "succeeded",
        artifactRevisionId: candidate.pointer.revisionId,
        validation: passedLifecycleValidation("presentation-command-schema", committedAt),
        completedAt: committedAt,
      });
      const _quality = this.presentationLifecycle!.commitArtifact({
        jobId: state.jobId,
        artifactId: `quality:${state.currentRequest.requestId}`,
        kind: "quality_report",
        stage: "quality",
        value: {
          success: gate.success,
          errors: gate.errors,
          risk: gate.risk,
          decision: gate.decision,
          ...(gate.warnings ? { warnings: gate.warnings } : {}),
          ...(gate.diff ? { diff: gate.diff } : {}),
        },
        dependencies: [toDependency(candidate.pointer)],
        validation: passedLifecycleValidation("commit-gate", committedAt),
        idempotencyKey: `quality:${state.currentRequest.requestId}`,
        committedAt,
      });
      const stored = this.presentationLifecycle!.recordCommandProposal({
        jobId: state.jobId,
        queryId: state.currentRequest.queryId,
        commandsBlob: candidateAttempt.commandsBlob,
        commandCount: candidateAttempt.commandCount,
        summary: proposal.summary,
        modelRisk: proposal.risk,
        assumptions: proposal.assumptions,
        gate: {
          risk: gate.risk,
          decision: gate.decision === "AUTO" ? "AUTO" : "REQUIRES_APPROVAL",
          warnings: gate.warnings,
          diff: gate.diff,
        },
        basePresentationRevisionId: state.presentationRevisionId,
        basePresentationRevisionNumber: before.revision,
        createdAt: committedAt,
      });
      return {
        jobId: state.jobId,
        queryId: state.currentRequest.queryId,
        proposalId: stored.proposal.proposalId,
      };
    });
  }

  private async startLifecycleCandidateAttempt(
    presentation: Presentation,
    proposal: {
      commands: PresentationCommand[];
      summary: string;
      assumptions?: string[];
      risk: "low" | "medium" | "high";
    },
  ): Promise<LifecycleCandidateAttempt | undefined> {
    if (!this.presentationLifecycle) return undefined;
    const state = this.presentationLifecycle.getState(asPresentationId(presentation.id));
    if (!state?.currentRequest.queryId) return undefined;
    const commandsBlob = await this.putLifecycleCommands(proposal.commands);
    const candidate = {
      commandsBlob,
      commandCount: proposal.commands.length,
      summary: proposal.summary,
      risk: proposal.risk,
      ...(proposal.assumptions ? { assumptions: proposal.assumptions } : {}),
    };
    const candidateHash = hashArtifactValue(candidate);
    const stageRunId = this.presentationLifecycle.startStageAttempt({
      jobId: state.jobId,
      stage: "candidate",
      candidate,
      idempotencyKey: `candidate:${state.currentRequest.requestId}:${candidateHash}`,
    }).stageRunId;
    return {
      stageRunId,
      commandsBlob,
      commandCount: proposal.commands.length,
    };
  }

  private failLifecycleCandidateAttempt(
    candidateAttempt: LifecycleCandidateAttempt | undefined,
    error: unknown,
    issues: string[] = [],
  ): void {
    if (!this.presentationLifecycle || !candidateAttempt) return;
    const { stageRunId } = candidateAttempt;
    const attempt = this.presentationLifecycle.repository.getStageAttempt(stageRunId);
    if (attempt?.status !== "running") return;
    const completedAt = new Date().toISOString();
    this.presentationLifecycle.finishStageAttempt({
      stageRunId,
      status: "failed",
      validation: {
        status: "failed",
        validator: "commit-gate",
        issues: (issues.length > 0
          ? issues
          : [error instanceof Error ? error.message : String(error)]
        ).map((message) => ({
          severity: "error" as const,
          code: "commit_gate_rejected",
          message,
        })),
        validatedAt: completedAt,
      },
      error: error instanceof Error ? error.message : String(error),
      completedAt,
    });
  }

  private async putLifecycleCommands(commands: PresentationCommand[]): Promise<BlobReference> {
    if (!this.lifecycleBlobStore) {
      throw new Error(
        "Presentation lifecycle command persistence requires a content-addressed blob store.",
      );
    }
    const parsed = presentationCommandSchema.array().min(1).parse(commands);
    return this.lifecycleBlobStore.put(
      Buffer.from(canonicalJson(parsed), "utf8"),
      "application/vnd.agent-ppt.presentation-commands+json",
    );
  }

  private async loadLifecycleCommands(
    reference: BlobReference,
    expectedCount: number,
  ): Promise<PresentationCommand[]> {
    if (!this.lifecycleBlobStore) {
      throw new Error(
        "Presentation lifecycle proposal application requires a content-addressed blob store.",
      );
    }
    const bytes = await this.lifecycleBlobStore.get(reference);
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`Command blob ${reference.contentHash} is not valid JSON.`);
    }
    const commands = presentationCommandSchema.array().min(1).parse(decoded);
    if (commands.length !== expectedCount) {
      throw new Error(
        `Command blob ${reference.contentHash} count mismatch: ` +
          `expected ${expectedCount}, received ${commands.length}.`,
      );
    }
    return commands;
  }

  private resolveToolApprovalHandler(
    executionStrategy: AgentExecutionStrategy,
    runId: string | undefined,
    listener: AgentServiceEventListener | undefined,
  ): ToolApprovalHandler | undefined {
    if (executionStrategy === "AUTO") {
      return async () => true;
    }
    if (runId && listener && this.toolApprovalBroker) {
      return this.toolApprovalBroker.createHandler(runId, listener);
    }
    return undefined;
  }

  private waitForActivePptQuery(
    presentation: Presentation,
    queryId: QueryId | undefined,
    reason: string,
  ): void {
    const state = this.activePptJobForQuery(presentation, queryId);
    if (state?.status === "running") {
      this.presentationLifecycle!.waitForUser(
        state.jobId,
        `${reason} Last committed stage: ${state.currentStage}.`,
      );
    }
  }

  private failActivePptQuery(presentation: Presentation, queryId: QueryId | undefined): void {
    const state = this.activePptJobForQuery(presentation, queryId);
    if (state?.status === "running") {
      this.presentationLifecycle!.fail(state.jobId);
    }
  }

  private cancelActivePptQuery(presentation: Presentation, queryId: QueryId | undefined): void {
    const state = this.activePptJobForQuery(presentation, queryId);
    if (state?.status === "running") {
      this.presentationLifecycle!.cancel(state.jobId);
    }
  }

  private activePptJobForQuery(presentation: Presentation, queryId: QueryId | undefined) {
    if (!this.presentationLifecycle || !queryId) return undefined;
    const state = this.presentationLifecycle.getState(asPresentationId(presentation.id));
    return state?.currentRequest.queryId === queryId ? state : undefined;
  }
}

function toDependency(pointer: {
  artifactId: ArtifactDependency["artifactId"];
  revisionId: ArtifactDependency["revisionId"];
  contentHash: ArtifactDependency["contentHash"];
}): ArtifactDependency {
  return {
    artifactId: pointer.artifactId,
    revisionId: pointer.revisionId,
    contentHash: pointer.contentHash,
  };
}

function passedLifecycleValidation(validator: string, validatedAt: string) {
  return {
    status: "passed" as const,
    validator,
    issues: [],
    validatedAt,
  };
}
