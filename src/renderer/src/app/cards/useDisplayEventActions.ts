import { mergeResponseText } from "@shared/agent-activity";
import { formatPublicErrorMessage } from "@shared/agent-activity-display";
import type { AgentQuestionResolved } from "@shared/agent-question";
import { formatTerminalAgentRunContent } from "@shared/agent-result-copy";
import type { DisplayEvent } from "@shared/card-display-protocol";
import { ingestDisplayEvent, setDisplayCardStatus } from "@shared/cards/display-card-managers";
import { type Dispatch, type SetStateAction, useCallback } from "react";
import { useProjectStore } from "../../components/project-store";
import type { AgentActivityStreamController } from "../agent/useAgentActivityStream";
import type { AgentRunController } from "../agent/useAgentRunController";
import type { ChatMessage } from "../chatMessageRuntime";
import type { PresentationController } from "../presentation/usePresentationController";
import { saveExistingProjectFile } from "../project/projectFileMutations";
import { projectFileRequiresReload } from "../project/projectFilesState";

type QuestionEvent = Extract<DisplayEvent, { kind: "interaction.question-requested" }>;
type CommandProposalEvent = Extract<DisplayEvent, { kind: "review.command-proposal" }>;
type PatchEvent = Extract<DisplayEvent, { kind: "review.patch-ready" }>;
type ArtifactEvent = Extract<DisplayEvent, { kind: "artifact.ready" }>;

interface UseDisplayEventActionsOptions {
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  activeSessionId: string;
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  syncPresentation: PresentationController["syncPresentation"];
  activity: AgentActivityStreamController;
  agentRun: Pick<AgentRunController, "startAgent">;
  notify: (message: string) => void;
}

export interface DisplayEventActions {
  resolveApproval: (event: CommandProposalEvent, approved: boolean) => Promise<void>;
  updateMessageContent: (messageId: string, newContent: string, messages: ChatMessage[]) => void;
  resolveQuestion: (event: QuestionEvent, resolved: AgentQuestionResolved) => void;
  reviseOutline: (event: ArtifactEvent) => void;
  resolvePatch: (event: PatchEvent, accepted: boolean) => Promise<void>;
}

