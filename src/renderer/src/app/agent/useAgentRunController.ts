import { appendStep } from "@shared/agent-activity";
import { formatPublicErrorMessage } from "@shared/agent-activity-display";
import {
  type AgentRunContext,
  coordinateAgentRun,
  createAgentRunLock,
} from "@shared/agent-run-lifecycle";
import {
  pruneDisplayCardsForMessages,
  setDisplayCardStatus,
} from "@shared/cards/display-card-managers";
import { type Dispatch, type SetStateAction, useCallback, useRef, useState } from "react";
import { type ChatMessage, toSessionChatMessages } from "../chatMessageRuntime";
import type { PresentationController } from "../presentation/usePresentationController";
import type { SessionController } from "../session/useSessionController";
import { useInboxPoller } from "../useInboxPoller";
import type { SettingsController } from "../useSettingsController";
import { executeAgentRun } from "./agentRunExecution";
import { handleAgentRunFailure } from "./agentRunFailure";
import { buildAgentRunRequest, prepareAgentRunMessages } from "./agentRunPreparation";
import { prepareAgentContext } from "./agentSessionPreparation";
import type { AgentActivityStreamController } from "./useAgentActivityStream";
import { type ApplyAgentResult, useAgentResultHandler } from "./useAgentResultHandler";

interface StartAgentOptions {
  userDisplayContent?: string | false;
  sidechain?: boolean;
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
  settings: Pick<
    SettingsController,
    | "agentStepLimits"
    | "agentGatewayPreferences"
    | "enabledModels"
    | "selectedModel"
    | "executionStrategy"
  >;
  activity: AgentActivityStreamController;
  notify: (message: string) => void;
}

export interface AgentRunController {
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
  const {
    agentStepLimits,
    agentGatewayPreferences,
    enabledModels,
    selectedModel,
    executionStrategy,
  } = settings;
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
   * 调用方应确保输入确实需要 Agent 处理；会话准备、消息构造、执行分流分别由
   * 独立模块负责。最终 Presentation 由 applyAgentResult 从主进程回读。
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
      const streamMessageId = crypto.randomUUID();
      const streamMessage: ChatMessage = {
        id: streamMessageId,
        role: "assistant",
        content: "",
        runId,
        runStatus: "running",
        runStartedAt: Date.now(),
      };
      const preparedMessages = prepareAgentRunMessages({
        sourceMessages,
        activeRequest,
        userDisplayContent,
        isSidechain,
        editedMessageId: isEditOfMsgId,
        streamMessage,
        createMessageId: () => crypto.randomUUID(),
      });
      // The assistant message groups one semantic turn. Its ordered run blocks are
      // appended in event order; the transient activity indicator stays at list tail.
      beginRunActivity(runId, streamMessageId, isSidechain);
      setActiveRunId(runId);
      setChatMessages(preparedMessages.runMessages);
      setBusy(true);
      await coordinateAgentRun({
        prepareContext: async (): Promise<AgentRunContext | undefined> => {
          const preparedContext = await prepareAgentContext({
            activeSessionId,
            prompt: activeRequest,
            localStoragePath,
            applySessionState: (state) => {
              applySessionState(state, { preserveDraft: true });
              // Session hydration and the provisional run anchor belong to one
              // render transaction, so creating a draft session cannot remount
              // the loader between standalone and message-local trees.
              setChatMessages(preparedMessages.runMessages);
            },
            notify,
          });
          if (!preparedContext) {
            throw new Error("Agent run context could not be prepared.");
          }
          return {
            ...preparedContext,
            runId,
            sidechain: isSidechain,
          };
        },
        execute: async (context) => {
          const agentRequest = buildAgentRunRequest({
            prompt: activeRequest,
            sessionId: context.sessionId,
            currentSlideId: selectedSlideId || undefined,
          });

          console.info("Starting unified Agent run", {
            sessionId: agentRequest.sessionId,
            editorContext: agentRequest.editorContext,
          });

          if (preparedMessages.retainedMessageIds) {
            pruneDisplayCardsForMessages(preparedMessages.retainedMessageIds);
          }
          setChatMessages(preparedMessages.runMessages);

          if (!context.sidechain) {
            await window.desktopApi.saveSessionMessages(
              context.sessionId,
              toSessionChatMessages(preparedMessages.runMessages),
            );
          }
          if (!customRequest) {
            setRequest((current) => (current === activeRequest ? "" : current));
          }
          return executeAgentRun({
            request: agentRequest,
            sourceMessages,
            forkedMessages: preparedMessages.forkedMessages,
            gatewayPreferences: agentGatewayPreferences,
            enabledModels,
            selectedModel,
            stepLimits: agentStepLimits,
            executionStrategy,
            runId: context.runId,
          });
        },
        finalize: async (context, result) => {
          // Wait for the stream (including final response text) before applying
          // the result; cleanup then clears busy so UI collapses after summary lands.
          await waitForRunStreamCompletion(context.runId);
          await applyAgentResult(result, activeRunTraceRef.current, context.runId);
        },
        handleFailure: (error, context) => {
          handleAgentRunFailure({
            error,
            isSidechain: context?.sidechain ?? isSidechain,
            runMessageId: streamMessageIdsRef.current.get(runId),
            activeTrace: activeRunTraceRef.current,
            setChatMessages,
            notify,
          });
        },
        cleanup: () => {
          finishRunActivity(runId);
          setActiveRunId((current) => (current === runId ? null : current));
          setIsCancellingRun(false);
          if (runLock.release(runId)) setBusy(false);
        },
      });
    },
    [
      activeRunTraceRef,
      activeSessionId,
      agentGatewayPreferences,
      agentStepLimits,
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
      streamMessageIdsRef,
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
