import { z } from "zod";
import type { AgentQuestion } from "./agent-question";
import type { AgentSettings } from "./agent-settings";
import type { AgentTaskNode } from "./agent-task-list";
import type {
  AgentApprovalRequest,
  DisplayEvent,
  PersistedDisplayCard,
} from "./card-display-protocol";
import type {
  CredentialStatusRequest,
  CredentialStatusSnapshot,
  DeleteModelCredentialRequest,
  SetModelCredentialsRequest,
  SetWebSearchCredentialRequest,
} from "./credentials";
import type {
  AppLogEntry,
  AppLogLevel,
  LogManagerSettings,
  LogManagerStatus,
  RendererLogReport,
} from "./logging";
import type { Presentation } from "./presentation";
import type { PptJobProjection } from "./presentation-lifecycle";
import type { ListRemoteModelsRequest, ListRemoteModelsResult } from "./remote-models";
import type { ProjectArtifact, SessionBootstrap, SessionChatMessage } from "./session";
import type { TeammateProgressEvent } from "./teammate-progress";
import type { TokenUsageStats } from "./token-usage";

export interface CreateSessionOptions {
  rootPath?: string;
  title?: string;
  /** Snapshotted into design/template-policy.json for new projects only. */
  defaultTemplateId?: string;
}

export interface ImportProjectTemplateResult {
  templateId: string;
  revisionId: string;
  name: string;
  supportLevel: "design-reference";
  reusedExisting: boolean;
  warnings: string[];
  /** Relative project path of the immutable revision root. */
  relativeRoot: string;
}

export interface ProjectTemplateSummary {
  id: string;
  revisionId: string;
  name: string;
  kind: "builtin" | "uploaded";
  supportLevel: "native" | "design-reference" | "master-backed";
  description: string;
  autoPoolEligible?: boolean;
}

export type { AgentApprovalRequest } from "./card-display-protocol";

export interface AgentEditorContext {
  currentSlideId?: string;
  selectedElementIds: string[];
}

export const agentEditorContextSchema = z.object({
  currentSlideId: z.string().optional(),
  selectedElementIds: z.array(z.string()),
});

export const submitAgentRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    userMessageId: z.string().uuid(),
    assistantMessageId: z.string().uuid(),
    target: z.discriminatedUnion("type", [
      z.object({ type: z.literal("session"), sessionId: z.string().trim().min(1) }).strict(),
      z
        .object({ type: z.literal("new-session"), rootPath: z.string().trim().min(1).optional() })
        .strict(),
    ]),
    prompt: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    executionStrategy: z.enum(["AUTO", "REQUEST_APPROVAL"]).optional(),
    editorContext: agentEditorContextSchema.optional(),
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("message") }).strict(),
      z.object({ type: z.literal("edit"), messageId: z.string().min(1) }).strict(),
      z
        .object({
          type: z.literal("answer"),
          questionRunId: z.string().min(1),
          displayContent: z.string().optional(),
        })
        .strict(),
      z.object({ type: z.literal("inbox") }).strict(),
    ]),
  })
  .strict();
export type SubmitAgentRequest = z.infer<typeof submitAgentRequestSchema>;
export interface AgentRunAccepted {
  requestId: string;
  runId: string;
  sessionId: string;
  threadId: string;
  bootstrap: SessionBootstrap;
}

export const projectFileSessionIdSchema = z.string().trim().min(1).max(256);
const projectFilePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((path) => {
    const normalized = path.replace(/\\/g, "/");
    return (
      !normalized.includes("\0") &&
      !normalized.startsWith("/") &&
      !/^[a-z]:\//i.test(normalized) &&
      !normalized.split("/").includes("..")
    );
  }, "Project file path must be a contained relative path.");
const projectFileContentSchema = z.string().max(5 * 1024 * 1024);

export const projectFileOpenRequestSchema = z
  .object({
    sessionId: projectFileSessionIdSchema,
    relativePath: projectFilePathSchema,
  })
  .strict();

export const projectArtifactDiffRequestSchema = projectFileOpenRequestSchema
  .extend({
    nextContent: projectFileContentSchema,
  })
  .strict();

