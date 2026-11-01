import type { Presentation } from "@shared/presentation";
import { type Dispatch, type SetStateAction, useCallback } from "react";
import type { AgentRunController } from "./agent/useAgentRunController";
import type { ChatMessage } from "./chatMessageRuntime";
import { tryHandleLocalQueryCommand } from "./localQueryCommand";

interface UseUserQuerySubmissionOptions {
  request: string;
  busy: boolean;
  presentation?: Presentation;
  activeSessionId: string;
  setRequest: Dispatch<SetStateAction<string>>;
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  openDeckPreview: () => void;
  notify: (message: string) => void;
  startAgent: AgentRunController["startAgent"];
}

/**
 * 用户主动提交 query 的前端能力边界：先消费纯前端命令，其余输入才交给 Agent。
 * 重试、编辑重发和后台回合不经过这里，因此不会被自然语言 UI 命令误拦截。
 */
export function useUserQuerySubmission({
  request,
  busy,
  presentation,
  activeSessionId,
  setRequest,
  setChatMessages,
  openDeckPreview,
  notify,
  startAgent,
}: UseUserQuerySubmissionOptions): () => void {
  return useCallback(() => {
    if (!request.trim() || busy) return;

    const handledLocally = tryHandleLocalQueryCommand({
      prompt: request,
      presentation,
      sessionId: activeSessionId,
      appendChatMessage: (message) => {
        setChatMessages((current) => [...current, message]);
      },
      clearRequest: () => setRequest(""),
      openDeckPreview,
      notify,
    });
    if (handledLocally) return;

    void startAgent();
  }, [
    activeSessionId,
    busy,
    notify,
    openDeckPreview,
    presentation,
    request,
    setChatMessages,
    setRequest,
    startAgent,
  ]);
}
