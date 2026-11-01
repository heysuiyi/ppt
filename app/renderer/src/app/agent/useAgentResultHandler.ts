import {
  formatTerminalAgentRunContent,
  mergeWaitingUserRunContent,
} from "@app/shared/agent-result-copy";
import type { AgentRunResult } from "@app/shared/ipc";
import {
  type AgentActivityItem,
  markTraceComplete,
  mergeActivityTraces,
  mergeResponseText,
} from "@shared/agent-activity";
import {
  ingestDisplayEvent,
  setDisplayCardStatus,
  usePermissionCardManager,
} from "@shared/cards/display-card-managers";
import { type Dispatch, type SetStateAction, useCallback } from "react";
import { useProjectStore } from "../../components/project-store";
import type { ChatMessage } from "../chatMessageRuntime";
import type { PresentationController } from "../presentation/usePresentationController";
import type { AgentActivityStreamController } from "./useAgentActivityStream";

interface UseAgentResultHandlerOptions {
  activeSessionId: string;
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  syncPresentation: PresentationController["syncPresentation"];
  activity: Pick<
    AgentActivityStreamController,
    "activeRunTraceRef" | "sidechainRunRef" | "streamMessageIdsRef"
  >;
  notify: (message: string) => void;
}

export type ApplyAgentResult = (
  result: AgentRunResult,
  trace: AgentActivityItem[],
  runId?: string,
  messageIdOverride?: string,
) => Promise<void>;

/**
 * 消费 Main 返回的 AgentRunResult：更新聊天/审批展示，并在命令已应用后回读权威 Presentation。
 * Renderer 不直接采用模型生成的数据修改 PPT，避免绕过 Main 中的 CommitGate 和 CommandBus。
 */
