import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AgentActivityItem,
  appendReasoningChunk,
  appendResponseChunk,
  appendStep,
  appendToolApprovalWaiting,
  appendToolStart,
  applyTeammateProgressEvent,
  commitResponseAttempt,
  compactActivityTraceForPersistence,
  finishTool,
  markTraceComplete,
  mergeResponseText,
  removeResponseAttempt,
  resolveToolApprovalItem,
  sealAllReasoning,
  sealResponseBlocks,
  upsertTaskListTrace,
} from "@shared/agent-activity";
import { formatPublicErrorMessage } from "@shared/agent-activity-display";
import { formatTerminalAgentRunContent } from "@shared/agent-result-copy";
import { agentTaskNodeSchema } from "@shared/agent-task-list";
import {
  type PersistedDisplayCard,
  persistedDisplayCardSchema,
} from "@shared/card-display-protocol";
import type { DeckExportRecord, DeckGenerationJobsFile } from "@shared/deck-persistence";
import type {
  AgentRunResult,
  CreateSessionOptions,
  ImportProjectTemplateResult,
  ProjectTemplateSummary,
} from "@shared/ipc";
import { type Presentation, presentationSchema } from "@shared/presentation";
import { defaultProjectArtifacts } from "@shared/project";
import {
  createDefaultSessionTitle,
  createSessionPresentation,
  type SessionBootstrap,
  type SessionChatMessage,
  type SessionSnapshot,
  type SessionSummary,
  sessionChatMessageSchema,
  sessionSnapshotSchema,
} from "@shared/session";
import { type AgentConversationMessage, toAgentMessageHistory } from "@shared/session-recovery";
import { parseStoryboard, type StoryboardSlideSpec, serializeStoryboard } from "@shared/storyboard";
import { isTeammateProgressEvent } from "@shared/teammate-progress";
import { getBuiltinTemplate, listBuiltinTemplates } from "@shared/template-catalog";
import {
  createDefaultProjectTemplatePolicy,
  formatProjectTemplatePolicy,
  type ProjectTemplatePolicy,
  projectTemplatePolicySchema,
  TEMPLATE_PACK_PATH,
  TEMPLATE_POLICY_PATH,
  type TemplatePack,
  templatePackSchema,
  templateRevisionPath,
} from "@shared/template-protocol";
import {
  compareSessionsByActivity,
  getWorkspaceLabel,
  normalizeWorkspacePath,
  resolveWorkspacePath,
} from "@shared/workspace";
import { getSessionSandboxPath, isLegacyProjectSandboxPath } from "@shared/workspace-meta";
import { z } from "zod";
import { createModuleLogger } from "./agent/logger";
import { writeTextFileAtomic } from "./agent/persistence/atomic-json-file";
import { ConversationDatabase } from "./conversation-database";
import { ExportHistoryService, GenerationJobsService } from "./deck/deck-persistence-services";
import type { ArtifactChangeObserverPort } from "./presentation-lifecycle/artifact-change-observer-types";
import type { ArtifactDiff } from "./project/artifact-diff";
import {
  type ProjectArtifactReadResult,
  type ProjectFileEditorReadResult,
  type ProjectFileEditorWriteResult,
  ProjectFileService,
} from "./project/project-file-service";
import {
  applicationTemplateLibrary,
  importTemplatePackage,
  listTemplateDescriptors,
  listUploadedTemplateDescriptors,
} from "./project/template-import-service";
import { materializeCustomTemplate } from "./project/template-materialize-service";

const storedSessionSchema = sessionSnapshotSchema;
const logger = createModuleLogger("session-store");
const sessionFileSchema = z.object({
  version: z.literal(1),
  activeSessionId: z.string(),
  sessions: z.array(storedSessionSchema),
});

type SessionFile = z.infer<typeof sessionFileSchema>;

type RunTranscript = {
  trace: AgentActivityItem[];
  content: string;
};

function sameProjectedActivity(
  existing: AgentActivityItem,
  existingContent: string,
  projected: AgentActivityItem,
  projectedContent: string,
): boolean {
  if (existing.kind !== projected.kind) return false;
  if (existing.kind === "response" && projected.kind === "response") {
    if (existing.attemptId || projected.attemptId) {
      return existing.attemptId === projected.attemptId;
    }
    const existingText = existingContent.slice(existing.start, existing.end);
    const projectedText = projectedContent.slice(projected.start, projected.end);
    return (
      existingText === projectedText ||
      existingText.startsWith(projectedText) ||
      projectedText.startsWith(existingText)
    );
  }
  if (existing.kind === "reasoning" && projected.kind === "reasoning") {
    return (
      (existing.modelStep ?? 0) === (projected.modelStep ?? 0) &&
      (existing.content === projected.content ||
        existing.content.startsWith(projected.content) ||
        projected.content.startsWith(existing.content))
    );
  }
  if (existing.kind === "tool" && projected.kind === "tool") {
    return existing.toolCallId === projected.toolCallId;
  }
  if (existing.kind === "step" && projected.kind === "step") {
    return existing.text === projected.text;
  }
  if (existing.kind === "tasklist" && projected.kind === "tasklist") {
    return true;
  }
  if (existing.kind === "tool-approval" && projected.kind === "tool-approval") {
    return existing.approvalId === projected.approvalId;
  }
  if (existing.kind === "task" && projected.kind === "task") {
    return existing.taskId === projected.taskId;
  }
  return false;
}

function processActivityIdentity(item: AgentActivityItem): string {
  if (item.kind === "tool") return `tool:${item.toolCallId}`;
  if (item.kind === "tool-approval") return `approval:${item.approvalId}`;
  if (item.kind === "task") return `task:${item.taskId}`;
  if (item.kind === "tasklist") return "tasklist";
  if (item.kind === "reasoning") return `reasoning:${item.modelStep ?? 0}`;
  if (item.kind === "step") return `step:${item.text}`;
  return `${item.kind}:${item.id}`;
}

