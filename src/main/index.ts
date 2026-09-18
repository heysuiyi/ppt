import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatPublicErrorMessage } from "@shared/agent-activity-display";
import type { PersistedDisplayCard } from "@shared/card-display-protocol";
import { CommandBus } from "@shared/commands";
import type { ConversationEventKind } from "@shared/conversation-events";
import {
  deleteModelCredentialRequestSchema,
  setModelCredentialsRequestSchema,
  setWebSearchCredentialRequestSchema,
} from "@shared/credentials";
import {
  type AgentRunResult,
  type AgentStreamEvent,
  type CreateSessionOptions,
  type ExportPresentationOptions,
  exportPresentationOptionsSchema,
  projectArtifactDiffRequestSchema,
  projectFileOpenRequestSchema,
  projectFileSaveRequestSchema,
  projectFileSessionIdSchema,
  submitAgentRequestSchema,
} from "@shared/ipc";
import type { AppLogLevel, LogManagerSettings, RendererLogReport } from "@shared/logging";
import {
  asPresentationId,
  asProjectId,
  asProposalId,
  type PptJobProjection,
  type ProjectId,
} from "@shared/presentation-lifecycle";
import type { SessionChatMessage, SessionSnapshot } from "@shared/session";
import { isTeammateProgressEvent } from "@shared/teammate-progress";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MessageBoxOptions,
  safeStorage,
  shell,
  type WebContents,
} from "electron";
import { toResultDisplayEvents, toStreamDisplayEvent } from "./agent/display/display-event-adapter";
import { CommitGate } from "./agent/gate/commit-gate";
import { RiskPolicy } from "./agent/gate/risk-policy";
import { AgentGateway } from "./agent/gateway";
import { ListRemoteModelsError, listRemoteModels } from "./agent/gateway/list-remote-models";
import {
  clearLogFiles,
  createModuleLogger,
  diagnosticValuePreview,
  getLogDirectory,
  getLogManagerStatus,
  getRecentLogEntries,
  initializeLogManager,
  requestSummary,
  updateLogManagerSettings,
  withLogContext,
} from "./agent/logger";
import { AgentRuntime } from "./agent/runtime/agent-runtime";
import { isRuntimeCancellation } from "./agent/runtime/lifecycle/runtime-cancellation";
import { ToolApprovalBroker } from "./agent/runtime/tools/tool-approval-broker";
import { AgentService, type AgentServiceEvent } from "./agent/service";
import {
  createEmptySkillRegistry,
  type SkillRegistry,
  scanSkills,
} from "./agent/skills/loadSkillsDir";
import { acceptAgentRequest } from "./agent/submit-agent-request";
import { formatMailboxMessagesForHistory, MessageBus } from "./agent/teammate/message-bus";
import { TeammateManager } from "./agent/teammate/spawn-teammate";
import { createDefaultToolRegistry } from "./agent/tools/tool-registry";
import { AgentSettingsStore } from "./agent-settings-store";
import { configureApplicationDataRoot, getApplicationDataRoot } from "./application-data";
import {
  getCredentialStatusWithEnvironment,
  hydrateAgentModelSettings,
  hydrateAgentRunServices,
} from "./credential-runtime";
import { CredentialStore } from "./credential-store";
import { deckExportService } from "./deck/deck-export-service";
import { recoverInterruptedExport } from "./deck/export-recovery";
import { slideThumbnailService } from "./deck/slide-thumbnail-service";
import { PresentationArtifactChangeObserver } from "./presentation-lifecycle/artifact-change-observer";
import {
  ContentAddressedBlobStore,
  canonicalJson,
  hashArtifactValue,
  hashBytes,
} from "./presentation-lifecycle/content-addressed-blob-store";
import { PresentationCommitService } from "./presentation-lifecycle/presentation-commit-service";
import { PresentationLifecycleOrchestrator } from "./presentation-lifecycle/presentation-lifecycle-orchestrator";
import { PresentationLifecycleRepository } from "./presentation-lifecycle/presentation-lifecycle-repository";
import { PresentationLifecycleToolBridge } from "./presentation-lifecycle/presentation-lifecycle-tool-bridge";
import { FileSessionStore } from "./session-store";
import { TokenUsageStore } from "./token-usage-store";
import { ensureUiThemesDirectory, listUiThemes, readUiThemeCss } from "./ui-themes";
import { createWindow } from "./window/create-window";
import { applyWindowThemeMode, normalizeWindowThemeMode } from "./window/theme";

const { applicationDataRoot } = configureApplicationDataRoot(app);
if (!app.isPackaged && !process.env.AGENT_LOG_DIR?.trim()) {
  process.env.AGENT_LOG_DIR = resolve(app.getAppPath(), "logs");
}
ensureUiThemesDirectory(applicationDataRoot);

const logger = createModuleLogger("main");
const agentGateway = new AgentGateway();
const toolApprovalBroker = new ToolApprovalBroker();

function isTrustedRendererUrl(rawUrl: string): boolean {
  try {
    const actual = new URL(rawUrl);
    const developmentUrl = process.env.ELECTRON_RENDERER_URL;
    if (developmentUrl) {
      return actual.origin === new URL(developmentUrl).origin;
    }
    if (actual.protocol !== "file:") return false;
    return resolve(fileURLToPath(actual)) === resolve(join(__dirname, "../renderer/index.html"));
  } catch {
    return false;
  }
}

function assertTrustedCredentialIpc(
  event: IpcMainInvokeEvent,
  trustedWebContentsIds: ReadonlySet<number>,
): void {
  if (
    !trustedWebContentsIds.has(event.sender.id) ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url)
  ) {
    throw new Error("Credential IPC is restricted to the trusted application main frame.");
  }
}

