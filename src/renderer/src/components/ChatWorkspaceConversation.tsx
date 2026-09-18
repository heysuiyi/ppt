import type { ComponentProps } from "react";
import { ChatMessageStream } from "./ChatMessageStream";
import type { ChatWorkspaceViewState } from "./chat-workspace-types";
import { useChatScroll } from "./useChatScroll";

interface ChatWorkspaceConversationProps extends ComponentProps<typeof ChatMessageStream> {
  view: ChatWorkspaceViewState;
}

export function ChatWorkspaceConversation({
  view,
  ...streamProps
}: ChatWorkspaceConversationProps) {
  const chatScroll = useChatScroll();
  if (view.phase === "welcome") return null;
  return (
    <div className="chat-scroll-viewport" ref={chatScroll.viewportRef}>
      <div className="chat-conversation-shell">
        <div className="chat-stream" ref={chatScroll.streamRef}>
          <ChatMessageStream key={streamProps.session.id} {...streamProps} />
          <div />
        </div>
      </div>
    </div>
  );
}