function missingProcessItems(
  present: AgentActivityItem[] | undefined,
  candidates: AgentActivityItem[],
): AgentActivityItem[] {
  const presentKeys = new Set(
    (present ?? []).filter((item) => item.kind !== "response").map(processActivityIdentity),
  );
  return candidates.filter(
    (item) => item.kind !== "response" && !presentKeys.has(processActivityIdentity(item)),
  );
}

/**
 * Keep main-process terminal fields, but fold in process items the renderer
 * observed that never made it into the authoritative projection (e.g. tools
 * dropped by an incomplete reconcile).
 */
function foldMissingProcessActivity(
  authoritative: AgentActivityItem[] | undefined,
  renderer: AgentActivityItem[] | undefined,
): AgentActivityItem[] | undefined {
  if (!renderer?.length) return authoritative;
  if (!authoritative?.length) return renderer;
  const missing = missingProcessItems(authoritative, renderer);
  if (missing.length === 0) return authoritative;
  return [...authoritative, ...missing];
}

function traceMissingProjectedProcessItems(
  existing: AgentActivityItem[] | undefined,
  projected: AgentActivityItem[],
): boolean {
  return missingProcessItems(existing, projected).length > 0;
}

function unfinishedToolStateForRunStatus(
  status: SessionChatMessage["runStatus"],
): "denied" | "failed" {
  return status === "interrupted" ? "denied" : "failed";
}

/** Stamp wall duration when the run ends and startedAt is known but duration is not. */
function stampRunDurationIfNeeded(
  message: SessionChatMessage,
  endedAtMs: number = Date.now(),
): void {
  if (message.runDurationMs !== undefined) return;
  if (message.runStartedAt === undefined) return;
  message.runDurationMs = Math.max(0, endedAtMs - message.runStartedAt);
}

function activityInRemainingTrace(
  needle: AgentActivityItem,
  needleContent: string,
  haystack: AgentActivityItem[],
  haystackContent: string,
  fromIndex: number,
): boolean {
  for (let index = fromIndex; index < haystack.length; index += 1) {
    if (sameProjectedActivity(needle, needleContent, haystack[index]!, haystackContent)) {
      return true;
    }
  }
  return false;
}

export class FileSessionStore {
  private data?: SessionFile;
  private writeQueue = Promise.resolve();
  readonly conversationDatabase: ConversationDatabase;
  private readonly projectsRootPath: string;
  private readonly projectFileService: ProjectFileService;
  private readonly generationJobsService: GenerationJobsService;
  private readonly exportHistoryService: ExportHistoryService;

  constructor(
    private readonly filePath: string,
    projectRootPath?: string,
  ) {
    this.projectsRootPath = projectRootPath ?? join(dirname(filePath), "projects");
    this.conversationDatabase = new ConversationDatabase(filePath);
    this.projectFileService = new ProjectFileService(this.projectsRootPath);
    this.generationJobsService = new GenerationJobsService(this.projectFileService);
    this.exportHistoryService = new ExportHistoryService(this.projectFileService);
  }

  setArtifactChangeObserver(observer: ArtifactChangeObserverPort | undefined): void {
    this.projectFileService.setArtifactChangeObserver(observer);
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const interruptedRunIds = new Set(this.conversationDatabase.interruptRunningRuns());
    const stored = this.conversationDatabase.loadState();
    this.data = sessionFileSchema.parse({
      version: 1,
      activeSessionId: stored.activeSessionId,
      sessions: stored.sessions,
    });
    const terminalRecoveries: Array<{
      sessionId: string;
      runId: string;
      result: AgentRunResult;
    }> = [];
    for (const session of this.data.sessions) {
      for (const message of session.messages) {
        if (
          message.role === "assistant" &&
          message.runStatus === "running" &&
          message.runId &&
          !interruptedRunIds.has(message.runId)
        ) {
          const result = this.conversationDatabase.loadTerminalRunResult<AgentRunResult>(
            message.runId,
          );
          if (result) {
            terminalRecoveries.push({
              sessionId: session.session.id,
              runId: message.runId,
              result,
            });
            continue;
          }
        }
        if (
          message.role !== "assistant" ||
          (message.runStatus !== "running" &&
            (!message.runId || !interruptedRunIds.has(message.runId)))
        ) {
          continue;
        }
        message.runStatus = "interrupted";
        message.runError = undefined;
        stampRunDurationIfNeeded(message);
        message.activityTrace = message.activityTrace
          ? markTraceComplete(message.activityTrace, "denied")
          : undefined;
      }
    }
    for (const recovery of terminalRecoveries) {
      await this.finalizeAgentRunMessage(recovery.sessionId, recovery.runId, recovery.result);
    }
    for (const session of this.data.sessions) {
      this.repairThinTerminalRunTraces(session);
    }
    await this.materializeProjectSandboxes();
    await this.persist();
  }

  getBootstrap(): SessionBootstrap {
    const data = this.requireData();
    const activeSession = this.findActiveSession(data);
    return {
      sessions: this.listSummaries(data),
      activeSession: activeSession ? structuredClone(activeSession) : undefined,
    };
  }

  getSession(sessionId: string): SessionSnapshot {
    return structuredClone(this.findSession(sessionId));
  }

  findWaitingAgentRunId(sessionId: string, threadId: string): string | undefined {
    return [...this.findSession(sessionId).messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          message.runStatus === "waiting" &&
          message.threadId === threadId &&
          Boolean(message.runId),
      )?.runId;
  }

  findProposalChatContext(sessionId: string, proposalId: string): { threadId: string } | undefined {
    const snapshot = this.findSession(sessionId);
    const card = [...snapshot.displayCards]
      .reverse()
      .find(
        (item) =>
          item.event.kind === "review.command-proposal" &&
          item.event.payload.proposalId === proposalId,
      );
    if (card?.event.kind !== "review.command-proposal") return undefined;
    return { threadId: card.event.payload.threadId };
  }

