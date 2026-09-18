import { type ReactNode, useEffect, useMemo, useState } from "react";
import { InteractionCardHost } from "../cards/hosts/InteractionCardHost";
import { ChatWorkspaceInput } from "./ChatWorkspaceInput";
import { ChatWorkspaceWelcome } from "./ChatWorkspaceWelcome";
import { CHAT_WORKSPACE_COPY_ZH_CN as copy, getChatPromptTemplates } from "./chat-workspace-copy";
import type {
  ChatWorkspaceActions,
  ChatWorkspaceDeck,
  ChatWorkspaceInputRuntime,
  ChatWorkspaceRun,
  ChatWorkspaceViewState,
  ChatWorkspaceComposer as ComposerState,
} from "./chat-workspace-types";

interface ChatWorkspaceComposerProps {
  view: ChatWorkspaceViewState;
  composer: ComposerState;
  run: ChatWorkspaceRun;
  deck: ChatWorkspaceDeck;
  actions: ChatWorkspaceActions;
  inputRuntime: ChatWorkspaceInputRuntime;
  viewingTeamSession: boolean;
}

export function ChatWorkspaceComposer({
  view,
  composer,
  run,
  deck,
  actions,
  inputRuntime,
  viewingTeamSession,
}: ChatWorkspaceComposerProps): ReactNode {
  const isWelcome = view.phase === "welcome";
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const promptTemplates = useMemo(
    () => getChatPromptTemplates(deck.presentation, deck.selectedSlideId),
    [deck.presentation, deck.selectedSlideId],
  );

  useEffect(() => {
    setShowSlashMenu(composer.request.startsWith("/"));
  }, [composer.request]);

  const selectTemplate = (command: string) => {
    composer.onChangeRequest(command);
    setShowSlashMenu(false);
  };

  return (
    <div
      className={
        isWelcome ? "center-focal-content-area" : "right-panel-footer chat-workspace-footer-unified"
      }
    >
      <div
        className={
          isWelcome ? "center-focal-composer" : "chat-conversation-shell chat-conversation-footer"
        }
      >
        {!isWelcome &&
          showSlashMenu &&
          !run.busy &&
          !view.inputDisabled &&
          !inputRuntime.pendingToolApproval && (
            <div className="slash-menu-popup" role="listbox" aria-label={copy.promptTemplateAria}>
              <div className="slash-menu-header">{copy.promptTemplateHeader}</div>
              {promptTemplates.map((template) => (
                <button
                  type="button"
                  key={template.command}
                  className="slash-menu-item"
                  onClick={() => selectTemplate(template.command)}
                >
                  <span className="cmd-text">{template.command}</span>
                  <span className="cmd-desc">{template.description}</span>
                </button>
              ))}
            </div>
          )}

        <div>
          {!isWelcome && (
            <InteractionCardHost
              host="composer-before-input"
              busy={run.busy}
              onResolveQuestion={actions.onResolveQuestion}
            />
          )}
          {!isWelcome && viewingTeamSession && !inputRuntime.pendingToolApproval && (
            <div className="team-focus-composer-note">{copy.teammateComposerNote}</div>
          )}
          <ChatWorkspaceInput
            view={view}
            composer={composer}
            run={run}
            actions={actions}
            runtime={inputRuntime}
          />
        </div>
        <ChatWorkspaceWelcome view={view} composer={composer} busy={run.busy} />
      </div>
    </div>
  );
}
