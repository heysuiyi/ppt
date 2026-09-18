import {
  findActiveToolPermissionCard,
  usePermissionCardManager,
  useProgressCardManager,
} from "@shared/cards/display-card-managers";
import { collectTeamSessions } from "@shared/team-session";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChatWorkspaceComposer } from "./ChatWorkspaceComposer";
import { ChatWorkspaceConversation } from "./ChatWorkspaceConversation";
import { ChatWorkspaceHeader } from "./ChatWorkspaceHeader";
import { CHAT_WORKSPACE_COPY_ZH_CN as copy } from "./chat-workspace-copy";
import type {
  ChatWorkspaceInputRuntime,
  ChatWorkspaceProps,
  ChatWorkspaceViewState,
} from "./chat-workspace-types";
import { ChatScrollProvider, useChatScroll } from "./useChatScroll";

export type { ChatWorkspaceProps } from "./chat-workspace-types";

type ConversationFocus = { kind: "main" } | { kind: "team-session"; sessionId: string };

function focusKey(focus: ConversationFocus): string {
  return focus.kind === "team-session" ? `team:${focus.sessionId}` : focus.kind;
}

export function ChatWorkspace(props: ChatWorkspaceProps): ReactNode {
  return (
    <ChatScrollProvider>
      <ChatWorkspaceContent {...props} />
    </ChatScrollProvider>
  );
}

