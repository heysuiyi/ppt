import { CHAT_WORKSPACE_COPY_ZH_CN as copy } from "./chat-workspace-copy";
import type {
  ChatWorkspaceDeck,
  ChatWorkspaceInputRuntime,
  ChatWorkspaceViewState,
} from "./chat-workspace-types";
import { ChevronRightIcon, OpenPreviewIcon } from "./Icons";

interface ChatWorkspaceHeaderProps {
  view: ChatWorkspaceViewState;
  title: string;
  deck: ChatWorkspaceDeck;
  inputRuntime: ChatWorkspaceInputRuntime;
  showMainConversation: boolean;
  selectedTeamTitle?: string;
  mainHasAttention: boolean;
  onShowMain: () => void;
  onOpenPendingDecision: () => void;
}

export function ChatWorkspaceHeader({
  view,
  title,
  deck,
  inputRuntime,
  showMainConversation,
  selectedTeamTitle,
  mainHasAttention,
  onShowMain,
  onOpenPendingDecision,
}: ChatWorkspaceHeaderProps) {
  return (
    <div
      className={`panel-header canvas-header${view.phase === "welcome" ? " center-focal-header" : ""}`}
    >
      <div className="canvas-header-left">
        {view.phase === "welcome" ? (
          <div className="chat-session-title" title={title}>
            <span>{title}</span>
          </div>
        ) : (
          <nav className="chat-session-breadcrumb" aria-label={copy.taskFocusAria}>
            <button
              type="button"
              className={`chat-session-crumb${showMainConversation ? " is-current" : ""}`}
              onClick={onShowMain}
              title={title}
              aria-current={showMainConversation ? "page" : undefined}
            >
              <span>{title}</span>
              {mainHasAttention && (
                <i className="chat-session-attention-dot" aria-label={copy.mainTaskAttentionAria} />
              )}
            </button>
            {!showMainConversation && (
              <ChevronRightIcon
                size={13}
                className="chat-session-crumb-separator"
                aria-hidden="true"
              />
            )}
            {!showMainConversation && selectedTeamTitle && (
              <span className="chat-session-crumb is-current" aria-current="page">
                {selectedTeamTitle}
              </span>
            )}
          </nav>
        )}
      </div>

      <div className="canvas-header-right">
        {view.phase !== "welcome" && inputRuntime.pendingToolApproval && (
          <button
            type="button"
            className="team-decision-alert"
            onClick={onOpenPendingDecision}
            aria-label={copy.approvalAria(inputRuntime.pendingToolApproval.reason)}
            title={copy.approvalJumpTitle}
          >
            <span className="team-decision-alert-icon" aria-hidden="true">
              !
            </span>
            <span>{copy.approvalRequired}</span>
            <b>1</b>
          </button>
        )}
        {view.phase !== "welcome" && !deck.isMirrorOpen && (
          <button
            className="action-icon-btn focus-toggle-btn"
            onClick={deck.onToggleMirror}
            aria-label={copy.openPreview}
            title={copy.openPreview}
          >
            <OpenPreviewIcon size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