async function resolveSkillRegistry(): Promise<SkillRegistry> {
  const candidates = [
    ...(app.isPackaged ? [join(process.resourcesPath, "skills")] : []),
    join(process.cwd(), "skills"),
    join(app.getAppPath(), "skills"),
    join(__dirname, "../../skills"),
  ];

  for (const skillsDir of candidates) {
    const registry = await scanSkills(skillsDir);
    if (registry.size > 0) {
      logger.info("skills.registry.loaded", { skillsDir, count: registry.size });
      return registry;
    }
  }

  return createEmptySkillRegistry();
}

interface SessionRuntime {
  commandBus: CommandBus;
  presentationCommitService: PresentationCommitService;
  projectId: ProjectId;
  agentService: AgentService;
  messageBus?: MessageBus;
  teammateManager?: TeammateManager;
  workspaceRoot?: string;
  runtimeRoot: string;
}

/**
 * 为单个会话装配独立的编辑状态与 Agent 基础设施。
 * CommandBus 是该会话 Presentation 的内存事实源，其余服务共享同一实例。
 */
function createSessionRuntime(
  snapshot: SessionSnapshot,
  skillRegistry: SkillRegistry,
  applicationDataRoot: string,
): SessionRuntime {
  const commandBus = new CommandBus(snapshot.presentation);
  const registry = createDefaultToolRegistry();
  const runtimeRoot = join(applicationDataRoot, "runtime", snapshot.session.id);
  const projectStorageIdentity =
    sessionStore.resolveWorkspaceRoot(snapshot) ?? `session:${snapshot.session.id}`;
  const projectId = asProjectId(
    sessionStore.conversationDatabase.ensureProject(
      projectStorageIdentity,
      snapshot.presentation.title,
    ),
  );
  const messageBus = new MessageBus(MessageBus.defaultMailboxDir(runtimeRoot));
  const teammateManager = new TeammateManager(messageBus);
  const presentationCommitService = new PresentationCommitService(
    snapshot.session.id,
    projectId,
    asPresentationId(snapshot.presentation.id),
    commandBus,
    sessionStore,
    presentationLifecycleOrchestrator,
    lifecycleBlobStore,
  );
  const agentService = new AgentService(
    commandBus,
    new AgentRuntime(
      registry,
      agentGateway,
      skillRegistry,
      sessionStore.conversationDatabase,
      ({ queryId, options }) => {
        if (options.runId) {
          sessionStore.conversationDatabase.bindRunQueryId(options.runId, queryId);
        }
        return new PresentationLifecycleToolBridge(
          presentationLifecycleOrchestrator,
          projectId,
          snapshot.presentation.id,
          queryId,
          options.request,
          lifecycleBlobStore,
          lifecycleArtifactChangeObserver,
          options.startMode.type === "resume_query",
        );
      },
    ),
    new CommitGate(new RiskPolicy()),
    snapshot.project?.rootPath,
    toolApprovalBroker,
    messageBus,
    teammateManager,
    sessionStore.conversationDatabase,
    runtimeRoot,
    presentationLifecycleOrchestrator,
    presentationCommitService,
    lifecycleBlobStore,
  );
  return {
    commandBus,
    presentationCommitService,
    projectId,
    agentService,
    messageBus,
    teammateManager,
    workspaceRoot: snapshot.project?.rootPath,
    runtimeRoot,
  };
}

function createAgentStreamEmitter(
  sender: WebContents,
  sessionId: string,
  runId: string,
  threadId: string,
  controller: AbortController,
): (streamEvent: AgentServiceEvent) => void {
  const abortRun = (reason: string) => {
    if (controller.signal.aborted) return;
    controller.abort();
    toolApprovalBroker.cancelForRun(runId);
    logger.info("agent.run.aborted", { runId, reason });
  };

  return (streamEvent: AgentServiceEvent) =>
    withLogContext({ sessionId, runId, threadId }, () => {
      if (streamEvent.type === "teammate-tool-started") {
        logger.info("teammate.tool.started", {
          teammateName: streamEvent.teammateName,
          activityId: streamEvent.activityId,
          taskId: streamEvent.taskId,
          toolName: streamEvent.toolName,
        });
      } else if (streamEvent.type === "teammate-tool-finished") {
        logger[streamEvent.status === "failed" ? "warn" : "info"]("teammate.tool.finished", {
          teammateName: streamEvent.teammateName,
          activityId: streamEvent.activityId,
          taskId: streamEvent.taskId,
          toolName: streamEvent.toolName,
          status: streamEvent.status,
          message: streamEvent.message,
        });
      } else if (streamEvent.type === "tool-approval-waiting") {
        logger.info("agent.tool-approval.requested", {
          approvalId: streamEvent.approvalId,
          toolName: streamEvent.toolName,
          reason: streamEvent.reason,
        });
        logger.debug("agent.tool-approval.detail", {
          approvalId: streamEvent.approvalId,
          detail: diagnosticValuePreview(streamEvent.detail, 8 * 1024),
        });
      } else if (streamEvent.type === "tool-approval-resolved") {
        logger.info("agent.tool-approval.observed", {
          approvalId: streamEvent.approvalId,
          toolName: streamEvent.toolName,
          status: streamEvent.status,
        });
      }
      const eventKind: ConversationEventKind = (() => {
        switch (streamEvent.type) {
          case "thinking-chunk":
          case "teammate-thinking-chunk":
            return "reasoning_chunk";
          case "text-chunk":
            return "text_chunk";
          case "text-reset":
          case "text-commit":
            return "workflow_progress";
          case "stage-started":
            return "stage_started";
          case "workflow-progress":
          case "request-status":
          case "teammate-assignment-started":
          case "teammate-assignment-finished":
            return "workflow_progress";
          case "tool-state":
            return streamEvent.status === "running" ? "tool_started" : "tool_finished";
          case "teammate-tool-started":
            return "tool_started";
          case "teammate-tool-finished":
            return "tool_finished";
          case "approval-waiting":
          case "tool-approval-waiting":
            return "approval_requested";
          case "tool-approval-resolved":
            return "approval_resolved";
          case "task-list-updated":
            return "task_list_updated";
          default:
            return "workflow_progress";
        }
      })();
      sessionStore.conversationDatabase.appendEvent({
        sessionId,
        runId,
        threadId,
        kind: eventKind,
        payload: structuredClone(streamEvent) as unknown as Record<string, unknown>,
      });
      if (streamEvent.type === "task-list-updated" || isTeammateProgressEvent(streamEvent)) {
        void sessionStore.refreshAgentRunTrace(sessionId, runId).catch((error) => {
          logger.warn("agent.run-trace.persist-failed", { sessionId, runId, error });
        });
      }
      if (sender.isDestroyed()) {
        abortRun("renderer-disposed");
        return;
      }
      try {
        sender.send("agent:stream", { ...streamEvent, runId, sessionId });
        const displayEvent = toStreamDisplayEvent(streamEvent, sessionId, runId);
        if (displayEvent) {
          sender.send("agent:stream", {
            type: "display-event",
            runId,
            sessionId,
            event: displayEvent,
          } satisfies AgentStreamEvent);
        }
      } catch (error) {
        logger.warn("agent.stream.send-failed", { runId, error });
        abortRun("stream-send-failed");
      }
    });
}

