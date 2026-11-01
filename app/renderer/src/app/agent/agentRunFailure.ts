import { type AgentActivityItem, markTraceComplete } from "@shared/agent-activity";
import { formatPublicErrorMessage } from "@shared/agent-activity-display";
import type { Dispatch, SetStateAction } from "react";
import type { ChatMessage } from "../chatMessageRuntime";

interface HandleAgentRunFailureOptions {
  error: unknown;
  isSidechain: boolean;
  runMessageId: string | undefined;
  activeTrace: AgentActivityItem[];
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  notify: (message: string) => void;
}

export function handleAgentRunFailure({
  error,
  isSidechain,
  runMessageId,
  activeTrace,
  setChatMessages,
  notify,
}: HandleAgentRunFailureOptions): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const candidate =
    error && typeof error === "object" ? (error as { name?: unknown; code?: unknown }) : undefined;
  const interrupted = candidate?.name === "AbortError" || candidate?.code === "ABORT_ERR";
  if (interrupted) {
    const interruptedTrace = markTraceComplete(activeTrace, "denied");
    if (runMessageId) {
      setChatMessages((current) =>
        current.map((message) =>
          message.id === runMessageId
            ? {
                ...message,
                runStatus: "interrupted",
                runError: undefined,
                activityTrace:
                  interruptedTrace.length > 0 ? interruptedTrace : message.activityTrace,
              }
            : message,
        ),
      );
    } else if (!isSidechain) {
      setChatMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          runStatus: "interrupted",
          activityTrace: interruptedTrace.length > 0 ? interruptedTrace : undefined,
        },
      ]);
    }
    notify("会话已中断");
    return;
  }

  console.error("Agent run failed:", errorMessage);
  const failedTrace = markTraceComplete(activeTrace, "failed");
  const publicError = formatPublicErrorMessage(errorMessage, "处理请求时遇到问题，请稍后重试。");
  if (runMessageId) {
    setChatMessages((current) =>
      current.map((message) =>
        message.id === runMessageId
          ? {
              ...message,
              runStatus: "failed",
              runError: publicError,
              activityTrace: failedTrace.length > 0 ? failedTrace : message.activityTrace,
            }
          : message,
      ),
    );
    return;
  }
  if (!isSidechain) {
    setChatMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        runStatus: "failed",
        runError: publicError,
        activityTrace: failedTrace.length > 0 ? failedTrace : undefined,
      },
    ]);
    return;
  }
  console.error("Sidechain agent run failed:", errorMessage);
}
