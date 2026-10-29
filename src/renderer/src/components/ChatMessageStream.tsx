import { markTraceComplete } from "@shared/agent-activity";
import type { AgentTaskNode } from "@shared/agent-task-list";
import type { TeamSessionProjection } from "@shared/team-session";
import { type ReactNode, useState } from "react";
import { ArtifactCardHost } from "../cards/hosts/ArtifactCardHost";
import { InteractionCardHost } from "../cards/hosts/InteractionCardHost";
import { ReviewCardHost } from "../cards/hosts/ReviewCardHost";
import { AgentRunTerminalNotice } from "./AgentRunTerminalNotice";
import { IconButton } from "./Button";
import { CHAT_WORKSPACE_COPY_ZH_CN as copy } from "./chat-workspace-copy";
import type {
  ChatWorkspaceActions,
  ChatWorkspaceDeck,
  ChatWorkspaceRun,
  ChatWorkspaceSession,
} from "./chat-workspace-types";
import { CopyIcon, Edit3Icon } from "./Icons";
import { MarkdownView } from "./markdown/MarkdownView";
import { RunTimeline } from "./run-process/RunTimeline";
import { TaskPlanCard } from "./TaskPlanCard";
import { FocusedTeamSession } from "./TeamSessionViews";
import { UserMessageEditor } from "./UserMessageEditor";
import { useChatScroll } from "./useChatScroll";

interface ChatMessageStreamProps {
  session: ChatWorkspaceSession;
  run: ChatWorkspaceRun;
  deck: ChatWorkspaceDeck;
  actions: ChatWorkspaceActions;
  activeTasks: AgentTaskNode[];
  planGoal: string | null;
  planState?: "open" | "closed" | "archived";
  planArchive?: { outcome: "completed" | "abandoned"; reason?: string };
  teamSessions: TeamSessionProjection[];
  selectedTeamSession?: TeamSessionProjection;
  showMainConversation: boolean;
  onOpenTask: (sessionId: string) => void;
}

