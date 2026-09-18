import { appendStep } from "@shared/agent-activity";
import { formatPublicErrorMessage } from "@shared/agent-activity-display";
import { createAgentRunLock } from "@shared/agent-run-lifecycle";
import { setDisplayCardStatus } from "@shared/cards/display-card-managers";
import { type Dispatch, type SetStateAction, useCallback, useRef, useState } from "react";
import type { ChatMessage } from "../chatMessageRuntime";
import type { PresentationController } from "../presentation/usePresentationController";
import type { SessionController } from "../session/useSessionController";
import { useInboxPoller } from "../useInboxPoller";
import type { SettingsController } from "../useSettingsController";
import { executeAgentRun } from "./agentRunExecution";
import { handleAgentRunFailure } from "./agentRunFailure";
import { prepareAgentRunMessages } from "./agentRunPreparation";
import type { AgentActivityStreamController } from "./useAgentActivityStream";
import { type ApplyAgentResult, useAgentResultHandler } from "./useAgentResultHandler";

interface StartAgentOptions {
  userDisplayContent?: string | false;
  sidechain?: boolean;
  questionRunId?: string;
}

interface UseAgentRunControllerOptions {
  request: string;
  setRequest: Dispatch<SetStateAction<string>>;
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  activeSessionId: string;
  sessionLoaded: boolean;
  localStoragePath: string;
  selectedSlideId?: string;
  chatMessages: ChatMessage[];
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  applySessionState: SessionController["applySessionState"];
  syncPresentation: PresentationController["syncPresentation"];
  settings: Pick<SettingsController, "enabledModels" | "selectedModel" | "executionStrategy">;
  activity: AgentActivityStreamController;
  notify: (message: string) => void;
}

export interface AgentRunController {
  submissionPhase: "idle" | "submitting" | "preparing" | "running";
  activeRunId: string | null;
  streamingMessageId: string | null;
  isCancellingRun: boolean;
  startAgent: (
    customRequest?: string,
    isEditOfMsgId?: string,
    options?: StartAgentOptions,
  ) => Promise<void>;
  applyAgentResult: ApplyAgentResult;
  cancelRun: () => Promise<void>;
  retryMessage: (messageId: string) => void;
  suggestPrompt: (prompt: string) => void;
  resolveToolApproval: (approvalId: string, approved: boolean) => Promise<void>;
}

