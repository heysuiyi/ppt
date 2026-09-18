import { DEFAULT_DESIGN_SYSTEM } from "@design-system";
import {
  setDisplayCardStatus,
  useNotificationCardManager,
} from "@shared/cards/display-card-managers";
import { getWorkspaceLabel } from "@shared/workspace";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "./app/AppShell";
import { useAgentActivityStream } from "./app/agent/useAgentActivityStream";
import { useAgentRunController } from "./app/agent/useAgentRunController";
import { loadAppBootstrapSnapshot } from "./app/appBootstrap";
import { useDisplayEventActions } from "./app/cards/useDisplayEventActions";
import { ProjectFilesView } from "./app/ProjectFilesView";
import { useDeckExport } from "./app/presentation/useDeckExport";
import { usePresentationController } from "./app/presentation/usePresentationController";
import { confirmProjectFileNavigation } from "./app/project/projectFilesState";
import { SettingsView } from "./app/SettingsView";
import { useSessionController } from "./app/session/useSessionController";
import { useNotificationCenter } from "./app/useNotificationCenter";
import { useSettingsController } from "./app/useSettingsController";
import { useUserQuerySubmission } from "./app/useUserQuerySubmission";
import { type AppMode, useWorkbenchLayout } from "./app/useWorkbenchLayout";
import { WorkspaceView } from "./app/WorkspaceView";
import type { SettingsCategory } from "./settingsCategories";

