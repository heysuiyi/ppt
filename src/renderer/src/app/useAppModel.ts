import { DEFAULT_DESIGN_SYSTEM } from "@design-system";
import { formatPublicErrorMessage } from "@shared/agent-activity-display";
import {
  setDisplayCardStatus,
  useNotificationCardManager,
} from "@shared/cards/display-card-managers";
import { createOpenExportFolderHref } from "@shared/export-links";
import { getWorkspaceLabel } from "@shared/workspace";
import {
  type ComponentProps,
  type CSSProperties,
  type RefCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { AppTopbar } from "./AppTopbar";
import { useAgentActivityStream } from "./agent/useAgentActivityStream";
import { useAgentRunController } from "./agent/useAgentRunController";
import type { AppBootstrapSnapshot } from "./appBootstrap";
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
  shell: {
    notificationMessage: string | null;
    workspaceClassName: string;
    workspaceStyle: CSSProperties;
    workspaceRef: RefCallback<HTMLDivElement>;
  };
  topbar: ComponentProps<typeof AppTopbar>;
  content:
    | { area: "workspace"; props: ComponentProps<typeof WorkspaceView> }
    | { area: "settings"; props: ComponentProps<typeof SettingsView> };
};

export function useAppModel(bootstrap: AppBootstrapSnapshot): AppModel {
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
  const { isExportingDeck, exportDeck: runDeckExport } = useDeckExport({
    sessionId: activeSessionId,
    presentation,
  });
  const exportDeck = () =>
    runDeckExport((result) => {
      const content =
        result.status === "saved"
          ? `文件已保存。 [打开所在目录](${createOpenExportFolderHref(result.path)})`
          : result.status === "cancelled"
            ? "已取消导出。"
            : `导出失败：${formatPublicErrorMessage(result.error, "导出时遇到问题，请重试。")}`;
      setChatMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content,
        },
      ]);
      if (result.status === "saved") notify(`已成功导出至: ${result.path}`);
      if (result.status === "failed") {
        notify(`导出失败: ${formatPublicErrorMessage(result.error, "导出时遇到问题，请重试。")}`);
      }
    });
  const exportDeckFromMirror = () =>
    runDeckExport((result) => {
      if (result.status === "saved") notify(`已成功导出至: ${result.path}`);
      if (result.status === "failed") {
        notify(`导出失败：${formatPublicErrorMessage(result.error, "请稍后重试。")}`);
      }
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
      workspaceRef: workbenchLayout.workspaceRef,
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
                  phase:
                    agentRun.submissionPhase === "submitting" ||
                    agentRun.submissionPhase === "preparing"
                      ? agentRun.submissionPhase
                      : agentRunPhase,
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
                      isExporting: isExportingDeck,
                      onExport: () => void exportDeckFromMirror(),
                      presentation,
                      selectedSlideId,
                      onSelectSlide: setSelectedSlideId,
                      onCloseMirror: closeMirror,
                      highlightSlideId,
                      isExpanded: isMirrorExpanded,
                      onToggleExpand: toggleMirrorExpanded,
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
              primaryResize: workbenchLayout.primaryResize,
              secondaryResize: workbenchLayout.secondaryResize,
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
              primaryResize: workbenchLayout.primaryResize,
              activeSessionId: activeSessionId || undefined,
            },
          },
  };
}