let sessionStore: FileSessionStore;
let tokenUsageStore: TokenUsageStore;
let presentationLifecycleRepository: PresentationLifecycleRepository;
let presentationLifecycleOrchestrator: PresentationLifecycleOrchestrator;
let lifecycleBlobStore: ContentAddressedBlobStore;
let lifecycleArtifactChangeObserver: PresentationArtifactChangeObserver;

app.whenReady().then(async () => {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.agent-ppt.app");
  }

  Menu.setApplicationMenu(null);
  await initializeLogManager();
  logger.info("application.started", {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });
  sessionStore = new FileSessionStore(join(applicationDataRoot, "conversations.sqlite"));
  await sessionStore.initialize();
  presentationLifecycleRepository = new PresentationLifecycleRepository({
    filePath: join(applicationDataRoot, "conversations.sqlite"),
    connection: sessionStore.conversationDatabase.sqliteConnection,
  });
  presentationLifecycleOrchestrator = new PresentationLifecycleOrchestrator(
    presentationLifecycleRepository,
  );
  lifecycleArtifactChangeObserver = new PresentationArtifactChangeObserver(
    presentationLifecycleOrchestrator,
  );
  sessionStore.setArtifactChangeObserver(lifecycleArtifactChangeObserver);
  lifecycleBlobStore = new ContentAddressedBlobStore(join(applicationDataRoot, "blobs"));
  presentationLifecycleOrchestrator.subscribe((projection: PptJobProjection) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) {
        window.webContents.send("ppt-job:changed", projection);
      }
    }
  });
  tokenUsageStore = new TokenUsageStore(join(applicationDataRoot, "token-usage.json"));
  await tokenUsageStore.initialize();
  agentGateway.setUsageRecorder((record) => tokenUsageStore.recordModelUsage(record));

  const skillRegistry = await resolveSkillRegistry();

  const runtimes = new Map<string, SessionRuntime>();
  const sessionActiveRuns = new Map<string, string>(); // sessionId -> runId
  const activeRuns = new Map<string, AbortController>(); // runId -> AbortController
  const trustedRendererWebContentsIds = new Set<number>();
  const credentialStore = new CredentialStore({ applicationDataRoot, safeStorage });
  const agentSettingsStore = new AgentSettingsStore(
    join(applicationDataRoot, "agent-settings.json"),
  );
  let activeSessionId = sessionStore.getBootstrap().activeSession?.session.id ?? "";

  const ensureRuntime = async (snapshot: SessionSnapshot): Promise<SessionRuntime> => {
    const existing = runtimes.get(snapshot.session.id);
    if (existing && existing.workspaceRoot === snapshot.project?.rootPath) return existing;
    const _runtimeRoot = join(applicationDataRoot, "runtime", snapshot.session.id);
    const runtime = createSessionRuntime(snapshot, skillRegistry, applicationDataRoot);
    await runtime.teammateManager?.reconcileInterrupted();
    runtimes.set(snapshot.session.id, runtime);
    return runtime;
  };

  const getActiveRuntime = async (): Promise<SessionRuntime> => {
    if (!activeSessionId) {
      throw new Error("No active session.");
    }
    return ensureRuntime(sessionStore.getSession(activeSessionId));
  };

  const getRuntimeForSession = (sessionId: string): Promise<SessionRuntime> =>
    ensureRuntime(sessionStore.getSession(sessionId));

  const ensureCurrentPresentationRevision = async (runtime: SessionRuntime) => {
    const presentation = runtime.commandBus.getSnapshot();
    const presentationId = asPresentationId(presentation.id);
    const existing = presentationLifecycleOrchestrator.getState(presentationId);
    if (
      existing?.presentationRevisionId &&
      existing.presentationRevisionNumber === presentation.revision
    ) {
      return existing;
    }
    const registration = presentationLifecycleOrchestrator.beginCapability({
      projectId: runtime.projectId,
      presentationId,
      capability: "edit",
      instruction: "Register the current authoritative Presentation revision.",
      basePresentationRevisionId: existing?.presentationRevisionId,
    });
    const presentationBlob = await lifecycleBlobStore.put(
      Buffer.from(canonicalJson(presentation), "utf8"),
      "application/vnd.agent-ppt.presentation+json",
    );
    return presentationLifecycleOrchestrator.completePresentation({
      jobId: registration.jobId,
      presentationBlob,
      presentationRevisionNumber: presentation.revision,
    });
  };

  const initialBootstrap = sessionStore.getBootstrap();
  if (initialBootstrap.activeSession) {
    await ensureRuntime(initialBootstrap.activeSession);
  }

  /**
   * Presentation 已由 PresentationCommitService 原子提交；这里仅把领域
   * 结果转换为 Renderer 可回放的展示事件。
   */
  const finalizeAgentResult = async (
    sessionId: string,
    _runtime: SessionRuntime,
    result: AgentRunResult,
    runId?: string,
  ): Promise<AgentRunResult> => {
    const displayEvents = [
      ...(result.displayEvents ?? []),
      ...toResultDisplayEvents(result, sessionId, runId),
    ];
    return displayEvents.length > 0 ? { ...result, displayEvents } : result;
  };

  const abortAllActiveRuns = (reason: string) => {
    for (const [runId, controller] of activeRuns) {
      if (controller.signal.aborted) continue;
      controller.abort();
      toolApprovalBroker.cancelForRun(runId);
      logger.info("agent.run.aborted", { runId, reason });
    }
  };

  const attachWindowLifecycle = (window: BrowserWindow) => {
    trustedRendererWebContentsIds.add(window.webContents.id);
    window.webContents.on("render-process-gone", (_event, details) => {
      logger.error("renderer.process.gone", {
        webContentsId: window.webContents.id,
        ...details,
      });
      abortAllActiveRuns(`render-process-gone:${details.reason}`);
    });
    window.on("closed", () => {
      trustedRendererWebContentsIds.delete(window.webContents.id);
      abortAllActiveRuns("window-closed");
    });
  };

  const runAgentOperation = async (
    operation: string,
    sessionId: string,
    runId: string | undefined,
    request: string | undefined,
    details: Record<string, unknown>,
    signal: AbortSignal | undefined,
    task: () => Promise<AgentRunResult>,
  ): Promise<AgentRunResult> => {
    const threadId = typeof details.threadId === "string" ? details.threadId : runId;
    return withLogContext({ operation, sessionId, runId, threadId }, async () => {
      const startedAt = Date.now();
      let taskOutcome: "completed" | "failed" | "interrupted" = "completed";
      if (request !== undefined) {
        logger.info("agent.request.received", requestSummary(request));
        logger.debug("agent.request.detail", {
          request: diagnosticValuePreview(request, 8 * 1024),
        });
      }
      logger.info("session.operation.started", details);
      try {
        const result = await task();
        taskOutcome =
          result.status === "interrupted"
            ? "interrupted"
            : result.status === "failed"
              ? "failed"
              : "completed";
        if (runId) {
          sessionStore.conversationDatabase.finishRun({
            runId,
            status:
              result.status === "interrupted"
                ? "interrupted"
                : result.status === "failed"
                  ? "failed"
                  : "completed",
            result,
            ...(result.status === "failed" ? { error: result.error } : {}),
            threadId:
              "threadId" in result && typeof result.threadId === "string" ? result.threadId : runId,
          });
          await sessionStore.finalizeAgentRunMessage(sessionId, runId, result);
        }
        logger.info("session.operation.completed", {
          status: result.status,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const interrupted = isRuntimeCancellation(error, signal);
        taskOutcome = interrupted ? "interrupted" : "failed";
        const failureThreadId = typeof details.threadId === "string" ? details.threadId : runId;
        const result: AgentRunResult = interrupted
          ? {
              status: "interrupted",
              ...(failureThreadId ? { threadId: failureThreadId } : {}),
            }
          : {
              status: "failed",
              error: formatPublicErrorMessage(error, "处理请求时遇到问题，请稍后重试。"),
              ...(failureThreadId ? { threadId: failureThreadId } : {}),
            };
        if (runId) {
          sessionStore.conversationDatabase.finishRun({
            runId,
            status: interrupted ? "interrupted" : "failed",
            error: message,
            result,
          });
          await sessionStore.finalizeAgentRunMessage(sessionId, runId, result);
        }
        logger.error("session.operation.failed", {
          durationMs: Date.now() - startedAt,
          error,
        });
        if (runId) return result;
        throw error;
      } finally {
        await tokenUsageStore
          .recordTask(Date.now() - startedAt, new Date(), taskOutcome)
          .catch((error) => {
            logger.error("session.operation.usage-persist-failed", { error });
          });
      }
    });
  };

  ipcMain.handle("agent-settings:get", (event) => {
    assertTrustedCredentialIpc(event, trustedRendererWebContentsIds);
    return agentSettingsStore.get();
  });
  ipcMain.handle("agent-settings:save", (event, settings: unknown) => {
    assertTrustedCredentialIpc(event, trustedRendererWebContentsIds);
    return agentSettingsStore.save(settings);
  });
  ipcMain.handle("agent-settings:migrate", (event, settings: unknown) => {
    assertTrustedCredentialIpc(event, trustedRendererWebContentsIds);
    return agentSettingsStore.save(settings, true);
  });

  ipcMain.handle("session:get-state", () => sessionStore.getBootstrap());
  ipcMain.handle("token-usage:get-stats", () => tokenUsageStore.getStats());
  ipcMain.handle("logs:get-status", () => getLogManagerStatus());
  ipcMain.handle("logs:get-recent", (_event, limit?: number, minimumLevel?: AppLogLevel) =>
    getRecentLogEntries(limit, minimumLevel),
  );
  ipcMain.handle("logs:update-settings", async (_event, patch: Partial<LogManagerSettings>) => {
    const settings = await updateLogManagerSettings(patch ?? {});
    logger.info("logs.settings.updated", { ...settings });
    return settings;
  });
  ipcMain.handle("logs:clear", async () => clearLogFiles());
  ipcMain.handle("logs:open-directory", async () => {
    const directory = getLogDirectory();
    mkdirSync(directory, { recursive: true });
    const errorMessage = await shell.openPath(directory);
    if (errorMessage) {
      logger.warn("logs.directory.open-failed", { directory, errorMessage });
      return false;
    }
    return true;
  });
  ipcMain.handle("app:get-data-path", () => getApplicationDataRoot());
  ipcMain.handle("app:open-data-directory", async () => {
    const directory = getApplicationDataRoot();
    mkdirSync(directory, { recursive: true });
    const errorMessage = await shell.openPath(directory);
    if (errorMessage) {
      logger.warn("app.data-directory.open-failed", { directory, errorMessage });
      return false;
    }
    return true;
  });
  ipcMain.handle("credentials:get-status", async (event, request: unknown) => {
    assertTrustedCredentialIpc(event, trustedRendererWebContentsIds);
    return getCredentialStatusWithEnvironment(credentialStore, request);
  });
  ipcMain.handle("credentials:set-models", async (event, request: unknown) => {
    assertTrustedCredentialIpc(event, trustedRendererWebContentsIds);
    await credentialStore.setModelCredentials(setModelCredentialsRequestSchema.parse(request));
  });
  ipcMain.handle("credentials:delete-model", async (event, request: unknown) => {
    assertTrustedCredentialIpc(event, trustedRendererWebContentsIds);
    await credentialStore.deleteModelCredential(deleteModelCredentialRequestSchema.parse(request));
  });
  ipcMain.handle("credentials:set-web-search", async (event, request: unknown) => {
    assertTrustedCredentialIpc(event, trustedRendererWebContentsIds);
    await credentialStore.setWebSearchCredential(
      setWebSearchCredentialRequestSchema.parse(request),
    );
  });
  ipcMain.handle("credentials:delete-web-search", async (event) => {
    assertTrustedCredentialIpc(event, trustedRendererWebContentsIds);
    await credentialStore.deleteWebSearchCredential();
  });
  ipcMain.handle("models:list-remote", async (event, request: unknown) => {
    assertTrustedCredentialIpc(event, trustedRendererWebContentsIds);
    try {
      return await listRemoteModels(credentialStore, request);
    } catch (error) {
      if (error instanceof ListRemoteModelsError) {
        throw new Error(error.message);
      }
      throw error;
    }
  });
  ipcMain.handle("ui-themes:list", () => listUiThemes());
  ipcMain.handle("ui-themes:read", (_event, themeId: unknown) => {
    if (typeof themeId !== "string") return null;
    return readUiThemeCss(themeId);
  });
  ipcMain.handle("ui-themes:open-directory", async () => {
    const directory = ensureUiThemesDirectory();
    const errorMessage = await shell.openPath(directory);
    if (errorMessage) {
      logger.warn("ui-themes.directory.open-failed", { directory, errorMessage });
      return false;
    }
    return true;
  });
  ipcMain.on("logs:renderer-report", (_event, report: RendererLogReport) => {
    if (!report || !["debug", "info", "warn", "error"].includes(report.level)) return;
    if (typeof report.event !== "string" || !report.event.trim()) return;
    logger[report.level](`renderer.${report.event}`, report.data);
  });
  ipcMain.handle("window:set-theme-mode", (_event, themeMode: unknown) =>
    applyWindowThemeMode(normalizeWindowThemeMode(themeMode)),
  );
  ipcMain.handle("session:create", async (_, options?: CreateSessionOptions) => {
    const startedAt = Date.now();
    const state = await sessionStore.createSession(options);
    activeSessionId = state.activeSession?.session.id ?? "";
    if (state.activeSession) {
      await ensureRuntime(state.activeSession);
    }
    logger.info("session.created", {
      sessionId: activeSessionId,
      hasWorkspace: Boolean(options?.rootPath),
      durationMs: Date.now() - startedAt,
    });
    return state;
  });
  ipcMain.handle("workspace:open", async (_, rootPath: string) => {
    const startedAt = Date.now();
    const state = await sessionStore.openWorkspace(rootPath);
    activeSessionId = state.activeSession?.session.id ?? "";
    if (state.activeSession) {
      await ensureRuntime(state.activeSession);
    }
    logger.info("workspace.opened", {
      sessionId: activeSessionId,
      rootPath,
      durationMs: Date.now() - startedAt,
    });
    return state;
  });
  ipcMain.handle("session:select", async (_, sessionId: string) => {
    const startedAt = Date.now();
    const state = await sessionStore.selectSession(sessionId);
    activeSessionId = state.activeSession?.session.id ?? "";
    if (state.activeSession) {
      await ensureRuntime(state.activeSession);
    }
    logger.info("session.selected", { sessionId, durationMs: Date.now() - startedAt });
    return state;
  });
  ipcMain.handle("session:delete", async (event, sessionId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const messageBoxOptions: MessageBoxOptions = {
      type: "question",
      buttons: ["确定", "取消"],
      defaultId: 1,
      title: "确认删除",
      message: "确定要删除该会话吗？",
      cancelId: 1,
    };
    const { response } = window
      ? await dialog.showMessageBox(window, messageBoxOptions)
      : await dialog.showMessageBox(messageBoxOptions);
    if (response === 1) {
      return sessionStore.getBootstrap();
    }
    const state = await sessionStore.deleteSession(sessionId);
    runtimes.delete(sessionId);
    activeSessionId = state.activeSession?.session.id ?? "";
    if (state.activeSession) {
      await ensureRuntime(state.activeSession);
    }
    logger.info("session.deleted", { sessionId, nextSessionId: activeSessionId || undefined });
    return state;
  });
  ipcMain.handle(
    "session:save-messages",
    (_, sessionId: string, messages: SessionChatMessage[]) => {
      // An old debounced Renderer snapshot must not overwrite a newly accepted input/run.
      if (activeRuns.size > 0) return;
      return sessionStore.saveMessages(sessionId, messages);
    },
  );
  ipcMain.handle(
    "session:save-display-cards",
    (_, sessionId: string, cards: PersistedDisplayCard[]) =>
      sessionStore.saveDisplayCards(sessionId, cards),
  );
  ipcMain.handle("ppt-job:get", (_, sessionId: string) => {
    const snapshot = sessionStore.getSession(sessionId);
    return presentationLifecycleRepository.getProjectionByPresentationId(
      asPresentationId(snapshot.presentation.id),
    );
  });

  ipcMain.handle("project:list-artifacts", (_, sessionId: string) =>
    sessionStore.listProjectArtifacts(sessionId),
  );
  ipcMain.handle(
    "project:read-artifact",
    (_, rawSessionId: unknown, rawArtifactIdOrPath: unknown) => {
      const request = projectFileOpenRequestSchema.parse({
        sessionId: rawSessionId,
        relativePath: rawArtifactIdOrPath,
      });
      return sessionStore.readProjectArtifact(request.sessionId, request.relativePath);
    },
  );
  ipcMain.handle(
    "project:get-artifact-diff",
    (_, rawSessionId: unknown, rawRelativePath: unknown, rawNextContent: unknown) => {
      const request = projectArtifactDiffRequestSchema.parse({
        sessionId: rawSessionId,
        relativePath: rawRelativePath,
        nextContent: rawNextContent,
      });
      return sessionStore.getProjectArtifactDiff(
        request.sessionId,
        request.relativePath,
        request.nextContent,
      );
    },
  );
  ipcMain.handle("project:list-files", (_, rawSessionId: unknown) =>
    sessionStore.listProjectFiles(projectFileSessionIdSchema.parse(rawSessionId)),
  );
  ipcMain.handle("project:open-file", (_, rawSessionId: unknown, rawRelativePath: unknown) => {
    const request = projectFileOpenRequestSchema.parse({
      sessionId: rawSessionId,
      relativePath: rawRelativePath,
    });
    return sessionStore.openProjectFile(request.sessionId, request.relativePath);
  });
  ipcMain.handle(
    "project:save-file",
    (
      _,
      rawSessionId: unknown,
      rawRelativePath: unknown,
      rawContent: unknown,
      rawEditToken: unknown,
      rawExpectedVersion: unknown,
    ) => {
      const request = projectFileSaveRequestSchema.parse({
        sessionId: rawSessionId,
        relativePath: rawRelativePath,
        content: rawContent,
        editToken: rawEditToken,
        expectedVersion: rawExpectedVersion,
      });
      return sessionStore.saveProjectFile(
        request.sessionId,
        request.relativePath,
        request.content,
        request.editToken,
        request.expectedVersion,
      );
    },
  );
  ipcMain.handle("presentation:get", async () =>
    (await getActiveRuntime()).commandBus.getSnapshot(),
  );
  ipcMain.handle(
    "presentation:export",
    async (_, sessionId: string, options: ExportPresentationOptions) => {
      const startedAt = Date.now();
      const validatedOptions = exportPresentationOptionsSchema.parse(options);
      const runtime = await getRuntimeForSession(sessionId);
      const presentation = runtime.commandBus.getSnapshot();
      const window = BrowserWindow.getFocusedWindow();
      const dialogOptions = {
        title: "导出幻灯片",
        defaultPath: `${presentation.title || "未命名演示文稿"}.pptx`,
        filters: [
          { name: "PowerPoint 演示文稿 (*.pptx)", extensions: ["pptx"] },
          { name: "HTML 网页 (*.html)", extensions: ["html"] },
          { name: "JSON 原始数据 (*.json)", extensions: ["json"] },
        ],
      };
      const { filePath, canceled } = window
        ? await dialog.showSaveDialog(window, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

      if (canceled || !filePath) {
        logger.info("presentation.export.cancelled", { sessionId });
        return null;
      }

      const format = extname(filePath).slice(1).toLowerCase();
      if (format !== "pptx" && format !== "html" && format !== "json") {
        throw new Error("Unsupported export format.");
      }
      const presentationState = await ensureCurrentPresentationRevision(runtime);
      const exportState = presentationLifecycleOrchestrator.beginCapability({
        projectId: runtime.projectId,
        presentationId: asPresentationId(presentation.id),
        capability: "export",
        instruction: `Export the current Presentation as ${format}.`,
        basePresentationRevisionId: presentationState.presentationRevisionId,
      });
      if (!presentationState.presentationRevisionId) {
        throw new Error("Current PresentationRevision is unavailable for export.");
      }
      const destination = resolve(filePath);
      const effectKey = hashArtifactValue({
        presentationRevisionId: presentationState.presentationRevisionId,
        options: validatedOptions,
        destination,
      });
      let claimed = false;
      let lifecycleCompleted = false;

      logger.info("presentation.export.started", {
        sessionId,
        revision: presentation.revision,
        slideCount: presentation.slides.length,
        format,
      });
      try {
        const claim = presentationLifecycleRepository.claimSideEffect({
          jobId: exportState.jobId,
          operation: "export",
          key: effectKey,
          claimedAt: new Date().toISOString(),
        });
        let recoveredExport: Awaited<ReturnType<typeof recoverInterruptedExport>> | undefined;
        if (claim.type === "in_progress") {
          recoveredExport = await recoverInterruptedExport({
            lifecycle: presentationLifecycleOrchestrator,
            jobId: exportState.jobId,
            effectKey,
            presentationRevisionId: presentationState.presentationRevisionId,
            presentation,
            options: validatedOptions,
            destination,
            format,
          });
          lifecycleCompleted = true;
        }
        if (claim.type === "failed") {
          presentationLifecycleOrchestrator.waitForUser(
            exportState.jobId,
            "The previous export attempt failed and cannot be blindly replayed.",
          );
          throw new Error(`This export attempt will not be replayed: ${claim.error}`);
        }
        claimed = claim.type === "claimed";

        let exportedPath = destination;
        let exportedSlideCount = presentation.slides.length;
        if (claim.type === "succeeded") {
          const settled = claim.result as {
            destination?: unknown;
            fileHash?: unknown;
            byteLength?: unknown;
            format?: unknown;
          };
          if (
            settled.destination !== destination ||
            typeof settled.fileHash !== "string" ||
            settled.format !== format
          ) {
            presentationLifecycleOrchestrator.waitForUser(
              exportState.jobId,
              "The recorded export proof does not match this request.",
            );
            throw new Error("The recorded export proof does not match this request.");
          }
          const existingBytes = await readFile(destination);
          if (
            hashBytes(existingBytes) !== settled.fileHash ||
            existingBytes.byteLength !== settled.byteLength
          ) {
            presentationLifecycleOrchestrator.waitForUser(
              exportState.jobId,
              "The exported file no longer matches its durable hash.",
            );
            throw new Error("The exported file no longer matches its durable hash.");
          }
        } else if (claim.type === "claimed") {
          const result = await deckExportService.exportDeck({
            presentation,
            options: validatedOptions,
            filePath: destination,
            workspaceRoot: runtime.workspaceRoot,
          });
          exportedPath = result.filePath;
          exportedSlideCount = result.slideCount;
        } else {
          exportedSlideCount = recoveredExport!.proof.slideCount;
        }
        if (!recoveredExport) {
          const exportedBytes = await readFile(exportedPath);
          const exportedStat = await stat(exportedPath);
          const fileHash = hashBytes(exportedBytes);
          presentationLifecycleOrchestrator.completeExport({
            jobId: exportState.jobId,
            effectKey,
            presentationRevisionId: presentationState.presentationRevisionId,
            options: validatedOptions,
            destination: exportedPath,
            format,
            fileHash,
            byteLength: exportedStat.size,
            postflight: {
              passed: true,
              validator: "export-service",
              slideCount: exportedSlideCount,
            },
          });
          lifecycleCompleted = true;
        }

        if (format === "pptx") {
          await sessionStore
            .recordDeckExport(sessionId, {
              revision: presentation.revision,
              filePath: exportedPath,
              designSystem: presentation.designSystem,
            })
            .catch((error) => {
              logger.error("presentation.export-history.sync-failed", {
                sessionId,
                filePath: exportedPath,
                error,
              });
            });
        }

        logger.info("presentation.export.completed", {
          sessionId,
          filePath: exportedPath,
          durationMs: Date.now() - startedAt,
        });
        return exportedPath;
      } catch (error) {
        if (claimed && !lifecycleCompleted) {
          presentationLifecycleRepository.completeSideEffect({
            jobId: exportState.jobId,
            operation: "export",
            key: effectKey,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            completedAt: new Date().toISOString(),
          });
          const latest = presentationLifecycleRepository.getJob(exportState.jobId);
          if (
            latest?.currentRequest.requestId === exportState.currentRequest.requestId &&
            latest.status === "running"
          ) {
            presentationLifecycleOrchestrator.waitForUser(
              exportState.jobId,
              "Export failed; choose whether to retry with a new destination.",
            );
          }
        }
        logger.error("presentation.export.failed", {
          sessionId,
          filePath: destination,
          durationMs: Date.now() - startedAt,
          error,
        });
        throw error;
      }
    },
  );
  ipcMain.handle("dialog:select-directory", async (event, defaultPath?: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const { filePaths, canceled } = window
      ? await dialog.showOpenDialog(window, {
          properties: ["openDirectory"],
          defaultPath,
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory"],
          defaultPath,
        });
    if (canceled || !filePaths || filePaths.length === 0) return null;
    return filePaths[0];
  });
  ipcMain.handle("dialog:select-template-package", async (event, defaultPath?: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      properties: ["openFile"] as Array<"openFile">,
      defaultPath,
      filters: [{ name: "PowerPoint / Template", extensions: ["pptx", "potx"] }],
    };
    const { filePaths, canceled } = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (canceled || !filePaths || filePaths.length === 0) return null;
    return filePaths[0];
  });
  ipcMain.handle(
    "template:import",
    async (_event, sessionId: unknown, sourceFilePath: unknown, displayName?: unknown) => {
      if (typeof sourceFilePath !== "string" || !sourceFilePath.trim()) {
        throw new Error("sourceFilePath is required");
      }
      return sessionStore.importProjectTemplate(
        typeof sessionId === "string" && sessionId.trim() ? sessionId : undefined,
        sourceFilePath,
        typeof displayName === "string" ? displayName : undefined,
      );
    },
  );
  ipcMain.handle("template:list", async (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("sessionId is required");
    }
    return sessionStore.listProjectTemplates(sessionId);
  });
  ipcMain.handle("template:list-application", async () => {
    return sessionStore.listApplicationTemplates();
  });
  ipcMain.handle(
    "template:apply",
    async (_event, sessionId: unknown, templateId: unknown, revisionId: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("sessionId is required");
      }
      if (typeof templateId !== "string" || !templateId.trim()) {
        throw new Error("templateId is required");
      }
      if (typeof revisionId !== "string" || !revisionId.trim()) {
        throw new Error("revisionId is required");
      }
      await sessionStore.applyTemplateToProject(sessionId, templateId, revisionId);
    },
  );
  ipcMain.handle("template:get-policy", async (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("sessionId is required");
    }
    return sessionStore.getProjectTemplatePolicy(sessionId);
  });
  ipcMain.handle("template:get-pack", async (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("sessionId is required");
    }
    return sessionStore.getProjectTemplatePack(sessionId);
  });
  ipcMain.handle("template:set-policy", async (_event, sessionId: unknown, policy: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("sessionId is required");
    }
    await sessionStore.setProjectTemplatePolicy(
      sessionId,
      policy as {
        mode: "auto" | "default" | "custom";
        defaultTemplateId: string;
        customTemplateId?: string;
        customTemplateRevisionId?: string;
      },
    );
  });
  ipcMain.handle("shell:open-export-folder", async (_, filePath: string) => {
    if (typeof filePath !== "string" || !filePath.trim()) {
      return false;
    }

    shell.showItemInFolder(filePath);
    return true;
  });

  ipcMain.handle("agent:cancel", async (_, runId: string) => {
    toolApprovalBroker.cancelForRun(runId);
    const controller = activeRuns.get(runId);
    if (controller) {
      controller.abort();
      logger.info("agent.run.cancelled", { runId });
      return true;
    }
    return false;
  });

  ipcMain.handle("agent:cancel-session", async (_, sessionId: string) => {
    const runId = sessionActiveRuns.get(sessionId);
    if (!runId) return false;
    toolApprovalBroker.cancelForRun(runId);
    const controller = activeRuns.get(runId);
    if (controller) {
      controller.abort();
      logger.info("agent.session.cancelled", { sessionId, runId });
      return true;
    }
    return false;
  });

  ipcMain.handle(
    "agent:resolve-tool-approval",
    async (_, runId: string, approvalId: string, approved: boolean) => {
      const resolved = toolApprovalBroker.resolve(approvalId, approved);
      withLogContext({ runId }, () => {
        logger.info("agent.tool-approval.resolved", {
          approvalId,
          approved,
          resolved,
        });
      });
      return resolved;
    },
  );

  ipcMain.handle("agent:poll-lead-inbox", async (_, sessionId: string) => {
    const runtime = await getRuntimeForSession(sessionId);
    const messages = runtime.messageBus ? await runtime.messageBus.peekInbox("lead") : [];
    return {
      hasMessages: messages.length > 0,
      count: messages.length,
      preview: formatMailboxMessagesForHistory(messages.slice(0, 5), 1_000),
      types: Array.from(new Set(messages.map((message) => message.type))),
    };
  });

  /**
   * 接收用户意图；Main 持有配置和会话状态，在单次提交内完成受理、准备和运行。
   */
  ipcMain.handle("agent:submit", async (event, rawRequest: unknown) => {
    assertTrustedCredentialIpc(event, trustedRendererWebContentsIds);
    const request = submitAgentRequestSchema.parse(rawRequest);
    if (activeRuns.size > 0)
      throw new Error("Concurrency Conflict: An active agent run is already in progress.");
    const runId = request.requestId;
    const controller = new AbortController();
    activeRuns.set(runId, controller);
    let sessionId: string | undefined;
    let accepted = false;
    try {
      const settings = await agentSettingsStore.get();
      if (!settings) throw new Error("Execution settings have not been initialized.");
      controller.signal.throwIfAborted();
      const admission = await acceptAgentRequest(sessionStore, settings, request);
      sessionId = admission.sessionId;
      accepted = true;
      activeSessionId = sessionId;
      sessionActiveRuns.set(sessionId, runId);
      const emit = createAgentStreamEmitter(
        event.sender,
        sessionId,
        runId,
        admission.threadId ?? runId,
        controller,
      );
      return await runAgentOperation(
        "submit",
        sessionId,
        runId,
        request.prompt,
        { threadId: admission.threadId ?? runId },
        controller.signal,
        async () => {
          if (!event.sender.isDestroyed())
            event.sender.send("agent:accepted", {
              requestId: request.requestId,
              runId,
              sessionId,
              threadId: admission.threadId ?? runId,
              bootstrap: admission.bootstrap,
            });
          controller.signal.throwIfAborted();
          const runtime = await getRuntimeForSession(admission.sessionId);
          const primary = await hydrateAgentModelSettings(credentialStore, admission.model);
          const services = await hydrateAgentRunServices(credentialStore, admission.services);
          controller.signal.throwIfAborted();
          agentGateway.clearPrimarySettings();
          const selection = agentGateway.configure(primary, services.gateway, services.search);
          if (admission.threadId) {
            const restored = await runtime.agentService.restoreDurableThread(admission.threadId);
            if (!restored) throw new Error("The conversation can no longer be resumed.");
          }
          sessionStore.conversationDatabase.markRunRunning(runId);
          const result = admission.threadId
            ? await runtime.agentService.continueAgentRun(
                admission.threadId,
                request.prompt,
                emit,
                request.editorContext,
                controller.signal,
                runId,
                admission.stepLimits,
                selection,
                admission.executionStrategy,
              )
            : await runtime.agentService.start(
                request.prompt,
                selection,
                admission.executionStrategy,
                emit,
                request.editorContext,
                admission.history,
                controller.signal,
                runId,
                admission.stepLimits,
              );
          return finalizeAgentResult(admission.sessionId, runtime, result, runId);
        },
      );
    } finally {
      toolApprovalBroker.finishForRun(runId);
      activeRuns.delete(runId);
      if (sessionId && sessionActiveRuns.get(sessionId) === runId)
        sessionActiveRuns.delete(sessionId);
      if (accepted && !event.sender.isDestroyed()) {
        try {
          event.sender.send("agent:stream", {
            type: "stream-completed",
            runId,
            sessionId,
          } satisfies AgentStreamEvent);
        } catch (error) {
          logger.warn("agent.stream-completion-undelivered", { runId, error });
        }
      }
    }
  });

  ipcMain.handle(
    "agent:resume",
    async (_event, sessionId: string, rawProposalId: string, approved: boolean) => {
      const proposalId = asProposalId(rawProposalId);
      const runtime = await getRuntimeForSession(sessionId);
      const chat = sessionStore.findProposalChatContext(sessionId, proposalId);
      withLogContext(
        {
          operation: "resolve-proposal",
          sessionId,
          threadId: chat?.threadId,
        },
        () => {
          logger.info("agent.proposal.resolution.received", { proposalId, approved });
        },
      );
      return runAgentOperation(
        "resolve-proposal",
        sessionId,
        undefined,
        undefined,
        {
          proposalId,
          ...(chat?.threadId ? { threadId: chat.threadId } : {}),
          approved,
        },
        undefined,
        async () =>
          finalizeAgentResult(
            sessionId,
            runtime,
            await runtime.agentService.resumeProposal(proposalId, approved),
            undefined,
          ),
      );
    },
  );

  createWindow(attachWindowLifecycle);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(attachWindowLifecycle);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  logger.info("application.stopping");
  slideThumbnailService.dispose();
  presentationLifecycleRepository?.close();
  sessionStore?.conversationDatabase.close();
});

process.on("uncaughtExceptionMonitor", (error) => {
  logger.error("process.uncaught-exception", { error });
});

process.on("unhandledRejection", (reason) => {
  logger.error("process.unhandled-rejection", { reason });
});

app.on("child-process-gone", (_event, details) => {
  logger.error("application.child-process-gone", { ...details });
});