export function useAgentRunController({
  request,
  setRequest,
  busy,
  setBusy,
  activeSessionId,
  sessionLoaded,
  localStoragePath,
  selectedSlideId,
  chatMessages,
  setChatMessages,
  applySessionState,
  syncPresentation,
  settings,
  activity,
  notify,
}: UseAgentRunControllerOptions): AgentRunController {
  const [submissionPhase, setSubmissionPhase] =
    useState<AgentRunController["submissionPhase"]>("idle");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isCancellingRun, setIsCancellingRun] = useState(false);
  const {
    activeRunIdRef,
    activeRunTraceRef,
    streamMessageIdsRef,
    syncActivityTrace,
    beginRunActivity,
    finishRunActivity,
    waitForRunStreamCompletion,
  } = activity;
  const { enabledModels, selectedModel, executionStrategy } = settings;
  const runLockRef = useRef(createAgentRunLock());

  const applyAgentResult = useAgentResultHandler({
    activeSessionId,
    setChatMessages,
    syncPresentation,
    activity,
    notify,
  });

  /**
   * 用户 query 的 Renderer 用例入口，仅负责编排各阶段和维护一次运行的生命周期。
   * Renderer 只提交用户意图并展示乐观消息；Main 受理后返回权威会话和运行身份。
   * 最终 Presentation 由 applyAgentResult 从主进程回读。
   */
  const startAgent = useCallback(
    async (customRequest?: string, isEditOfMsgId?: string, options?: StartAgentOptions) => {
      const activeRequest = customRequest || request;
      if (!activeRequest.trim() || busy) return;
      if (
        enabledModels.length === 0 ||
        !selectedModel ||
        !enabledModels.some((model) => model.id === selectedModel.id)
      ) {
        notify("没有可用的已配置模型；请先在设置中保存 API Key");
        return;
      }

      const runId = crypto.randomUUID();
      const runLock = runLockRef.current;
      if (!runLock.acquire(runId)) return;

      const userDisplayContent =
        options?.userDisplayContent === false
          ? null
          : typeof options?.userDisplayContent === "string"
            ? options.userDisplayContent
            : activeRequest;
      const isSidechain = options?.sidechain === true;
      const sourceMessages = chatMessages;
      const userMessageId = crypto.randomUUID();
      const streamMessageId = crypto.randomUUID();
      const streamMessage: ChatMessage = {
        id: streamMessageId,
        role: "assistant",
        content: "",
        runId,
        runStartedAt: Date.now(),
      };
      const preparedMessages = prepareAgentRunMessages({
        sourceMessages,
        activeRequest,
        userDisplayContent,
        isSidechain,
        editedMessageId: isEditOfMsgId,
        streamMessage,
        createMessageId: () => userMessageId,
      });
      // The assistant message groups one semantic turn. Its ordered run blocks are
      // appended in event order; the transient activity indicator stays at list tail.
      beginRunActivity(runId, streamMessageId, isSidechain);
      setActiveRunId(runId);
      setChatMessages(preparedMessages.runMessages);
      setBusy(true);
      setSubmissionPhase("submitting");
      let accepted = false;
      try {
        const result = await executeAgentRun({
          request: {
            requestId: runId,
            userMessageId,
            assistantMessageId: streamMessageId,
            target: activeSessionId
              ? { type: "session", sessionId: activeSessionId }
              : {
                  type: "new-session",
                  ...(localStoragePath ? { rootPath: localStoragePath } : {}),
                },
            prompt: activeRequest,
            modelId: selectedModel.id,
            executionStrategy,
            editorContext: { currentSlideId: selectedSlideId || undefined, selectedElementIds: [] },
            action: isSidechain
              ? { type: "inbox" }
              : isEditOfMsgId
                ? { type: "edit", messageId: isEditOfMsgId }
                : options?.questionRunId
                  ? {
                      type: "answer",
                      questionRunId: options.questionRunId,
                      displayContent: userDisplayContent ?? undefined,
                    }
                  : { type: "message" },
          },
          onAccepted: (event) => {
            accepted = true;
            setSubmissionPhase("preparing");
            applySessionState(event.bootstrap, { preserveDraft: true, syncPresentation: false });
            if (!customRequest) setRequest((current) => (current === activeRequest ? "" : current));
          },
          onRunning: () => setSubmissionPhase("running"),
        });
        await waitForRunStreamCompletion(runId);
        await applyAgentResult(result, activeRunTraceRef.current, runId);
      } catch (error) {
        if (!accepted) {
          setChatMessages(sourceMessages);
          notify(formatPublicErrorMessage(error, "请求未被受理，请重试。"));
        } else {
          handleAgentRunFailure({
            error,
            isSidechain,
            runMessageId: streamMessageId,
            activeTrace: activeRunTraceRef.current,
            setChatMessages,
            notify,
          });
        }
      } finally {
        finishRunActivity(runId);
        setActiveRunId((current) => (current === runId ? null : current));
        setSubmissionPhase("idle");
        setIsCancellingRun(false);
        if (runLock.release(runId)) setBusy(false);
      }
    },
    [
      activeRunTraceRef,
      activeSessionId,
      applyAgentResult,
      applySessionState,
      beginRunActivity,
      busy,
      chatMessages,
      enabledModels,
      finishRunActivity,
      localStoragePath,
      notify,
      request,
      selectedModel,
      selectedSlideId,
      setBusy,
      setChatMessages,
      setRequest,
      waitForRunStreamCompletion,
      executionStrategy,
    ],
  );

  useInboxPoller({
    activeSessionId,
    sessionLoaded,
    busy,
    onInboxTurn: (prompt) =>
      startAgent(prompt, undefined, { userDisplayContent: false, sidechain: true }),
    onError: (error) => {
      console.error("轮询队友收件箱失败:", error);
    },
  });

  const cancelRun = useCallback(async () => {
    if (!activeRunIdRef.current || isCancellingRun) return;

    setIsCancellingRun(true);
    syncActivityTrace(appendStep(activeRunTraceRef.current, "正在中断当前会话…", "running"));

    try {
      let cancelled = await window.desktopApi.cancelAgentRun(activeRunIdRef.current);
      if (!cancelled && activeSessionId) {
        cancelled = await window.desktopApi.cancelAgentSession(activeSessionId);
      }
      if (cancelled) {
        notify("正在中断会话…");
      } else {
        setIsCancellingRun(false);
        syncActivityTrace(
          appendStep(activeRunTraceRef.current, "中断请求未能送达，请稍后重试", "done"),
        );
        notify("当前没有可中断的任务");
      }
    } catch (error) {
      setIsCancellingRun(false);
      notify(formatPublicErrorMessage(error, "中断会话失败，请重试。"));
    }
  }, [
    activeRunIdRef,
    activeRunTraceRef,
    activeSessionId,
    isCancellingRun,
    notify,
    syncActivityTrace,
  ]);

  const retryMessage = useCallback(
    (messageId: string) => {
      const index = chatMessages.findIndex((message) => message.id === messageId);
      if (index === -1) return;
      const priorUserMessage = chatMessages
        .slice(0, index)
        .reverse()
        .find((message) => message.role === "user");
      if (priorUserMessage) void startAgent(priorUserMessage.content);
    },
    [chatMessages, startAgent],
  );

  const suggestPrompt = useCallback(
    (prompt: string) => {
      if (busy) return;
      setRequest(prompt);
    },
    [busy, setRequest],
  );

  const resolveToolApproval = useCallback(
    async (approvalId: string, approved: boolean) => {
      const runId = activeRunIdRef.current;
      if (!runId) return;
      try {
        const resolved = await window.desktopApi.resolveToolApproval(runId, approvalId, approved);
        if (!resolved) {
          setDisplayCardStatus(`tool-approval:${approvalId}`, "dismissed");
          notify("这项工具授权已失效");
        }
      } catch (error) {
        notify(formatPublicErrorMessage(error, "工具授权提交失败，请重试。"));
      }
    },
    [activeRunIdRef, notify],
  );

  const streamingMessageId =
    busy && activeRunId ? (streamMessageIdsRef.current.get(activeRunId) ?? null) : null;

  return {
    submissionPhase,
    activeRunId,
    streamingMessageId,
    isCancellingRun,
    startAgent,
    applyAgentResult,
    cancelRun,
    retryMessage,
    suggestPrompt,
    resolveToolApproval,
  };
}
