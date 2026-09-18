import { CHAT_WORKSPACE_COPY_ZH_CN as copy } from "./chat-workspace-copy";
import type { ChatWorkspaceComposer, ChatWorkspaceViewState } from "./chat-workspace-types";

interface ChatWorkspaceWelcomeProps {
  view: ChatWorkspaceViewState;
  composer: ChatWorkspaceComposer;
  busy: boolean;
}

export function ChatWorkspaceWelcome({ view, composer, busy }: ChatWorkspaceWelcomeProps) {
  if (view.phase !== "welcome") return null;
  return (
    <div className="center-suggestions">
      {copy.suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          className="suggestion-chip"
          disabled={busy || view.inputDisabled}
          title="填入输入框，确认后发送"
          onClick={() => composer.onProposePrompt(suggestion)}
        >
          {suggestion}
        </button>
      ))}
    </div>
  );
}