export function useAgentResultHandler({
  activeSessionId,
  setChatMessages,
  syncPresentation,
  activity,
  notify,
}: UseAgentResultHandlerOptions): ApplyAgentResult {
  const hydrateProjectArtifacts = useProjectStore((state) => state.hydrateProjectArtifacts);
  const { activeRunTraceRef, sidechainRunRef, streamMessageIdsRef } = activity;

  return useCallback(
    async (
      result: AgentRunResult,
      trace: AgentActivityItem[],
      runId?: string,
      messageIdOverride?: string,
    ) => {
      const isSidechainRun = Boolean(runId && sidechainRunRef.current === runId);
      const messageId =
        messageIdOverride ?? (runId ? streamMessageIdsRef.current.get(runId) : undefined);
      const hostMessageId = messageId ?? crypto.randomUUID();
      const interrupted = result.status === "interrupted";
      const failed = result.status === "failed";
      for (const event of result.displayEvents ?? []) {
        try {
          ingestDisplayEvent({
            ...event,
            scope: { ...event.scope, anchorMessageId: hostMessageId },
          });
        } catch (error) {
          console.error("Invalid result display event received:", error);
        }
      }
      const finalizeTrace = (existing?: AgentActivityItem[]) =>
        markTraceComplete(
          mergeActivityTraces(existing, trace, activeRunTraceRef.current) ?? [],
          interrupted ? "denied" : "failed",
        );
      const resolvedTrace = (existing?: AgentActivityItem[]) => {
        const merged = finalizeTrace(existing);
        return merged.length > 0 ? merged : undefined;
      };
      const projectResponse = (
        currentContent: string,
        existing: AgentActivityItem[] | undefined,
        nextText?: string,
      ) => {
        const baseTrace = resolvedTrace(existing) ?? [];
        const projected =
          nextText === undefined
            ? { content: currentContent, trace: baseTrace }
            : mergeResponseText(baseTrace, currentContent, nextText);
        return {
          content: projected.content,
          activityTrace: projected.trace.length > 0 ? projected.trace : undefined,
        };
      };

      if (interrupted || failed) {
        if (runId) {
          for (const card of usePermissionCardManager.getState().cards) {
            if (card.status === "active" && card.event.scope.runId === runId) {
              setDisplayCardStatus(card.event.eventId, "dismissed");
            }
          }
        }
        const terminalPatch = {
          activityTrace: resolvedTrace(),
          runStatus: interrupted ? ("interrupted" as const) : ("failed" as const),
          runError: failed ? result.error : undefined,
          threadId: result.threadId,
        };
        if (messageId) {
          setChatMessages((current) =>
            current.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    ...terminalPatch,
                    ...projectResponse(message.content, message.activityTrace),
                  }
                : message,
            ),
          );
        } else if (!isSidechainRun) {
          setChatMessages((current) => [
            ...current,
            {
              id: hostMessageId,
              role: "assistant",
              content: "",
              runId,
              ...terminalPatch,
            },
          ]);
        }
        if (interrupted) notify("会话已中断");
        return;
      }

      if (result.status === "chat" || result.status === "waiting-user") {
        const waitingForAnswer = result.status === "waiting-user";
        if (isSidechainRun && !waitingForAnswer) {
          if (messageId) {
            setChatMessages((current) =>
              current.map((message) =>
                message.id === messageId
                  ? {
                      ...message,
                      activityTrace: resolvedTrace(message.activityTrace),
                      runStatus: "completed",
                      runError: undefined,
                      threadId: result.threadId ?? message.threadId,
                    }
                  : message,
              ),
            );
          }
          return;
        }
        if (messageId) {
          setChatMessages((current) =>
            current.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    ...projectResponse(
                      message.content,
                      message.activityTrace,
                      waitingForAnswer
                        ? mergeWaitingUserRunContent(message.content, result.message)
                        : result.message,
                    ),
                    runStatus: waitingForAnswer ? ("waiting" as const) : ("completed" as const),
                    runError: undefined,
                    threadId: result.threadId,
                  }
                : message,
            ),
          );
        } else {
          const projected = projectResponse("", undefined, result.message);
          setChatMessages((current) => [
            ...current,
            {
              id: hostMessageId,
              role: "assistant",
              ...projected,
              runId,
              runStatus: waitingForAnswer ? "waiting" : "completed",
              threadId: result.threadId,
            },
          ]);
        }
        return;
      }

      if (result.status === "approval-required") {
        const content =
          isSidechainRun && messageId
            ? "后台任务已提出排版更新方案，请在下方审核后应用。"
            : "已提出排版更新方案，请在下方审核后应用。";
        if (messageId) {
          setChatMessages((current) =>
            current.map((message) =>
              message.id === messageId
                ? {
                    ...message,
                    ...projectResponse(message.content, message.activityTrace, content),
                    runStatus: "completed",
                    runError: undefined,
                    threadId: result.approval.threadId,
                  }
                : message,
            ),
          );
        } else {
          const projected = projectResponse("", undefined, content);
          setChatMessages((current) => [
            ...current,
            {
              id: hostMessageId,
              role: "assistant",
              ...projected,
              runId,
              runStatus: "completed",
              threadId: result.approval.threadId,
            },
          ]);
        }
        notify("AI 已提出排版变更方案，请进行审核");
        return;
      }

      if (result.status === "completed" || result.status === "rejected") {
        await syncPresentation({
          selectLastSlide: result.status === "completed",
          openMirror: result.status === "completed",
          highlightSlide: result.status === "completed",
        });
        if (result.status === "completed") {
          await hydrateProjectArtifacts(activeSessionId || undefined);
        }
      }

      const finalContent = formatTerminalAgentRunContent(result);

      if (messageId) {
        setChatMessages((current) =>
          current.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  ...projectResponse(message.content, message.activityTrace, finalContent),
                  runStatus: "completed",
                  runError: undefined,
                }
              : message,
          ),
        );
      } else {
        const projected = projectResponse("", undefined, finalContent);
        setChatMessages((current) => [
          ...current,
          {
            id: hostMessageId,
            role: "assistant",
            ...projected,
            runId,
            runStatus: "completed",
          },
        ]);
      }
      notify(result.status === "rejected" ? "变更已取消" : "演示文稿已成功更新");
    },
    [
      activeRunTraceRef,
      activeSessionId,
      hydrateProjectArtifacts,
      notify,
      setChatMessages,
      sidechainRunRef,
      streamMessageIdsRef,
      syncPresentation,
    ],
  );
}