export const projectFileSaveRequestSchema = projectFileOpenRequestSchema
  .extend({
    content: projectFileContentSchema,
    editToken: z.string().uuid(),
    expectedVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export type AgentStreamEvent = (
  | { runId: string; type: "request-status"; message: string; progress: number }
  | { runId: string; type: "workflow-progress"; message: string; progress: number }
  | {
      runId: string;
      type: "text-chunk";
      chunk: string;
      attemptId?: string;
    }
  | { runId: string; type: "text-reset"; attemptId: string }
  | { runId: string; type: "text-commit"; attemptId: string }
  | { runId: string; type: "thinking-chunk"; chunk: string; modelStep?: number }
  | { runId: string; type: "stream-completed" }
  | { runId: string; type: "stage-started"; message: string; stage: string }
  | {
      runId: string;
      type: "tool-state";
      message: string;
      toolCallId: string;
      toolName: string;
      status: "running" | "completed" | "failed" | "denied" | "invalid-input";
      error?: string;
    }
  | {
      runId: string;
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
  | { runId: string; type: "approval-waiting"; message: string }
  | {
      runId: string;
      type: "tool-approval-waiting";
      message: string;
      approvalId: string;
      toolName: string;
      reason: string;
      detail: string;
    }
  | {
      runId: string;
      type: "tool-approval-resolved";
      message: string;
      approvalId: string;
      toolName: string;
      status: "approved" | "denied";
    }
  | {
      runId: string;
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
  | ({ runId: string } & TeammateProgressEvent)
  | { runId: string; type: "display-event"; event: DisplayEvent }
) & { sessionId?: string };

type AgentRunResultDisplay = {
  displayEvents?: DisplayEvent[];
};

export type AgentRunResult = (
  | { status: "chat"; message: string; threadId?: string }
  | { status: "waiting-user"; message: string; threadId: string; question?: AgentQuestion }
  | { status: "approval-required"; approval: AgentApprovalRequest }
  | { status: "completed"; presentation: Presentation }
  | { status: "rejected"; presentation?: Presentation }
  | { status: "interrupted"; threadId?: string }
  | { status: "failed"; error: string; threadId?: string }
) &
  AgentRunResultDisplay;

export interface AgentInboxPollResult {
  hasMessages: boolean;
  count: number;
  preview: string;
  types: string[];
}

export type WindowThemeMode = "light" | "dark" | "system";

export interface ProjectArtifactReadResult {
  path: string;
  type: "file" | "directory";
  content?: string;
  entries?: string[];
  version?: string;
  mtimeMs?: number;
  size?: number;
  encoding?: "utf8";
  newline?: "lf" | "crlf" | "mixed" | "none";
}

export interface ArtifactDiff {
  path: string;
  before: string;
  after: string;
  changed: boolean;
  unifiedDiff: string;
}

export interface ProjectFileReceipt {
  path: string;
  version: string;
  mtimeMs: number;
  size: number;
  encoding: "utf8";
  newline: "lf" | "crlf" | "mixed" | "none";
}

export interface ProjectFileEditorReadResult extends ProjectFileReceipt {
  content: string;
  editToken: string;
  editable: boolean;
  readOnlyReason?: string;
}

export interface ProjectFileEditorWriteResult extends ProjectFileReceipt {
  changed: boolean;
  changedArtifactId?: string;
  characterCount: number;
  editToken: string;
  postCommitWarnings?: Array<"session-state-persistence-failed" | "workspace-metadata-sync-failed">;
}

export interface UiThemeSummary {
  id: string;
  name: string;
  fileName: string;
}

export interface DesktopApi {
  getSessionState(): Promise<SessionBootstrap>;
  getTokenUsageStats(): Promise<TokenUsageStats>;
  getLogManagerStatus(): Promise<LogManagerStatus>;
  getRecentLogs(limit?: number, minimumLevel?: AppLogLevel): Promise<AppLogEntry[]>;
  updateLogManagerSettings(patch: Partial<LogManagerSettings>): Promise<LogManagerSettings>;
  clearLogs(): Promise<number>;
  openLogDirectory(): Promise<boolean>;
  getApplicationDataPath(): Promise<string>;
  openApplicationDataDirectory(): Promise<boolean>;
  listUiThemes(): Promise<UiThemeSummary[]>;
  readUiThemeCss(themeId: string): Promise<string | null>;
  openUiThemesDirectory(): Promise<boolean>;
  reportRendererLog(report: RendererLogReport): void;
  getCredentialStatus(request: CredentialStatusRequest): Promise<CredentialStatusSnapshot>;
  setModelCredentials(request: SetModelCredentialsRequest): Promise<void>;
  deleteModelCredential(request: DeleteModelCredentialRequest): Promise<void>;
  setWebSearchCredential(request: SetWebSearchCredentialRequest): Promise<void>;
  deleteWebSearchCredential(): Promise<void>;
  listRemoteModels(request: ListRemoteModelsRequest): Promise<ListRemoteModelsResult>;
  createSession(options?: CreateSessionOptions): Promise<SessionBootstrap>;
  openWorkspace(rootPath: string): Promise<SessionBootstrap>;
  selectSession(sessionId: string): Promise<SessionBootstrap>;
  deleteSession(sessionId: string): Promise<SessionBootstrap>;
  saveSessionMessages(sessionId: string, messages: SessionChatMessage[]): Promise<void>;
  saveSessionDisplayCards(sessionId: string, cards: PersistedDisplayCard[]): Promise<void>;
  listProjectArtifacts(sessionId: string): Promise<ProjectArtifact[]>;
  readProjectArtifact(
    sessionId: string,
    artifactIdOrPath: string,
  ): Promise<ProjectArtifactReadResult>;
  getProjectArtifactDiff(
    sessionId: string,
    relativePath: string,
    nextContent: string,
  ): Promise<ArtifactDiff>;
  listProjectFiles(sessionId: string): Promise<string[]>;
  openProjectFile(sessionId: string, relativePath: string): Promise<ProjectFileEditorReadResult>;
  saveProjectFile(
    sessionId: string,
    relativePath: string,
    content: string,
    editToken: string,
    expectedVersion: string,
  ): Promise<ProjectFileEditorWriteResult>;
  getPptJob(sessionId: string): Promise<PptJobProjection | undefined>;
  onPptJobChanged(listener: (projection: PptJobProjection) => void): () => void;
  getPresentation(): Promise<Presentation>;
  getAgentSettings(): Promise<AgentSettings | undefined>;
  saveAgentSettings(settings: AgentSettings): Promise<AgentSettings>;
  migrateAgentSettings(settings: AgentSettings): Promise<AgentSettings>;
  submitAgentRun(request: SubmitAgentRequest): Promise<AgentRunResult>;
  onAgentRunAccepted(listener: (event: AgentRunAccepted) => void): () => void;
  onAgentStream(listener: (event: AgentStreamEvent) => void): () => void;
  resumeAgentRun(sessionId: string, proposalId: string, approved: boolean): Promise<AgentRunResult>;
  exportPresentation(sessionId: string, options: ExportPresentationOptions): Promise<string | null>;
  openExportFolder(filePath: string): Promise<boolean>;
  selectDirectory(defaultPath?: string): Promise<string | null>;
  selectTemplatePackage(defaultPath?: string): Promise<string | null>;
  importProjectTemplate(
    sessionId: string | undefined,
    sourceFilePath: string,
    displayName?: string,
  ): Promise<ImportProjectTemplateResult>;
  listProjectTemplates(sessionId: string): Promise<ProjectTemplateSummary[]>;
  listApplicationTemplates(): Promise<ProjectTemplateSummary[]>;
  applyTemplateToProject(sessionId: string, templateId: string, revisionId: string): Promise<void>;
  getProjectTemplatePolicy(sessionId: string): Promise<{
    version: 1;
    mode: "auto" | "default" | "custom";
    defaultTemplateId: string;
    customTemplateId?: string;
    customTemplateRevisionId?: string;
  }>;
  getProjectTemplatePack(sessionId: string): Promise<{
    version: 1;
    templateId: string;
    revisionId: string;
    name: string;
    supportLevel: "design-reference";
    designSystem: unknown;
    typography: {
      title: string;
      body: string;
      emphasis: string;
      data: string;
      sourceMajor?: string;
      sourceMinor?: string;
    };
    chrome?: unknown;
    assets: Array<{ role: string; path: string; contentHash?: string }>;
    inheritance: {
      colors: boolean;
      fonts: string;
      logo: boolean;
      headerFooter: boolean;
      titleFrame: boolean;
      masters: false;
      placeholders: false;
    };
    warnings?: string[];
  } | null>;
  setProjectTemplatePolicy(
    sessionId: string,
    policy: {
      mode: "auto" | "default" | "custom";
      defaultTemplateId: string;
      customTemplateId?: string;
      customTemplateRevisionId?: string;
    },
  ): Promise<void>;
  setWindowThemeMode(themeMode: WindowThemeMode): Promise<"light" | "dark">;
  cancelAgentRun(runId: string): Promise<boolean>;
  cancelAgentSession(sessionId: string): Promise<boolean>;
  resolveToolApproval(runId: string, approvalId: string, approved: boolean): Promise<boolean>;
  pollLeadInbox(sessionId: string): Promise<AgentInboxPollResult>;
}

export const exportPresentationOptionsSchema = z
  .object({
    /** Explicit human approval for assets whose commercial license is not yet verified. */
    allowUnverifiedAssets: z.boolean().optional(),
  })
  .strict();

export type ExportPresentationOptions = z.infer<typeof exportPresentationOptionsSchema>;

export interface DeckExportResult {
  filePath: string;
  slideCount: number;
}
