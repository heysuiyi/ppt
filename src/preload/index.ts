import type { AgentStreamEvent, DesktopApi } from "@shared/ipc";
import type { PptJobProjection } from "@shared/presentation-lifecycle";
import { contextBridge, ipcRenderer } from "electron";

const api: DesktopApi = {
  // Session 与工作区
  getSessionState: () => ipcRenderer.invoke("session:get-state"),
  createSession: (options) => ipcRenderer.invoke("session:create", options),
  openWorkspace: (rootPath) => ipcRenderer.invoke("workspace:open", rootPath),
  selectSession: (sessionId) => ipcRenderer.invoke("session:select", sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke("session:delete", sessionId),
  saveSessionMessages: (sessionId, messages) =>
    ipcRenderer.invoke("session:save-messages", sessionId, messages),
  saveSessionDisplayCards: (sessionId, cards) =>
    ipcRenderer.invoke("session:save-display-cards", sessionId, cards),

  // 日志与用量统计
  getTokenUsageStats: () => ipcRenderer.invoke("token-usage:get-stats"),
  getLogManagerStatus: () => ipcRenderer.invoke("logs:get-status"),
  getRecentLogs: (limit, minimumLevel) =>
    ipcRenderer.invoke("logs:get-recent", limit, minimumLevel),
  updateLogManagerSettings: (patch) => ipcRenderer.invoke("logs:update-settings", patch),
  clearLogs: () => ipcRenderer.invoke("logs:clear"),
  openLogDirectory: () => ipcRenderer.invoke("logs:open-directory"),
  getApplicationDataPath: () => ipcRenderer.invoke("app:get-data-path"),
  openApplicationDataDirectory: () => ipcRenderer.invoke("app:open-data-directory"),
  listUiThemes: () => ipcRenderer.invoke("ui-themes:list"),
  readUiThemeCss: (themeId) => ipcRenderer.invoke("ui-themes:read", themeId),
  openUiThemesDirectory: () => ipcRenderer.invoke("ui-themes:open-directory"),
  reportRendererLog: (report) => ipcRenderer.send("logs:renderer-report", report),

  // 凭据只能写入 Main 的系统安全存储；Renderer 没有读取明文密钥的接口。
  getCredentialStatus: (request) => ipcRenderer.invoke("credentials:get-status", request),
  setModelCredentials: (request) => ipcRenderer.invoke("credentials:set-models", request),
  deleteModelCredential: (request) => ipcRenderer.invoke("credentials:delete-model", request),
  setWebSearchCredential: (request) => ipcRenderer.invoke("credentials:set-web-search", request),
  deleteWebSearchCredential: () => ipcRenderer.invoke("credentials:delete-web-search"),
  listRemoteModels: (request) => ipcRenderer.invoke("models:list-remote", request),

  // 项目产物
  listProjectArtifacts: (sessionId) => ipcRenderer.invoke("project:list-artifacts", sessionId),
  readProjectArtifact: (sessionId, artifactIdOrPath) =>
    ipcRenderer.invoke("project:read-artifact", sessionId, artifactIdOrPath),
  getProjectArtifactDiff: (sessionId, relativePath, nextContent) =>
    ipcRenderer.invoke("project:get-artifact-diff", sessionId, relativePath, nextContent),
  listProjectFiles: (sessionId) => ipcRenderer.invoke("project:list-files", sessionId),
  openProjectFile: (sessionId, relativePath) =>
    ipcRenderer.invoke("project:open-file", sessionId, relativePath),
  saveProjectFile: (sessionId, relativePath, content, editToken, expectedVersion) =>
    ipcRenderer.invoke(
      "project:save-file",
      sessionId,
      relativePath,
      content,
      editToken,
      expectedVersion,
    ),
  getPptJob: (sessionId) => ipcRenderer.invoke("ppt-job:get", sessionId),
  onPptJobChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, projection: PptJobProjection) =>
      listener(projection);
    ipcRenderer.on("ppt-job:changed", handler);
    return () => ipcRenderer.removeListener("ppt-job:changed", handler);
  },

  // 演示文稿读取与导出（变更经 Agent CommitGate，不暴露直接 execute/undo/redo）
  getPresentation: () => ipcRenderer.invoke("presentation:get"),
  exportPresentation: (sessionId, options) =>
    ipcRenderer.invoke("presentation:export", sessionId, options),
  openExportFolder: (filePath) => ipcRenderer.invoke("shell:open-export-folder", filePath),

  // Agent 运行与交互
  getAgentSettings: () => ipcRenderer.invoke("agent-settings:get"),
  saveAgentSettings: (settings) => ipcRenderer.invoke("agent-settings:save", settings),
  migrateAgentSettings: (settings) => ipcRenderer.invoke("agent-settings:migrate", settings),
  submitAgentRun: (request) => ipcRenderer.invoke("agent:submit", request),
  onAgentRunAccepted: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      accepted: import("@shared/ipc").AgentRunAccepted,
    ) => listener(accepted);
    ipcRenderer.on("agent:accepted", handler);
    return () => ipcRenderer.removeListener("agent:accepted", handler);
  },
  onAgentStream: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, streamEvent: AgentStreamEvent) => {
      listener(streamEvent);
    };
    ipcRenderer.on("agent:stream", handler);
    return () => ipcRenderer.removeListener("agent:stream", handler);
  },
  resumeAgentRun: (sessionId, proposalId, approved) =>
    ipcRenderer.invoke("agent:resume", sessionId, proposalId, approved),
  cancelAgentRun: (runId) => ipcRenderer.invoke("agent:cancel", runId),
  cancelAgentSession: (sessionId) => ipcRenderer.invoke("agent:cancel-session", sessionId),
  resolveToolApproval: (runId, approvalId, approved) =>
    ipcRenderer.invoke("agent:resolve-tool-approval", runId, approvalId, approved),
  pollLeadInbox: (sessionId) => ipcRenderer.invoke("agent:poll-lead-inbox", sessionId),

  // 原生窗口与对话框
  selectDirectory: (defaultPath) => ipcRenderer.invoke("dialog:select-directory", defaultPath),
  selectTemplatePackage: (defaultPath) =>
    ipcRenderer.invoke("dialog:select-template-package", defaultPath),
  importProjectTemplate: (sessionId, sourceFilePath, displayName) =>
    ipcRenderer.invoke("template:import", sessionId, sourceFilePath, displayName),
  listProjectTemplates: (sessionId) => ipcRenderer.invoke("template:list", sessionId),
  listApplicationTemplates: () => ipcRenderer.invoke("template:list-application"),
  applyTemplateToProject: (sessionId, templateId, revisionId) =>
    ipcRenderer.invoke("template:apply", sessionId, templateId, revisionId),
  getProjectTemplatePolicy: (sessionId) => ipcRenderer.invoke("template:get-policy", sessionId),
  getProjectTemplatePack: (sessionId) => ipcRenderer.invoke("template:get-pack", sessionId),
  setProjectTemplatePolicy: (sessionId, policy) =>
    ipcRenderer.invoke("template:set-policy", sessionId, policy),
  setWindowThemeMode: (themeMode) => ipcRenderer.invoke("window:set-theme-mode", themeMode),
};

contextBridge.exposeInMainWorld("desktopApi", api);