export function useDisplayEventActions({
  busy,
  setBusy,
  activeSessionId,
  setChatMessages,
  syncPresentation,
  activity,
  agentRun,
  notify,
}: UseDisplayEventActionsOptions): DisplayEventActions {
  const hydrateProjectArtifacts = useProjectStore((state) => state.hydrateProjectArtifacts);
  const pptJob = useProjectStore((state) => state.pptJob);
  const { syncActivityTrace } = activity;
  const { startAgent } = agentRun;

  const resolveApproval = useCallback(
    async (event: CommandProposalEvent, approved: boolean) => {
      if (busy || !activeSessionId) return;
      const approvalRequest = event.payload;
      if (!pptJob) {
        notify("演示文稿生命周期状态尚未加载，请稍后重试。");
        return;
      }
      if (
        pptJob.proposalId !== approvalRequest.proposalId ||
        pptJob.status !== "waiting_approval" ||
        pptJob.proposalStatus !== "waiting_approval"
      ) {
        setDisplayCardStatus(event.eventId, "resolved");
        notify("该 Proposal 已失效或不再等待审批，请基于当前演示重新生成。");
        return;
      }
      const messageId = event.scope.anchorMessageId;
      setBusy(true);
      syncActivityTrace([
        {
          id: crypto.randomUUID(),
          kind: "step",
          text: approved ? "正在应用排版变更方案到工作台..." : "正在撤销已草拟的排版方案...",
          status: "running",
        },
        {
          id: crypto.randomUUID(),
          kind: "step",
          text: "同步客户端最新数据状态...",
          status: "typing",
        },
      ]);

      try {
        const result = await window.desktopApi.resumeAgentRun(
          activeSessionId,
          approvalRequest.proposalId,
          approved,
        );
        for (const displayEvent of result.displayEvents ?? []) {
          ingestDisplayEvent({
            ...displayEvent,
            scope: {
              ...displayEvent.scope,
              ...(messageId ? { anchorMessageId: messageId } : {}),
            },
          });
        }

        if (result.status === "completed" || result.status === "rejected") {
          const affectedSlideId = approvalRequest.diff?.affectedSlideIds?.[0];
          await syncPresentation({
            preferredSlideId: approved ? affectedSlideId : undefined,
            selectLastSlide: approved && !affectedSlideId,
            openMirror: approved,
            highlightSlide: approved,
          });
          await hydrateProjectArtifacts(activeSessionId);
          if (messageId) {
            setChatMessages((current) =>
              current.map((message) => {
                const projected =
                  message.id === messageId
                    ? mergeResponseText(
                        message.activityTrace ?? [],
                        message.content,
                        formatTerminalAgentRunContent(result),
                      )
                    : undefined;
                return projected
                  ? {
                      ...message,
                      content: projected.content,
                      activityTrace: projected.trace,
                      runStatus: "completed",
                      runError: undefined,
                    }
                  : message;
              }),
            );
          }
          notify(approved ? "变更已应用" : "变更已取消");
        } else {
          setDisplayCardStatus(event.eventId, "active");
          notify(result.status === "failed" ? result.error : "Proposal 尚未完成处理，请重试。");
        }
      } catch (error) {
        setDisplayCardStatus(event.eventId, "active");
        notify(formatPublicErrorMessage(error, "确认变更失败，请重试。"));
      } finally {
        setBusy(false);
        syncActivityTrace([]);
      }
    },
    [
      activeSessionId,
      busy,
      hydrateProjectArtifacts,
      notify,
      pptJob,
      setBusy,
      setChatMessages,
      syncActivityTrace,
      syncPresentation,
    ],
  );

  const updateMessageContent = useCallback(
    (messageId: string, newContent: string, messages: ChatMessage[]) => {
      const targetMessage = messages.find((message) => message.id === messageId);
      if (targetMessage?.role !== "user") return;

      void startAgent(newContent, messageId);
      notify("✏️ 已更新指令并重新生成");
    },
    [notify, startAgent],
  );

  const resolveQuestion = useCallback(
    (event: QuestionEvent, resolved: AgentQuestionResolved) => {
      void startAgent(resolved.value, undefined, {
        userDisplayContent: resolved.label ?? resolved.value,
        questionRunId: event.scope.runId,
      });
    },
    [startAgent],
  );

  const reviseOutline = useCallback(
    (_event: ArtifactEvent) => {
      void startAgent("请根据当前反馈继续修改大纲结构");
    },
    [startAgent],
  );

  const resolvePatch = useCallback(
    async (event: PatchEvent, accepted: boolean) => {
      if (!accepted || !activeSessionId) {
        notify(accepted ? "补丁已确认" : "补丁已拒绝");
        return;
      }
      if (event.payload.contentBefore === undefined || event.payload.contentAfter === undefined) {
        setDisplayCardStatus(event.eventId, "active");
        notify("补丁缺少完整的读取基线，无法安全应用。");
        return;
      }
      try {
        await saveExistingProjectFile(
          window.desktopApi,
          activeSessionId,
          event.payload.targetPath,
          event.payload.contentAfter,
          event.payload.contentBefore,
        );
        await hydrateProjectArtifacts(activeSessionId);
        notify("补丁已应用");
      } catch (error) {
        setDisplayCardStatus(event.eventId, "active");
        notify(
          projectFileRequiresReload(error)
            ? "补丁基线已变化，当前补丁未应用；请重新读取后生成新补丁。"
            : formatPublicErrorMessage(error, "应用补丁失败，请重试。"),
        );
      }
    },
    [activeSessionId, hydrateProjectArtifacts, notify],
  );

  return {
    resolveApproval,
    updateMessageContent,
    resolveQuestion,
    reviseOutline,
    resolvePatch,
  };
}
