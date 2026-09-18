import { DEFAULT_DESIGN_SYSTEM } from "@design-system";
import {
  setDisplayCardStatus,
  useNotificationCardManager,
} from "@shared/cards/display-card-managers";
import { getWorkspaceLabel } from "@shared/workspace";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import type { AppShell } from "./AppShell";
import type { AppTopbar } from "./AppTopbar";
import { useAgentActivityStream } from "./agent/useAgentActivityStream";
import { useAgentRunController } from "./agent/useAgentRunController";
import { loadAppBootstrapSnapshot } from "./appBootstrap";
import type { AppBootState } from "./appViewState";
import { useDisplayEventActions } from "./cards/useDisplayEventActions";
import { useDeckExport } from "./presentation/useDeckExport";
import { usePresentationController } from "./presentation/usePresentationController";
import type { SettingsView } from "./SettingsView";
import { useSessionController } from "./session/useSessionController";
import { useAppNavigation } from "./useAppNavigation";
import { useNotificationCenter } from "./useNotificationCenter";
import { useSettingsController } from "./useSettingsController";
import { useUserQuerySubmission } from "./useUserQuerySubmission";
import { useWorkbenchLayout } from "./useWorkbenchLayout";
import type { WorkspaceView } from "./WorkspaceView";

type AppModel = {
  boot: AppBootState;
  shell: Omit<ComponentProps<typeof AppShell>, "topbar" | "children">;
  topbar: ComponentProps<typeof AppTopbar>;
  content:
    | { area: "workspace"; props: ComponentProps<typeof WorkspaceView> }
    | { area: "settings"; props: ComponentProps<typeof SettingsView> };
};

export function useAppModel(): AppModel {
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

  const { location, actions: navigation } = useAppNavigation();
  const [hasLoadedWorkspace, setHasLoadedWorkspace] = useState(false);
  const workbenchLayout = useWorkbenchLayout({
    location,
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

  useEffect(() => {
    if (sessionLoaded) setHasLoadedWorkspace(true);
  }, [sessionLoaded]);
  const boot: AppBootState = startupError
    ? { status: "error", message: startupError }
    : hasLoadedWorkspace || sessionLoaded
      ? { status: "ready" }
      : { status: "loading" };

  const activeSessionTitle =
    sessions.find((session) => session.id === activeSessionId)?.title.trim() ||
    presentation?.title?.trim() ||
    (activeSessionId ? "当前对话" : "AI 新建会话");
  const leftPanelProps = {
    sessions,
    activeSessionId: pendingSessionId ?? activeSessionId,
    onSelectSession: (sessionId: string) => {
      if (
        sessionId === activeSessionId ||
        !sessionLoaded ||
        isSessionSwitching ||
        !navigation.confirmLeaveProjectFiles()
      )
        return;
      void selectSession(sessionId);
    },
    onNewSession: () => {
      if (!sessionLoaded || isSessionSwitching || !navigation.showWorkspacePage("chat")) return;
      void newSession();
    },
    onNewSessionInWorkspace: (workspacePath: string) => {
      if (!sessionLoaded || isSessionSwitching || !navigation.showWorkspacePage("chat")) return;
      void newSessionInWorkspace(workspacePath);
    },
    onOpenWorkspace: () => {
      navigation.showWorkspacePage("chat");
    },
    onOpenFiles: () => navigation.showWorkspacePage("files"),
    onToggleSettings: () => navigation.openSettings(),
    onDeleteSession: (sessionId: string) => {
      if (!sessionLoaded || isSessionSwitching) return;
      if (sessionId === activeSessionId && !navigation.confirmLeaveProjectFiles()) return;
      void deleteSession(sessionId);
    },
  };

  return {
    boot,
    shell: {
      notificationMessage: toastMessage,
      workspaceClassName: workbenchLayout.workspaceClassName,
      workspaceStyle: workbenchLayout.workspaceStyle,
    },
    topbar: {
      state: { location, sidebarCollapsed: workbenchLayout.isPrimarySidebarCollapsed },
      data: { activeSessionId: activeSessionId || undefined, defaultTemplateId },
      actions: {
        toggleSidebar: workbenchLayout.togglePrimarySidebar,
        setDefaultTemplateId,
        openTemplateSettings: () => navigation.openSettings("templates"),
        notify,
      },
    },
    content:
      location.area === "workspace"
        ? {
            area: "workspace",
            props: {
              state: location,
              projectFilesProps: {
                sessionId: activeSessionId || undefined,
                sessionTitle: activeSessionTitle,
                workspaceLabel: getWorkspaceLabel(localStoragePath || undefined),
                busy: busy || !sessionLoaded || isSessionSwitching,
                notify,
                onDirtyChange: navigation.setProjectFilesDirty,
              },
              leftPanelProps,
              isSessionSwitching,
              chatWorkspaceProps: {
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
              },
              mirrorProps:
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
                  : undefined,
              deckPreviewProps: {
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
              },
              isMirrorVisible,
              isMirrorExpanded,
              isPrimarySidebarCollapsed: workbenchLayout.isPrimarySidebarCollapsed,
              onTogglePrimarySidebar: workbenchLayout.togglePrimarySidebar,
              onStartPanelResize: workbenchLayout.startPanelResize,
            },
          }
        : {
            area: "settings",
            props: {
              activeCategory: location.category,
              onSelectCategory: navigation.selectSettingsCategory,
              onBackToWorkspace: navigation.backToWorkspace,
              controller: settings,
              localStoragePath,
              onOpenWorkspace: () => {
                if (sessionLoaded) void openWorkspace();
              },
              notify,
              onStartPanelResize: workbenchLayout.startPanelResize,
              activeSessionId: activeSessionId || undefined,
            },
          },
  };
}