  getAgentMessageHistory(sessionId: string, currentRequest?: string): AgentConversationMessage[] {
    return toAgentMessageHistory(this.findSession(sessionId).messages, currentRequest);
  }

  async createSession(options?: CreateSessionOptions): Promise<SessionBootstrap> {
    const snapshot = await this.prepareSession(options);
    const data = this.requireData();
    data.sessions.unshift(snapshot);
    data.activeSessionId = snapshot.session.id;
    await this.persist();
    await this.syncWorkspacePersistence(snapshot, { active: true });
    return this.getBootstrap();
  }

  /** Materialize the workspace before admitting a new session; no conversation state is published. */
  async prepareSession(options?: CreateSessionOptions): Promise<SessionSnapshot> {
    const title =
      options?.title ?? createDefaultSessionTitle(this.requireData().sessions.length + 1);
    const now = new Date().toISOString();
    const presentation = createSessionPresentation(title);
    const snapshot: SessionSnapshot = {
      session: this.toSummary(crypto.randomUUID(), now, now, presentation),
      presentation,
      messages: [],
      displayCards: [],
    };
    if (options?.rootPath) {
      const workspaceRoot = normalizeWorkspacePath(options.rootPath);
      snapshot.session.workspacePath = workspaceRoot;
      snapshot.project = {
        rootPath: getSessionSandboxPath(workspaceRoot, snapshot.session.id),
        artifacts: defaultProjectArtifacts.map((artifact) => ({ ...artifact })),
      };
    }
    await this.materializeProjectSandbox(snapshot, {
      defaultTemplateId: options?.defaultTemplateId,
    });
    await this.seedUploadedDefaultTemplate(snapshot, options?.defaultTemplateId);
    return snapshot;
  }

  async openWorkspace(rootPath: string): Promise<SessionBootstrap> {
    const normalized = normalizeWorkspacePath(rootPath);
    const matches = this.requireData()
      .sessions.filter((snapshot) => this.resolveWorkspaceRoot(snapshot) === normalized)
      .sort((left, right) => compareSessionsByActivity(left.session, right.session));
    if (matches.length > 0) return this.selectSession(matches[0].session.id);
    return this.createSession({ rootPath: normalized });
  }

  close(): void {
    this.conversationDatabase.close();
  }

  async listWorkspaceSessions(rootPath: string): Promise<SessionSummary[]> {
    const normalized = normalizeWorkspacePath(rootPath);
    return this.requireData()
      .sessions.filter((snapshot) => this.resolveWorkspaceRoot(snapshot) === normalized)
      .sort((left, right) => compareSessionsByActivity(left.session, right.session))
      .map((snapshot) => ({ ...structuredClone(snapshot.session), workspacePath: normalized }));
  }

  async selectSession(sessionId: string): Promise<SessionBootstrap> {
    const data = this.requireData();
    const snapshot = this.findSession(sessionId);
    this.repairThinTerminalRunTraces(snapshot);
    data.activeSessionId = sessionId;
    await this.persist();
    return this.getBootstrap();
  }

  async deleteSession(sessionId: string): Promise<SessionBootstrap> {
    const data = this.requireData();
    const index = data.sessions.findIndex((item) => item.session.id === sessionId);
    if (index === -1) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    data.sessions.splice(index, 1);
    if (data.sessions.length === 0) {
      data.activeSessionId = "";
    } else if (data.activeSessionId === sessionId) {
      data.activeSessionId = data.sessions[0].session.id;
    }
    await this.persist();
    return this.getBootstrap();
  }

  /**
   * 保存会话的权威 Presentation：先做 schema 校验，再更新数据库状态，
   * 最后同步项目目录中的 deck/snapshot.json，且不把正常保存标记为历史产物过期。
   */
  async savePresentation(sessionId: string, presentation: Presentation): Promise<void> {
    const snapshot = this.findSession(sessionId);
    const validatedPresentation = presentationSchema.parse(structuredClone(presentation));
    snapshot.presentation = validatedPresentation;
    snapshot.session = {
      ...this.toSummary(
        snapshot.session.id,
        snapshot.session.createdAt,
        new Date().toISOString(),
        validatedPresentation,
      ),
      lastMessageAt: snapshot.session.lastMessageAt,
      ...(snapshot.session.workspacePath ? { workspacePath: snapshot.session.workspacePath } : {}),
    };
    await this.projectFileService.writeDeckSnapshot(snapshot);
    await this.persist();
    await this.syncWorkspacePersistence(snapshot);
  }