function ChatWorkspaceContent({
  session,
  run,
  composer,
  deck,
  actions,
}: ChatWorkspaceProps): ReactNode {
  const activeRunStartedAtRef = useRef<number | null>(null);
  if (run.busy && activeRunStartedAtRef.current === null) {
    activeRunStartedAtRef.current = Date.now();
  } else if (!run.busy) {
    activeRunStartedAtRef.current = null;
  }

  const managedPermissionCards = usePermissionCardManager((state) => state.cards);
  const managedPermission = findActiveToolPermissionCard(managedPermissionCards, run.activeRunId);
  const pendingToolApproval =
    managedPermission?.event.kind === "permission.tool-requested"
      ? managedPermission.event.payload
      : undefined;
  const inputRuntime: ChatWorkspaceInputRuntime = {
    pendingToolApproval: pendingToolApproval
      ? {
          approvalId: pendingToolApproval.approvalId,
          toolName: pendingToolApproval.toolName,
          reason: pendingToolApproval.reason,
          detail: pendingToolApproval.detail,
        }
      : null,
    canCancelRun: Boolean(run.busy && run.activeRunId && run.onCancel),
    runStartedAt: activeRunStartedAtRef.current ?? undefined,
  };
  // Derive the region phase from session/run facts; lifecycle controllers never set UI phases.
  const view: ChatWorkspaceViewState = {
    phase:
      run.busy && !session.id
        ? "entering"
        : session.id && (session.messages.length > 0 || run.busy)
          ? "conversation"
          : "welcome",
    isSwitching: session.isSwitching ?? false,
    inputDisabled: Boolean(session.isLoading || session.isSwitching),
    workspaceBound: Boolean(session.id),
  };
  const title =
    session.conversationTitle?.trim() ||
    (view.phase === "welcome" ? copy.newChatTitle : copy.currentChatTitle);

  const chatScroll = useChatScroll();
  const [conversationFocus, setConversationFocus] = useState<ConversationFocus>({ kind: "main" });
  const [mainHasAttention, setMainHasAttention] = useState(false);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const pendingScrollRestoreRef = useRef<string | null>(null);
  const mainFingerprintRef = useRef<string | null>(null);
  const decisionReturnFocusRef = useRef<ConversationFocus | null>(null);
  const hadPendingDecisionRef = useRef(false);
  const sessionIdentityRef = useRef<string | null>(null);

  const managedProgressCards = useProgressCardManager((state) => state.cards);
  const managedTaskList = [...managedProgressCards]
    .reverse()
    .find(
      (card) =>
        card.status === "active" &&
        card.event.kind === "progress.task-list-updated" &&
        (!run.activeRunId || card.event.scope.runId === run.activeRunId),
    );
  const managedTaskListPayload =
    managedTaskList?.event.kind === "progress.task-list-updated"
      ? managedTaskList.event.payload
      : undefined;
  const latestPlan = managedTaskListPayload
    ? {
        tasks: [...managedTaskListPayload.tasks],
        goal: managedTaskListPayload.goal ?? null,
        state: managedTaskListPayload.state,
        archive: managedTaskListPayload.archive,
      }
    : null;
  const activeTasks = latestPlan?.tasks ?? [];
  const sessionGoal =
    session.messages.find((message) => message.role === "user")?.content.trim() || null;
  const planGoal = latestPlan ? latestPlan.goal : sessionGoal;
  const teamSessions = useMemo(
    () =>
      collectTeamSessions(
        [...session.messages.map((message) => message.activityTrace), run.activityTrace],
        activeTasks,
      ),
    [activeTasks, run.activityTrace, session.messages],
  );
  const selectedTeamSession =
    conversationFocus.kind === "team-session"
      ? teamSessions.find((teamSession) => teamSession.id === conversationFocus.sessionId)
      : undefined;
  const currentFocusKey = focusKey(conversationFocus);
  const sessionIdentity = session.id;
  const mainFingerprint = useMemo(() => {
    const lastMessage = session.messages.at(-1);
    const leadTrace = run.activityTrace.filter(
      (item) => item.kind !== "task" && item.kind !== "tasklist",
    );
    const lastLeadItem = leadTrace.at(-1);
    return [
      lastMessage?.id ?? "",
      lastMessage?.content.length ?? 0,
      run.busy ? "busy" : "idle",
      leadTrace.length,
      lastLeadItem?.id ?? "",
      lastLeadItem?.kind ?? "",
    ].join(":");
  }, [run.activityTrace, run.busy, session.messages]);

  const switchConversationFocus = useCallback(
    (nextFocus: ConversationFocus) => {
      scrollPositionsRef.current.set(currentFocusKey, chatScroll.getScrollTop());
      pendingScrollRestoreRef.current = focusKey(nextFocus);
      chatScroll.setFollowing(false);
      setConversationFocus(nextFocus);
      if (nextFocus.kind === "main") setMainHasAttention(false);
    },
    [chatScroll, currentFocusKey],
  );

  const focusTeamSession = useCallback(
    (sessionId: string) => {
      switchConversationFocus({ kind: "team-session", sessionId });
    },
    [switchConversationFocus],
  );

  const openPendingDecision = useCallback(() => {
    if (!inputRuntime.pendingToolApproval) return;
    if (conversationFocus.kind !== "main") decisionReturnFocusRef.current = conversationFocus;
    switchConversationFocus({ kind: "main" });
    window.requestAnimationFrame(() => {
      chatScroll.setFollowing(true);
      chatScroll.scrollToBottom();
    });
  }, [chatScroll, conversationFocus, inputRuntime.pendingToolApproval, switchConversationFocus]);

  useLayoutEffect(() => {
    if (sessionIdentityRef.current === null) {
      sessionIdentityRef.current = sessionIdentity;
      return;
    }
    if (sessionIdentityRef.current === sessionIdentity) return;
    sessionIdentityRef.current = sessionIdentity;
    scrollPositionsRef.current.clear();
    mainFingerprintRef.current = null;
    decisionReturnFocusRef.current = null;
    hadPendingDecisionRef.current = false;
    pendingScrollRestoreRef.current = null;
    setMainHasAttention(false);
    setConversationFocus({ kind: "main" });
    chatScroll.setFollowing(true);
    chatScroll.scrollToBottom();
  }, [chatScroll, sessionIdentity]);

  useEffect(() => {
    if (
      conversationFocus.kind === "team-session" &&
      !teamSessions.some((teamSession) => teamSession.id === conversationFocus.sessionId)
    ) {
      switchConversationFocus({ kind: "main" });
    }
  }, [conversationFocus, switchConversationFocus, teamSessions]);

  useEffect(() => {
    const previous = mainFingerprintRef.current;
    mainFingerprintRef.current = mainFingerprint;
    if (previous && previous !== mainFingerprint && conversationFocus.kind !== "main") {
      setMainHasAttention(true);
    }
  }, [conversationFocus.kind, mainFingerprint]);

  useEffect(() => {
    const pending = Boolean(inputRuntime.pendingToolApproval);
    if (hadPendingDecisionRef.current && !pending && decisionReturnFocusRef.current) {
      const returnFocus = decisionReturnFocusRef.current;
      decisionReturnFocusRef.current = null;
      switchConversationFocus(returnFocus);
    }
    hadPendingDecisionRef.current = pending;
  }, [inputRuntime.pendingToolApproval, switchConversationFocus]);

  useLayoutEffect(() => {
    if (pendingScrollRestoreRef.current !== currentFocusKey) return;
    chatScroll.setScrollTop(scrollPositionsRef.current.get(currentFocusKey) ?? 0);
    pendingScrollRestoreRef.current = null;
  }, [chatScroll, currentFocusKey]);

  const showConversation = view.phase !== "welcome";
  useLayoutEffect(() => {
    if (!showConversation) return;
    const unbind = chatScroll.bind();
    chatScroll.stickToBottomIfFollowing();
    return unbind;
  }, [chatScroll, showConversation]);

  return (
    <section
      className={`canvas-column chat-workspace-column view-enter${view.phase === "welcome" ? " center-focal-wrapper" : ""}${view.isSwitching ? " is-session-switching" : ""}`}
      data-chat-phase={view.phase}
      aria-busy={view.isSwitching || view.phase === "entering" || undefined}
    >
      <ChatWorkspaceHeader
        view={view}
        title={title}
        deck={deck}
        inputRuntime={inputRuntime}
        showMainConversation={conversationFocus.kind === "main"}
        selectedTeamTitle={selectedTeamSession?.title}
        mainHasAttention={mainHasAttention}
        onShowMain={() => switchConversationFocus({ kind: "main" })}
        onOpenPendingDecision={openPendingDecision}
      />
      <ChatWorkspaceConversation
        view={view}
        session={session}
        run={run}
        deck={deck}
        actions={actions}
        activeTasks={activeTasks}
        planGoal={planGoal}
        planState={latestPlan?.state}
        planArchive={latestPlan?.archive}
        teamSessions={teamSessions}
        selectedTeamSession={selectedTeamSession}
        showMainConversation={conversationFocus.kind === "main"}
        onOpenTask={focusTeamSession}
      />
      <ChatWorkspaceComposer
        view={view}
        composer={composer}
        run={run}
        deck={deck}
        actions={actions}
        inputRuntime={inputRuntime}
        viewingTeamSession={conversationFocus.kind !== "main"}
      />
    </section>
  );
}