export function ChatMessageStream({
  session,
  run,
  deck,
  actions,
  activeTasks,
  planGoal,
  planState,
  planArchive,
  teamSessions,
  selectedTeamSession,
  showMainConversation,
  onOpenTask,
}: ChatMessageStreamProps): ReactNode {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const chatScroll = useChatScroll();
  const hasActiveTaskPlan = activeTasks.some((task) => task.status !== "completed");

  const startEditing = (messageId: string, currentText: string) => {
    chatScroll.setFollowing(false);
    setEditingMessageId(messageId);
    setEditingText(currentText);
  };
  const cancelEditing = () => {
    setEditingMessageId(null);
    setEditingText("");
  };
  const saveEditing = (messageId: string) => {
    const nextContent = editingText.trim();
    if (!nextContent || run.busy) return;
    chatScroll.setFollowing(true);
    setEditingMessageId(null);
    setEditingText("");
    actions.onUpdateMessageContent(messageId, nextContent);
  };
  const copyMessage = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      actions.notify(copy.copied);
    } catch {
      actions.notify(copy.copyFailed);
    }
  };

  if (!showMainConversation) {
    return selectedTeamSession ? <FocusedTeamSession session={selectedTeamSession} /> : null;
  }

  return (
    <>
      {session.messages.map((message) => {
        const isLiveAssistantMessage =
          message.role === "assistant" && run.busy && run.streamingMessageId === message.id;
        return (
          <div
            key={message.id}
            className={`chat-message ${message.role}${isLiveAssistantMessage ? " is-active-run" : ""}`}
          >
            {message.role === "user" ? (
              <div
                className={`user-message-shell${editingMessageId === message.id ? " is-editing" : ""}`}
              >
                <div
                  className={`user-message-bubble${editingMessageId === message.id ? " is-editing" : ""}`}
                >
                  {editingMessageId === message.id ? (
                    <UserMessageEditor
                      value={editingText}
                      busy={run.busy}
                      onChange={setEditingText}
                      onCancel={cancelEditing}
                      onSubmit={() => saveEditing(message.id)}
                    />
                  ) : (
                    <MarkdownView
                      documentId={message.id}
                      content={message.content}
                      className="user-message-text"
                    />
                  )}
                </div>

                {editingMessageId !== message.id && (
                  <div className="user-message-actions">
                    <IconButton
                      onClick={() => void copyMessage(message.content)}
                      title={copy.copyContent}
                      aria-label={copy.copyContent}
                    >
                      <CopyIcon size={13} />
                    </IconButton>
                    <IconButton
                      onClick={() => startEditing(message.id, message.content)}
                      disabled={run.busy}
                      title={copy.editAndRerun}
                      aria-label={copy.editAndRerun}
                    >
                      <Edit3Icon size={13} />
                    </IconButton>
                  </div>
                )}
              </div>
            ) : (
              <div className="assistant-message-shell">
                <div className="assistant-message-main">
                  <AssistantMessageContent message={message} run={run} activeTasks={activeTasks} />

                  <AgentRunTerminalNotice
                    status={message.runStatus}
                    error={message.runError}
                    onRetry={run.onRetry ? () => run.onRetry?.(message.id) : undefined}
                  />

                  <InteractionCardHost
                    host="timeline"
                    anchorMessageId={message.id}
                    busy={run.busy}
                    onResolveQuestion={actions.onResolveQuestion}
                  />
                  <ReviewCardHost
                    anchorMessageId={message.id}
                    busy={run.busy}
                    onResolveApproval={actions.onResolveApproval}
                    onResolvePatch={actions.onResolvePatch}
                    onFocusAffectedSlides={deck.onFocusAffectedSlides}
                  />
                  <ArtifactCardHost
                    anchorMessageId={message.id}
                    presentation={deck.presentation}
                    busy={run.busy}
                    isExportingDeck={deck.isExporting}
                    onReviseOutline={actions.onReviseOutline}
                    onOpenDeckPreview={deck.onOpenPreview}
                    onExportDeck={deck.onExport}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}

      <InteractionCardHost
        host="timeline"
        busy={run.busy}
        onResolveQuestion={actions.onResolveQuestion}
      />
      <ReviewCardHost
        busy={run.busy}
        onResolveApproval={actions.onResolveApproval}
        onResolvePatch={actions.onResolvePatch}
        onFocusAffectedSlides={deck.onFocusAffectedSlides}
      />
      <ArtifactCardHost
        presentation={deck.presentation}
        busy={run.busy}
        isExportingDeck={deck.isExporting}
        onReviseOutline={actions.onReviseOutline}
        onOpenDeckPreview={deck.onOpenPreview}
        onExportDeck={deck.onExport}
      />

      {activeTasks.length > 0 && (
        <div className="card-stack">
          <TaskPlanCard
            goal={planGoal}
            tasks={activeTasks}
            live={run.busy || hasActiveTaskPlan}
            state={planState}
            archive={planArchive}
            sessions={teamSessions}
            onOpenTask={onOpenTask}
          />
        </div>
      )}
    </>
  );
}

function AssistantMessageContent({
  message,
  run,
  activeTasks,
}: {
  message: ChatWorkspaceSession["messages"][number];
  run: ChatWorkspaceRun;
  activeTasks: AgentTaskNode[];
}) {
  const useLiveTrace = run.busy && run.streamingMessageId === message.id;
  const resolvedTrace = useLiveTrace
    ? run.activityTrace
    : message.runStatus === "running"
      ? (message.activityTrace ?? [])
      : markTraceComplete(
          message.activityTrace ?? [],
          message.runStatus === "failed"
            ? "failed"
            : message.runStatus === "interrupted"
              ? "denied"
              : "failed",
        );
  if (message.runId) {
    return (
      <RunTimeline
        documentId={message.id}
        items={resolvedTrace}
        content={message.content}
        live={useLiveTrace}
        startedAt={message.runStartedAt}
        runStatus={useLiveTrace ? "running" : message.runStatus}
        durationMs={useLiveTrace ? undefined : message.runDurationMs}
        teamGraphTasks={activeTasks}
      />
    );
  }
  return message.content ? (
    <MarkdownView
      documentId={message.id}
      content={message.content}
      className="assistant-response"
    />
  ) : null;
}