  /**
   * Commits the authoritative session snapshot and a synchronous lifecycle
   * mutation on the shared SQLite connection. Workspace mirrors are updated
   * only after the database transaction succeeds.
   */
  async commitPresentationTransaction<T>(input: {
    sessionId: string;
    presentation: Presentation;
    commitLifecycle: () => T;
    afterDatabaseCommit?: () => void;
  }): Promise<T> {
    const validatedPresentation = presentationSchema.parse(structuredClone(input.presentation));
    let lifecycleResult!: T;
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const nextData = structuredClone(this.requireData());
        const snapshot = nextData.sessions.find((item) => item.session.id === input.sessionId);
        if (!snapshot) throw new Error(`Session not found: ${input.sessionId}`);
        snapshot.presentation = validatedPresentation;
        snapshot.session = {
          ...this.toSummary(
            snapshot.session.id,
            snapshot.session.createdAt,
            new Date().toISOString(),
            validatedPresentation,
          ),
          lastMessageAt: snapshot.session.lastMessageAt,
          ...(snapshot.session.workspacePath
            ? { workspacePath: snapshot.session.workspacePath }
            : {}),
        };

        this.conversationDatabase.withTransaction(() => {
          this.conversationDatabase.replaceState({
            activeSessionId: nextData.activeSessionId,
            sessions: nextData.sessions,
          });
          lifecycleResult = input.commitLifecycle();
        });

        this.data = nextData;
        input.afterDatabaseCommit?.();
        try {
          await this.projectFileService.writeDeckSnapshot(snapshot);
          await this.syncWorkspacePersistence(snapshot);
        } catch (error) {
          logger.error("presentation.workspace-mirror.sync-failed", {
            sessionId: input.sessionId,
            revision: validatedPresentation.revision,
            error,
          });
        }
      });
    this.writeQueue = write;
    await write;
    return lifecycleResult;
  }

  async recordDeckExport(
    sessionId: string,
    record: Omit<DeckExportRecord, "exportedAt"> & { exportedAt?: string },
  ): Promise<void> {
    const snapshot = this.findSession(sessionId);
    await this.exportHistoryService.appendExport(snapshot, {
      ...record,
      exportedAt: record.exportedAt ?? new Date().toISOString(),
    });
    snapshot.session.updatedAt = new Date().toISOString();
    await this.persist();
  }

  readGenerationJobs(sessionId: string) {
    return this.generationJobsService.read(this.findSession(sessionId));
  }

  async writeGenerationJobs(sessionId: string, file: DeckGenerationJobsFile): Promise<void> {
    const snapshot = this.findSession(sessionId);
    await this.generationJobsService.save(snapshot, file);
    snapshot.session.updatedAt = new Date().toISOString();
    await this.persist();
  }

  readExportHistory(sessionId: string) {
    return this.exportHistoryService.read(this.findSession(sessionId));
  }

  async readStoryboard(sessionId: string): Promise<StoryboardSlideSpec[]> {
    const artifact = await this.readProjectArtifact(sessionId, "slides/storyboard.json");
    return parseStoryboard(artifact.content ?? "[]");
  }

  async writeStoryboard(sessionId: string, storyboard: StoryboardSlideSpec[]): Promise<void> {
    const snapshot = this.findSession(sessionId);
    const result = await this.projectFileService.writeArtifact(
      snapshot,
      "slides/storyboard.json",
      serializeStoryboard(storyboard),
    );
    if (!result.changed) return;
    snapshot.session.updatedAt = new Date().toISOString();
    await this.persist();
    await this.syncWorkspacePersistence(snapshot);
  }

  createDeckGenerationJobStore(_sessionId: string) {
    return {
      readJobs: async (sessionId: string) => this.readGenerationJobs(sessionId),
      writeJobs: async (sessionId: string, file: DeckGenerationJobsFile) => {
        await this.writeGenerationJobs(sessionId, file);
      },
      writeStoryboard: async (sessionId: string, storyboard: StoryboardSlideSpec[]) => {
        await this.writeStoryboard(sessionId, storyboard);
      },
    };
  }

  async saveMessages(sessionId: string, messages: SessionChatMessage[]): Promise<void> {
    const snapshot = this.findSession(sessionId);
    const rendererMessages = sessionChatMessageSchema.array().parse(
      structuredClone(messages).map((message) => ({
        ...message,
        activityTrace: compactActivityTraceForPersistence(message.activityTrace),
      })),
    );
    const authoritativeByRunId = new Map(
      snapshot.messages
        .filter(
          (message) =>
            message.role === "assistant" &&
            message.runId &&
            message.runStatus &&
            message.runStatus !== "running",
        )
        .map((message) => [message.runId!, message] as const),
    );
    const parsedMessages = rendererMessages.map((message) => {
      if (message.role !== "assistant" || !message.runId) return message;
      const authoritative = authoritativeByRunId.get(message.runId);
      if (!authoritative) return message;
      const rendererStatus = message.runStatus;
      const authoritativeStatus = authoritative.runStatus;
      const statusRank = (status: SessionChatMessage["runStatus"]): number => {
        if (status === "running" || status === undefined) return 0;
        if (status === "waiting") return 1;
        return 2;
      };
      if (statusRank(rendererStatus) > statusRank(authoritativeStatus)) return message;
      return {
        ...message,
        content: authoritative.content,
        activityTrace: compactActivityTraceForPersistence(
          foldMissingProcessActivity(authoritative.activityTrace, message.activityTrace),
        ),
        runStatus: authoritativeStatus,
        runError: authoritative.runError,
        runStartedAt: authoritative.runStartedAt ?? message.runStartedAt,
        runDurationMs: authoritative.runDurationMs ?? message.runDurationMs,
        threadId: authoritative.threadId,
      };
    });
    const messagesChanged = this.messagesChanged(snapshot.messages, parsedMessages);
    snapshot.messages = parsedMessages;
    snapshot.session.updatedAt = new Date().toISOString();
    if (messagesChanged && this.hasConversationMessages(parsedMessages)) {
      snapshot.session.lastMessageAt = new Date().toISOString();
    }
    await this.persist();
  }

  /** Accept input and its run in one database transaction before publishing memory state. */
  async acceptAgentRun(
    sessionId: string,
    messages: SessionChatMessage[],
    input: Parameters<ConversationDatabase["beginRun"]>[0],
    newSession?: SessionSnapshot,
  ): Promise<void> {
    const write = this.writeQueue
      .catch(() => undefined)
      .then(() => {
        const next = structuredClone(this.requireData());
        if (newSession) next.sessions.unshift(structuredClone(newSession));
        next.activeSessionId = sessionId;
        const snapshot = next.sessions.find((item) => item.session.id === sessionId);
        if (!snapshot) throw new Error("Session not found.");
        snapshot.messages = sessionChatMessageSchema.array().parse(messages);
        const retained = new Set(messages.map((message) => message.id));
        snapshot.displayCards = snapshot.displayCards.filter(
          (card) =>
            !card.event.scope.anchorMessageId || retained.has(card.event.scope.anchorMessageId),
        );
        const settledRuns = new Set(
          messages
            .filter((message) => message.runStatus === "completed")
            .map((message) => message.runId),
        );
        snapshot.displayCards = snapshot.displayCards.map((card) =>
          card.event.kind === "interaction.question-requested" &&
          settledRuns.has(card.event.scope.runId)
            ? { ...card, status: "resolved" as const }
            : card,
        );
        snapshot.session.updatedAt = new Date().toISOString();
        snapshot.session.lastMessageAt = snapshot.session.updatedAt;
        this.conversationDatabase.acceptRun(next, input);
        this.data = next;
      });
    this.writeQueue = write;
    await write;
    if (newSession) {
      try {
        await this.syncWorkspacePersistence(this.findSession(sessionId), { active: true });
      } catch (error) {
        // Admission is already durable. A workspace mirror failure cannot turn it into a rejection.
        logger.warn("session.workspace-mirror-failed", { sessionId, error });
      }
    }
  }

  /**
   * Main-process authoritative completion. Renderer state is never required for
   * the final assistant message to become durable.
   */
  async finalizeAgentRunMessage(
    sessionId: string,
    runId: string,
    result: AgentRunResult,
  ): Promise<void> {
    const snapshot = this.findSession(sessionId);
    let message = [...snapshot.messages]
      .reverse()
      .find((item) => item.role === "assistant" && item.runId === runId);
    if (!message) {
      message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        runId,
        runStatus: "running",
      };
      snapshot.messages.push(message);
    }

    const projected = this.reconcileRunTranscript(message, this.projectRunTranscript(runId));
    const interrupted = result.status === "interrupted";
    const failed = result.status === "failed";
    const waiting = result.status === "waiting-user";
    let content = projected.content || message.content;
    let trace = projected.trace.length > 0 ? projected.trace : (message.activityTrace ?? []);

    if (result.status === "waiting-user" || result.status === "chat") {
      const merged = mergeResponseText(trace, content, result.message);
      trace = merged.trace;
      content = merged.content;
      message.threadId = result.threadId;
    } else if (result.status === "approval-required") {
      const approvalContent = "已提出排版更新方案，请在下方审核后应用。";
      const merged = mergeResponseText(trace, content, approvalContent);
      trace = merged.trace;
      content = merged.content;
      message.threadId = result.approval.threadId;
    } else if (result.status === "completed" || result.status === "rejected") {
      const merged = mergeResponseText(trace, content, formatTerminalAgentRunContent(result));
      trace = merged.trace;
      content = merged.content;
    } else {
      message.threadId = result.threadId;
    }

    message.content = content;
    message.activityTrace =
      trace.length > 0
        ? compactActivityTraceForPersistence(
            markTraceComplete(trace, interrupted ? "denied" : "failed"),
          )
        : undefined;
    message.runStatus = interrupted
      ? "interrupted"
      : failed
        ? "failed"
        : waiting
          ? "waiting"
          : "completed";
    message.runError = failed
      ? formatPublicErrorMessage(result.error, "处理请求时遇到问题，请稍后重试。")
      : undefined;
    stampRunDurationIfNeeded(message);
    sessionChatMessageSchema.parse(structuredClone(message));

    const now = new Date().toISOString();
    snapshot.session.updatedAt = now;
    snapshot.session.lastMessageAt = now;
    await this.persist();
  }

  async saveDisplayCards(sessionId: string, cards: PersistedDisplayCard[]): Promise<void> {
    const snapshot = this.findSession(sessionId);
    snapshot.displayCards = persistedDisplayCardSchema.array().parse(structuredClone(cards));
    snapshot.session.updatedAt = new Date().toISOString();
    await this.persist();
  }

  /**
   * Keep a completed assistant message in sync with late task-board updates
   * emitted by a long-lived teammate after the lead run has returned.
   */
  async refreshAgentRunTrace(sessionId: string, runId: string): Promise<void> {
    const snapshot = this.findSession(sessionId);
    const message = [...snapshot.messages]
      .reverse()
      .find((item) => item.role === "assistant" && item.runId === runId);
    if (!message) return;

    const projected = this.reconcileRunTranscript(message, this.projectRunTranscript(runId));
    const trace = projected.trace;
    message.content = projected.content;
    message.activityTrace =
      trace.length > 0
        ? compactActivityTraceForPersistence(
            message.runStatus === "running"
              ? trace
              : markTraceComplete(trace, unfinishedToolStateForRunStatus(message.runStatus)),
          )
        : undefined;
    sessionChatMessageSchema.parse(structuredClone(message));
    snapshot.session.updatedAt = new Date().toISOString();
    await this.persist();
  }

  /**
   * Reproject terminal assistant traces that lost process items relative to
   * durable conversation events (e.g. after a prior incomplete finalize).
   */
  private repairThinTerminalRunTraces(snapshot: SessionSnapshot): void {
    for (const message of snapshot.messages) {
      if (
        message.role !== "assistant" ||
        !message.runId ||
        message.runStatus === "running" ||
        message.runStatus === undefined
      ) {
        continue;
      }
      const projected = this.projectRunTranscript(message.runId);
      if (projected.trace.length === 0) continue;
      if (!traceMissingProjectedProcessItems(message.activityTrace, projected.trace)) {
        continue;
      }
      // Drop stale response markers so event replay owns text offsets; keep any
      // process items the message still has that events might have missed.
      const processOnlyMessage: SessionChatMessage = {
        ...message,
        content: projected.content,
        activityTrace: (message.activityTrace ?? []).filter((item) => item.kind !== "response"),
      };
      const reconciled = this.reconcileRunTranscript(processOnlyMessage, projected);
      let content = reconciled.content || projected.content || message.content;
      let trace = reconciled.trace;
      if (message.content && message.content !== content) {
        const merged = mergeResponseText(trace, content, message.content);
        content = merged.content;
        trace = merged.trace;
      }
      message.content = content;
      message.activityTrace =
        trace.length > 0
          ? compactActivityTraceForPersistence(
              markTraceComplete(trace, unfinishedToolStateForRunStatus(message.runStatus)),
            )
          : undefined;
      sessionChatMessageSchema.parse(structuredClone(message));
    }
  }

  /**
   * Runtime events are authoritative for model/process blocks. Text appended by
   * a previous finalize call (approval, question, or terminal copy) has no
   * corresponding event, so replay must splice those response blocks back into
   * the event projection and rebuild every offset against one canonical string.
   */
  private reconcileRunTranscript(
    message: SessionChatMessage,
    projected: RunTranscript,
  ): RunTranscript {
    const existingTrace = message.activityTrace ?? [];
    if (existingTrace.length === 0) return projected;
    if (projected.trace.length === 0) {
      return {
        trace: existingTrace,
        content: message.content,
      };
    }

    const trace: AgentActivityItem[] = [];
    let content = "";
    const append = (item: AgentActivityItem, sourceContent: string, stableId = item.id): void => {
      if (item.kind !== "response") {
        trace.push(stableId === item.id ? item : { ...item, id: stableId });
        return;
      }
      const text = sourceContent.slice(item.start, item.end);
      const start = content.length;
      content += text;
      trace.push({
        ...item,
        id: stableId,
        start,
        end: content.length,
      });
    };

    let existingIndex = 0;
    let projectedIndex = 0;
    while (existingIndex < existingTrace.length && projectedIndex < projected.trace.length) {
      const existing = existingTrace[existingIndex]!;
      const nextProjected = projected.trace[projectedIndex]!;
      if (sameProjectedActivity(existing, message.content, nextProjected, projected.content)) {
        append(nextProjected, projected.content, existing.id);
        existingIndex += 1;
        projectedIndex += 1;
        continue;
      }
      if (existing.kind === "response") {
        append(existing, message.content);
        existingIndex += 1;
        continue;
      }
      // Prefer event projection when the existing process item still appears
      // later. Otherwise keep the existing item — incomplete projections must
      // not drop tools/reasoning the renderer already persisted.
      if (
        !activityInRemainingTrace(
          existing,
          message.content,
          projected.trace,
          projected.content,
          projectedIndex,
        )
      ) {
        append(existing, message.content);
        existingIndex += 1;
        continue;
      }
      append(nextProjected, projected.content);
      projectedIndex += 1;
    }

    for (; projectedIndex < projected.trace.length; projectedIndex += 1) {
      append(projected.trace[projectedIndex]!, projected.content);
    }
    for (; existingIndex < existingTrace.length; existingIndex += 1) {
      append(existingTrace[existingIndex]!, message.content);
    }
    return { trace, content };
  }

  private projectRunTranscript(runId: string): RunTranscript {
    let trace: AgentActivityItem[] = [];
    let content = "";
    for (const event of this.conversationDatabase.listRunEvents(runId)) {
      if (event.visibility !== "user_visible") continue;
      const payload = event.payload;
      if (event.kind === "text_chunk" && typeof payload.chunk === "string") {
        trace = appendResponseChunk(
          trace,
          content.length,
          payload.chunk.length,
          typeof payload.attemptId === "string" ? payload.attemptId : undefined,
        );
        content += payload.chunk;
        continue;
      }
      if (
        event.kind === "workflow_progress" &&
        payload.type === "text-reset" &&
        typeof payload.attemptId === "string"
      ) {
        const reset = removeResponseAttempt(sealAllReasoning(trace), content, payload.attemptId);
        trace = reset.trace;
        content = reset.content;
        continue;
      }
      if (
        event.kind === "workflow_progress" &&
        payload.type === "text-commit" &&
        typeof payload.attemptId === "string"
      ) {
        trace = commitResponseAttempt(trace, payload.attemptId);
        continue;
      }
      const progressPayload =
        typeof payload.type === "string" ? (payload as { type: string }) : undefined;
      if (progressPayload && isTeammateProgressEvent(progressPayload)) {
        trace = applyTeammateProgressEvent(trace, progressPayload);
        continue;
      }
      if (event.kind === "reasoning_chunk" && typeof payload.chunk === "string") {
        trace = appendReasoningChunk(
          trace,
          payload.chunk,
          typeof payload.modelStep === "number" ? payload.modelStep : 0,
        );
      } else if (
        event.kind === "tool_started" &&
        typeof payload.toolCallId === "string" &&
        typeof payload.toolName === "string"
      ) {
        trace = appendToolStart(trace, payload.toolCallId, payload.toolName);
      } else if (
        event.kind === "tool_finished" &&
        typeof payload.toolCallId === "string" &&
        typeof payload.toolName === "string" &&
        (payload.status === "completed" ||
          payload.status === "failed" ||
          payload.status === "denied" ||
          payload.status === "invalid-input")
      ) {
        trace = finishTool(trace, payload.toolCallId, payload.toolName, payload.status);
      } else if (
        event.kind === "approval_requested" &&
        payload.type === "tool-approval-waiting" &&
        typeof payload.approvalId === "string" &&
        typeof payload.toolName === "string" &&
        typeof payload.reason === "string" &&
        typeof payload.detail === "string"
      ) {
        trace = appendToolApprovalWaiting(trace, {
          approvalId: payload.approvalId,
          toolName: payload.toolName,
          reason: payload.reason,
          detail: payload.detail,
        });
      } else if (
        event.kind === "approval_resolved" &&
        payload.type === "tool-approval-resolved" &&
        typeof payload.approvalId === "string" &&
        (payload.status === "approved" || payload.status === "denied")
      ) {
        trace = resolveToolApprovalItem(trace, payload.approvalId, payload.status);
      } else if (
        (event.kind === "stage_started" || event.kind === "workflow_progress") &&
        typeof payload.message === "string"
      ) {
        trace = appendStep(trace, payload.message, "done");
      } else if (event.kind === "task_list_updated") {
        const parsedTasks = agentTaskNodeSchema.array().safeParse(payload.tasks);
        if (!parsedTasks.success) continue;
        trace = upsertTaskListTrace(trace, {
          tasks: parsedTasks.data,
          goal: typeof payload.goal === "string" || payload.goal === null ? payload.goal : null,
        });
      }
    }
    return {
      trace: sealResponseBlocks(trace),
      content,
    };
  }

  listProjectArtifacts(sessionId: string) {
    return this.projectFileService.listArtifacts(this.findSession(sessionId));
  }

  /**
   * Imports into the application library so the template outlives the session
   * that uploaded it, then mirrors the revision into the active project.
   */
  async importProjectTemplate(
    sessionId: string | undefined,
    sourceFilePath: string,
    displayName?: string,
  ): Promise<ImportProjectTemplateResult> {
    const result = await importTemplatePackage({
      library: applicationTemplateLibrary(),
      sourceFilePath,
      displayName,
    });

    let relativeRoot = result.relativeRoot;
    if (sessionId) {
      const snapshot = this.findSession(sessionId);
      if (snapshot.project?.rootPath) {
        const policy = await this.getProjectTemplatePolicy(sessionId);
        await materializeCustomTemplate({
          snapshot,
          projectFileService: this.projectFileService,
          templateId: result.descriptor.id,
          revisionId: result.descriptor.revisionId,
          defaultTemplateId: policy.defaultTemplateId,
        });
        relativeRoot = templateRevisionPath(result.descriptor.id, result.descriptor.revisionId);
      }
    }

    return {
      templateId: result.descriptor.id,
      revisionId: result.descriptor.revisionId,
      name: result.descriptor.name,
      supportLevel: "design-reference",
      reusedExisting: result.reusedExisting,
      warnings: result.inspection.warnings,
      relativeRoot,
    };
  }

  async listApplicationTemplates(): Promise<ProjectTemplateSummary[]> {
    const uploaded = await listTemplateDescriptors(applicationTemplateLibrary());
    return uploaded.map((item) => ({
      id: item.id,
      revisionId: item.revisionId,
      name: item.name,
      kind: item.kind,
      supportLevel: item.supportLevel,
      description: item.description,
      autoPoolEligible: false,
    }));
  }

  /** Copies a library revision into the project and pins it as the custom template. */
  async applyTemplateToProject(
    sessionId: string,
    templateId: string,
    revisionId: string,
  ): Promise<void> {
    const snapshot = this.findSession(sessionId);
    const policy = await this.getProjectTemplatePolicy(sessionId);
    await materializeCustomTemplate({
      snapshot,
      projectFileService: this.projectFileService,
      templateId,
      revisionId,
      defaultTemplateId: policy.defaultTemplateId,
    });
  }

  async getProjectTemplatePack(sessionId: string): Promise<TemplatePack | null> {
    const snapshot = this.findSession(sessionId);
    try {
      const artifact = await this.projectFileService.readArtifact(snapshot, TEMPLATE_PACK_PATH);
      if (typeof artifact.content !== "string") return null;
      return templatePackSchema.parse(JSON.parse(artifact.content));
    } catch {
      return null;
    }
  }

  async listProjectTemplates(sessionId: string): Promise<ProjectTemplateSummary[]> {
    const snapshot = this.findSession(sessionId);
    const uploaded = snapshot.project?.rootPath
      ? await listUploadedTemplateDescriptors(snapshot.project.rootPath)
      : [];
    return [
      ...listBuiltinTemplates().map((item) => ({
        id: item.id,
        revisionId: item.revisionId,
        name: item.name,
        kind: item.kind,
        supportLevel: item.supportLevel,
        description: item.description,
        autoPoolEligible: item.autoPoolEligible,
      })),
      ...uploaded.map((item) => ({
        id: item.id,
        revisionId: item.revisionId,
        name: item.name,
        kind: item.kind,
        supportLevel: item.supportLevel,
        description: item.description,
        autoPoolEligible: false,
      })),
    ];
  }

  async getProjectTemplatePolicy(sessionId: string): Promise<ProjectTemplatePolicy> {
    const snapshot = this.findSession(sessionId);
    try {
      const artifact = await this.projectFileService.readArtifact(snapshot, TEMPLATE_POLICY_PATH);
      if (typeof artifact.content !== "string") {
        return createDefaultProjectTemplatePolicy();
      }
      return projectTemplatePolicySchema.parse(JSON.parse(artifact.content));
    } catch {
      return createDefaultProjectTemplatePolicy();
    }
  }

  async setProjectTemplatePolicy(
    sessionId: string,
    policyInput: Omit<ProjectTemplatePolicy, "version"> & { version?: 1 },
  ): Promise<void> {
    const snapshot = this.findSession(sessionId);
    const policy = projectTemplatePolicySchema.parse({
      version: 1,
      ...policyInput,
    });
    await this.projectFileService.writeArtifact(
      snapshot,
      TEMPLATE_POLICY_PATH,
      formatProjectTemplatePolicy(policy),
      { overwrite: true },
    );
  }

  listProjectFiles(sessionId: string): Promise<string[]> {
    return this.projectFileService.listProjectFiles(this.findSession(sessionId));
  }

  readProjectArtifact(
    sessionId: string,
    artifactIdOrPath: string,
  ): Promise<ProjectArtifactReadResult> {
    return this.projectFileService.readArtifact(this.findSession(sessionId), artifactIdOrPath);
  }

  openProjectFile(sessionId: string, relativePath: string): Promise<ProjectFileEditorReadResult> {
    return this.projectFileService.openProjectFile(this.findSession(sessionId), relativePath);
  }

  getProjectArtifactDiff(
    sessionId: string,
    relativePath: string,
    nextContent: string,
  ): Promise<ArtifactDiff> {
    return this.projectFileService.getArtifactDiff(
      this.findSession(sessionId),
      relativePath,
      nextContent,
    );
  }

  async saveProjectFile(
    sessionId: string,
    relativePath: string,
    content: string,
    editToken: string,
    expectedVersion: string,
  ): Promise<ProjectFileEditorWriteResult> {
    const snapshot = this.findSession(sessionId);
    const result = await this.projectFileService.saveProjectFile(
      snapshot,
      relativePath,
      content,
      editToken,
      expectedVersion,
    );
    snapshot.session.updatedAt = new Date().toISOString();
    const postCommitWarnings: NonNullable<ProjectFileEditorWriteResult["postCommitWarnings"]> = [];
    try {
      await this.persist();
    } catch (error) {
      console.error("Project file was committed, but session state persistence failed.", error);
      postCommitWarnings.push("session-state-persistence-failed");
    }
    try {
      await this.syncWorkspacePersistence(snapshot);
    } catch (error) {
      console.error("Project file was committed, but workspace metadata sync failed.", error);
      postCommitWarnings.push("workspace-metadata-sync-failed");
    }
    return postCommitWarnings.length > 0 ? { ...result, postCommitWarnings } : result;
  }

  private findActiveSession(data: SessionFile): SessionSnapshot | undefined {
    if (!data.activeSessionId) return undefined;
    return data.sessions.find((item) => item.session.id === data.activeSessionId);
  }

  /**
   * When the application default points at an uploaded reference template, the
   * new project needs a full materialization (copy + pack + policy + design-spec
   * seed). Builtin defaults are already seeded by createDefaultProjectFiles.
   */
  private async seedUploadedDefaultTemplate(
    snapshot: SessionSnapshot,
    defaultTemplateId: string | undefined,
  ): Promise<void> {
    if (!defaultTemplateId || getBuiltinTemplate(defaultTemplateId)) return;
    if (!snapshot.project?.rootPath) return;

    const descriptor = (await listTemplateDescriptors(applicationTemplateLibrary())).find(
      (item) => item.id === defaultTemplateId,
    );
    if (!descriptor) return;

    await materializeCustomTemplate({
      snapshot,
      projectFileService: this.projectFileService,
      templateId: descriptor.id,
      revisionId: descriptor.revisionId,
    });
  }

  private async materializeProjectSandboxes(): Promise<boolean> {
    let changed = false;
    for (const snapshot of this.requireData().sessions) {
      changed = (await this.materializeProjectSandbox(snapshot)) || changed;
    }
    return changed;
  }

  private async materializeProjectSandbox(
    snapshot: SessionSnapshot,
    options?: { defaultTemplateId?: string },
  ): Promise<boolean> {
    const projectChanged = await this.projectFileService.ensureProjectSandbox(snapshot, options);
    await this.syncWorkspacePersistence(snapshot);
    return projectChanged;
  }

  private messagesChanged(before: SessionChatMessage[], after: SessionChatMessage[]): boolean {
    return JSON.stringify(before) !== JSON.stringify(after);
  }

  private hasConversationMessages(messages: SessionChatMessage[]): boolean {
    return messages.some((message) => message.role === "user");
  }

  private toSummary(
    id: string,
    createdAt: string,
    updatedAt: string,
    presentation: Presentation,
  ): SessionSummary {
    return {
      id,
      title: presentation.title,
      createdAt,
      updatedAt,
      slideCount: presentation.slides.length,
      revision: presentation.revision,
    };
  }

  private listSummaries(data: SessionFile): SessionSummary[] {
    return [...data.sessions]
      .sort((a, b) => compareSessionsByActivity(a.session, b.session))
      .map((item) => ({
        ...structuredClone(item.session),
        workspacePath: this.resolveWorkspaceRoot(item),
      }));
  }

  /**
   * 工作区根的唯一解析规则。project 身份必须由此派生，
   * 否则同一会话在不同调用路径会解析出不同 projectId。
   */
  resolveWorkspaceRoot(snapshot: SessionSnapshot): string | undefined {
    const resolved = resolveWorkspacePath(
      {
        workspacePath: snapshot.session.workspacePath,
        projectRootPath: snapshot.project?.rootPath,
      },
      this.projectsRootPath,
    );
    if (!resolved || !snapshot.project?.rootPath) return undefined;
    return this.isWorkspaceBoundRoot(snapshot.project.rootPath) ? resolved : undefined;
  }

  private findSession(sessionId: string): SessionSnapshot {
    const snapshot = this.requireData().sessions.find((item) => item.session.id === sessionId);
    if (!snapshot) throw new Error(`Session not found: ${sessionId}`);
    return snapshot;
  }

  private requireData(): SessionFile {
    if (!this.data) throw new Error("Session store has not been initialized.");
    return this.data;
  }

  private isWorkspaceBoundRoot(rootPath: string): boolean {
    return !isLegacyProjectSandboxPath(normalizeWorkspacePath(rootPath), this.projectsRootPath);
  }

  private async syncWorkspacePersistence(
    snapshot: SessionSnapshot,
    options?: { active?: boolean },
  ): Promise<void> {
    const workspaceRoot = this.resolveWorkspaceRoot(snapshot);
    if (!workspaceRoot) return;
    void options;
    const projectId = this.conversationDatabase.ensureProject(
      workspaceRoot,
      getWorkspaceLabel(workspaceRoot),
    );
    await writeTextFileAtomic(
      join(workspaceRoot, ".agent-ppt-project.json"),
      `${JSON.stringify(
        {
          version: 1,
          projectId,
          title: getWorkspaceLabel(workspaceRoot),
        },
        null,
        2,
      )}\n`,
    );
  }

  private async persist(): Promise<void> {
    const state = structuredClone(this.requireData());
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        this.conversationDatabase.replaceState({
          activeSessionId: state.activeSessionId,
          sessions: state.sessions,
        });
      });
    this.writeQueue = write;
    await write;
  }
}
