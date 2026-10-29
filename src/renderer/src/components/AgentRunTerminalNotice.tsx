import type { SessionChatMessage } from "@shared/session";
import type React from "react";
import { Button } from "./Button";

interface AgentRunTerminalNoticeProps {
  status: SessionChatMessage["runStatus"];
  error?: string;
  onRetry?: () => void;
}

export const AgentRunTerminalNotice: React.FC<AgentRunTerminalNoticeProps> = ({
  status,
  error,
  onRetry,
}) => {
  if (status !== "interrupted" && status !== "failed") return null;

  const failed = status === "failed";
  return (
    <div className={`agent-run-terminal-notice agent-run-terminal-notice--${status}`} role="status">
      <span className="agent-run-terminal-notice-copy">
        <strong>{failed ? "本次处理未完成" : "会话已中断"}</strong>
        {failed && error && <small>{error}</small>}
      </span>
      {onRetry && (
        <Button size="sm" variant="quiet" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
};