export function App() {
  const [bootstrap] = useState(loadAppBootstrapSnapshot);
  const { message: toastMessage, notify } = useNotificationCenter();
  const credentialReentryNoticeShownRef = useRef(false);
  useEffect(() => {
    if (!bootstrap.credentialReentryRequired || credentialReentryNoticeShownRef.current) return;
    credentialReentryNoticeShownRef.current = true;
    notify("旧版明文 API Key 未迁移；请重新录入，并轮换此前使用的 Key");
  }, [bootstrap.credentialReentryRequired, notify]);
  const presentationController = usePresentationController(notify);
  const {
    presentation,
    selectedSlideId,
    setSelectedSlideId,
    highlightSlideId,
    isMirrorVisible,
    isMirrorExpanded,
    isDeckPreviewOpen,
    loadPresentation,
    resetPresentation,
    syncPresentation,
    openMirror,
    closeMirror,
    toggleMirrorExpanded,
    openDeckPreview,
    closeDeckPreview,
    focusAffectedSlides,
  } = presentationController;

  const [activeMode, setActiveMode] = useState<AppMode>("workspace");
  const [projectFilesDirty, setProjectFilesDirty] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("models");
  const workbenchLayout = useWorkbenchLayout({
    activeMode,
    previewOpen: isMirrorVisible,
    previewExpanded: isMirrorExpanded,
  });
  const settings = useSettingsController(bootstrap, presentation, notify);
  const {
    selectedModelId,
    selectModel: setSelectedModelId,
    enabledModels,
    defaultTemplateId,
    setDefaultTemplateId,
  } = settings;

  const [busy, setBusy] = useState(false);
  const sessionController = useSessionController({
    busy,
    presentation,
    loadPresentation,
    resetPresentation,
    syncPresentation,
    notify,
    markSettingsSaving: settings.markSaving,
  });
  const {
    request,
    setRequest,
    startupError,
    sessions,
    activeSessionId,
    activeSessionIdRef,
    sessionLoaded,
    isSessionSwitching,
    pendingSessionId,
    localStoragePath,
    chatMessages,
    setChatMessages,
    applySessionState,
    selectWorkspaceFolder,
    openWorkspace,
    newSession,
    newSessionInWorkspace,
    selectSession,
    deleteSession,
  } = sessionController;
  const { isExportingDeck, exportDeck } = useDeckExport({
    sessionId: activeSessionId,
    presentation,
    setChatMessages,
    notify,
  });

  const activity = useAgentActivityStream({
    activeSessionIdRef,
    setChatMessages,
  });
  const { activityTrace, agentRunPhase } = activity;
  const agentRun = useAgentRunController({
    request,
    setRequest,
    busy,
    setBusy,
    activeSessionId,
    sessionLoaded,
    localStoragePath,
    selectedSlideId,
    chatMessages,
    setChatMessages,
    applySessionState,
    syncPresentation,
    settings,
    activity,
    notify,
  });
  const {
    activeRunId,
    streamingMessageId,
    isCancellingRun,
    startAgent,
    cancelRun,
    retryMessage,
    suggestPrompt,
    resolveToolApproval,
  } = agentRun;

  const submitUserQuery = useUserQuerySubmission({
    request,
    busy,
    presentation,
    activeSessionId,
    setRequest,
    setChatMessages,
    openDeckPreview,
    notify,
    startAgent,
  });

  const displayActions = useDisplayEventActions({
    busy,
    setBusy,
    activeSessionId,
    setChatMessages,
    syncPresentation,
    activity,
    agentRun,
    notify,
  });

  const notificationCards = useNotificationCardManager((state) => state.cards);
  const lastNotificationEventIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const latest = [...notificationCards]
      .reverse()
      .find((card) => card.status === "active" && card.event.kind === "notification.message");
    if (
      latest?.event.kind !== "notification.message" ||
      latest.event.eventId === lastNotificationEventIdRef.current
    )
      return;
    lastNotificationEventIdRef.current = latest.event.eventId;
    notify(latest.event.payload.message);
    setDisplayCardStatus(latest.event.eventId, "resolved");
  }, [notificationCards, notify]);

  if (startupError) {
    return (
      <main className="loading error">
        <span className="loading-message">{startupError}</span>
      </main>
    );
  }
  if (!sessionLoaded) {
    return (
      <main className="loading">
        <span className="loading-indicator" aria-hidden="true" />
        <span className="loading-message">正在打开本地演示文稿工作区...</span>
      </main>
    );
  }

  const activeSessionTitle =
    sessions.find((session) => session.id === activeSessionId)?.title.trim() ||
    presentation?.title?.trim() ||
    (activeSessionId ? "当前对话" : "AI 新建会话");
  const confirmLeaveProjectFiles = () =>
    activeMode !== "files" ||
    confirmProjectFileNavigation(projectFilesDirty, () =>
      window.confirm("当前项目文件有未保存修改。要放弃草稿并离开吗？"),
    );
  const leftPanelProps = {
    sessions,
    activeSessionId: pendingSessionId ?? activeSessionId,
    activeMode: activeMode === "files" ? ("files" as const) : ("workspace" as const),
    onSelectSession: (sessionId: string) => {
      if (sessionId === activeSessionId || isSessionSwitching || !confirmLeaveProjectFiles())
        return;
      void selectSession(sessionId);
    },
    onNewSession: () => {
      if (!confirmLeaveProjectFiles()) return;
      setActiveMode("workspace");
      void newSession();
    },
    onNewSessionInWorkspace: (workspacePath: string) => {
      if (!confirmLeaveProjectFiles()) return;
      setActiveMode("workspace");
      void newSessionInWorkspace(workspacePath);
    },
    onOpenWorkspace: () => {
      if (confirmLeaveProjectFiles()) setActiveMode("workspace");
    },
    onOpenFiles: () => setActiveMode("files"),
    onToggleSettings: () => {
      if (!confirmLeaveProjectFiles()) return;
      setActiveMode("settings");
      setSettingsCategory("models");
    },
    onDeleteSession: (sessionId: string) => {
      if (sessionId === activeSessionId && !confirmLeaveProjectFiles()) return;
      void deleteSession(sessionId);
    },
  };

  return (
    <AppShell
      notificationMessage={toastMessage}
      workspaceClassName={workbenchLayout.workspaceClassName}
      workspaceStyle={workbenchLayout.workspaceStyle}
      showSidebarToggle={activeMode !== "settings"}
      sidebarCollapsed={workbenchLayout.isPrimarySidebarCollapsed}
      onToggleSidebar={workbenchLayout.togglePrimarySidebar}
      showTemplateMenu={activeMode !== "settings"}
      activeSessionId={activeSessionId || undefined}
      defaultTemplateId={defaultTemplateId}
      setDefaultTemplateId={setDefaultTemplateId}
      onOpenTemplateSettings={() => {
        if (!confirmLeaveProjectFiles()) return;
        setActiveMode("settings");
        setSettingsCategory("templates");
      }}
      notify={notify}
    >
      {activeMode === "workspace" ? (
        <WorkspaceView
          leftPanelProps={leftPanelProps}
          isSessionSwitching={isSessionSwitching}
          chatWorkspaceProps={{
            session: {
              id: activeSessionId,
              isLoading: !sessionLoaded,
              isSwitching: isSessionSwitching,
              conversationTitle: activeSessionTitle,
              messages: chatMessages,
            },
            run: {
              activityTrace,
              phase: agentRunPhase,
              streamingMessageId,
              busy,
              activeRunId,
              onCancel: () => void cancelRun(),
              isCancelling: isCancellingRun,
              onRetry: retryMessage,
            },
            composer: {
              request,
              onChangeRequest: setRequest,
              onSubmitRequest: submitUserQuery,
              models: enabledModels,
              selectedModelId,
              onSelectModel: setSelectedModelId,
              workspacePath: localStoragePath,
              onPrepareWorkspace: () => void selectWorkspaceFolder(),
              onProposePrompt: suggestPrompt,
            },
            deck: {
              presentation,
              selectedSlideId,
              isMirrorOpen: isMirrorVisible,
              onToggleMirror: openMirror,
              onOpenPreview: openDeckPreview,
              onExport: () => void exportDeck(),
              isExporting: isExportingDeck,
              onFocusAffectedSlides: focusAffectedSlides,
            },
            actions: {
              onResolveApproval: displayActions.resolveApproval,
              onResolvePatch: (event, accepted) =>
                void displayActions.resolvePatch(event, accepted),
              onResolveQuestion: displayActions.resolveQuestion,
              onResolveToolApproval: (approvalId, approved) =>
                void resolveToolApproval(approvalId, approved),
              onReviseOutline: displayActions.reviseOutline,
              onUpdateMessageContent: (messageId, content) =>
                displayActions.updateMessageContent(messageId, content, chatMessages),
              notify,
            },
          }}
          mirrorProps={
            isMirrorVisible && presentation
              ? {
                  sessionId: activeSessionId,
                  presentation,
                  selectedSlideId,
                  onSelectSlide: setSelectedSlideId,
                  onCloseMirror: closeMirror,
                  highlightSlideId,
                  isExpanded: isMirrorExpanded,
                  onToggleExpand: toggleMirrorExpanded,
                  triggerToast: notify,
                }
              : undefined
          }
          deckPreviewProps={{
            open: isDeckPreviewOpen && Boolean(presentation),
            presentation: presentation ?? {
              id: "",
              title: "",
              revision: 0,
              designSystem: DEFAULT_DESIGN_SYSTEM,
              slides: [],
            },
            selectedSlideId,
            onSelectSlide: setSelectedSlideId,
            onClose: closeDeckPreview,
          }}
          isMirrorVisible={isMirrorVisible}
          isMirrorExpanded={isMirrorExpanded}
          isPrimarySidebarCollapsed={workbenchLayout.isPrimarySidebarCollapsed}
          onTogglePrimarySidebar={workbenchLayout.togglePrimarySidebar}
          onStartPanelResize={workbenchLayout.startPanelResize}
        />
      ) : activeMode === "files" ? (
        <ProjectFilesView
          leftPanelProps={leftPanelProps}
          projectFilesProps={{
            sessionId: activeSessionId || undefined,
            sessionTitle: activeSessionTitle,
            workspaceLabel: getWorkspaceLabel(localStoragePath || undefined),
            busy,
            notify,
            onDirtyChange: setProjectFilesDirty,
          }}
          isPrimarySidebarCollapsed={workbenchLayout.isPrimarySidebarCollapsed}
          onTogglePrimarySidebar={workbenchLayout.togglePrimarySidebar}
          onStartPanelResize={workbenchLayout.startPanelResize}
        />
      ) : (
        <SettingsView
          activeCategory={settingsCategory}
          onSelectCategory={setSettingsCategory}
          onBackToWorkspace={() => setActiveMode("workspace")}
          controller={settings}
          localStoragePath={localStoragePath}
          onOpenWorkspace={() => void openWorkspace()}
          notify={notify}
          onStartPanelResize={workbenchLayout.startPanelResize}
          activeSessionId={activeSessionId || undefined}
        />
      )}
    </AppShell>
  );
}
