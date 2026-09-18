import {
  type AgentActivityItem,
  appendReasoningChunk,
  appendResponseChunk,
  appendStep,
  appendToolApprovalWaiting,
  appendToolStart,
  applyTeammateProgressEvent,
  commitResponseAttempt,
  finishTool,
  removeResponseAttempt,
  resolveToolApprovalItem,
  sealAllReasoning,
  updateStepText,
  upsertTaskListTrace,
} from "@shared/agent-activity";
import { formatAgentProgressMessage } from "@shared/agent-activity-display";
import type { AgentRunPhase } from "@shared/agent-run-presentation";
import { ingestDisplayEvent, setDisplayCardStatus } from "@shared/cards/display-card-managers";
import type { AgentStreamEvent } from "@shared/ipc";
import { isTeammateProgressEvent } from "@shared/teammate-progress";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ChatMessage } from "../chatMessageRuntime";

interface UseAgentActivityStreamOptions {
  activeSessionIdRef: MutableRefObject<string>;
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}

export interface AgentActivityStreamController {
  activityTrace: AgentActivityItem[];
  agentRunPhase: AgentRunPhase;
  activeRunIdRef: MutableRefObject<string | null>;
  activeRunTraceRef: MutableRefObject<AgentActivityItem[]>;
  streamMessageIdsRef: MutableRefObject<Map<string, string>>;
  sidechainRunRef: MutableRefObject<string | null>;
  syncActivityTrace: (next: AgentActivityItem[]) => void;
  beginRunActivity: (runId: string, messageId: string, sidechain: boolean) => void;
  finishRunActivity: (runId: string) => void;
  waitForRunStreamCompletion: (runId: string) => Promise<void>;
}

export function useAgentActivityStream({
  activeSessionIdRef,
  setChatMessages,
}: UseAgentActivityStreamOptions): AgentActivityStreamController {
  const [activityTrace, setActivityTrace] = useState<AgentActivityItem[]>([]);
  const [agentRunPhase, setAgentRunPhase] = useState<AgentRunPhase>("idle");
  const activeRunIdRef = useRef<string | null>(null);
  const activeRunTraceRef = useRef<AgentActivityItem[]>([]);
  const activeRunContentRef = useRef("");
  const requestStatusStepIdRef = useRef<string | null>(null);
  const streamMessageIdsRef = useRef(new Map<string, string>());
  const sidechainRunRef = useRef<string | null>(null);
  const completedStreamRunIdsRef = useRef(new Set<string>());
  const streamCompletionWaitersRef = useRef(new Map<string, () => void>());
  const pendingReasoningRef = useRef<{ modelStep: number; text: string } | null>(null);
  const reasoningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const syncActivityTrace = useCallback(
    (next: AgentActivityItem[]) => {
      activeRunTraceRef.current = next;
      setActivityTrace(next);

      const runId = activeRunIdRef.current;
      if (!runId || next.length === 0) return;
      const messageId = streamMessageIdsRef.current.get(runId);
      if (!messageId) return;

      setChatMessages((current) => {
        if (!current.some((message) => message.id === messageId)) return current;
        return current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                activityTrace: next.length > 0 ? next : undefined,
              }
            : message,
        );
      });
    },
    [setChatMessages],
  );

  const syncRunTranscript = useCallback(
    (nextTrace: AgentActivityItem[], nextContent: string) => {
      activeRunTraceRef.current = nextTrace;
      activeRunContentRef.current = nextContent;
      setActivityTrace(nextTrace);

      const runId = activeRunIdRef.current;
      if (!runId) return;
      const messageId = streamMessageIdsRef.current.get(runId);
      if (!messageId) return;
      setChatMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                content: nextContent,
                activityTrace: nextTrace.length > 0 ? nextTrace : undefined,
              }
            : message,
        ),
      );
    },
    [setChatMessages],
  );

  const flushReasoning = useCallback(() => {
    if (reasoningTimerRef.current !== null) clearTimeout(reasoningTimerRef.current);
    reasoningTimerRef.current = null;
    const pending = pendingReasoningRef.current;
    pendingReasoningRef.current = null;
    if (pending) {
      syncActivityTrace(
        appendReasoningChunk(activeRunTraceRef.current, pending.text, pending.modelStep),
      );
    }
  }, [syncActivityTrace]);

  useEffect(() => {
    const unsubscribe = window.desktopApi.onAgentStream((event: AgentStreamEvent) => {
      if (event.runId === activeRunIdRef.current && event.type !== "thinking-chunk") {
        flushReasoning();
      }
      if (event.type === "stream-completed") {
        const resolve = streamCompletionWaitersRef.current.get(event.runId);
        if (resolve) {
          streamCompletionWaitersRef.current.delete(event.runId);
          resolve();
        } else {
          completedStreamRunIdsRef.current.add(event.runId);
        }
        return;
      }
      const isCurrentRun = event.runId === activeRunIdRef.current;
      if (event.type === "display-event") {
        if (event.sessionId && event.sessionId !== activeSessionIdRef.current) return;
        try {
          ingestDisplayEvent(event.event);
        } catch (error) {
          console.error("Invalid display event received:", error);
        }
        return;
      }
      if (event.type === "task-list-updated") {
        if (event.sessionId && event.sessionId !== activeSessionIdRef.current) return;
        if (!isCurrentRun) return;
      }

      if (isTeammateProgressEvent(event)) {
        if (event.sessionId && event.sessionId !== activeSessionIdRef.current) return;
        if (isCurrentRun) {
          setAgentRunPhase(event.type === "teammate-thinking-chunk" ? "thinking" : "working");
          syncActivityTrace(applyTeammateProgressEvent(activeRunTraceRef.current, event));
        } else {
          setChatMessages((current) =>
            current.map((message) =>
              message.role === "assistant" && message.runId === event.runId
                ? {
                    ...message,
                    activityTrace: applyTeammateProgressEvent(message.activityTrace ?? [], event),
                  }
                : message,
            ),
          );
        }
        return;
      }
      if (!isCurrentRun) return;

      if (event.type === "request-status") {
        const displayMessage = formatAgentProgressMessage(event.message);
        if (!displayMessage) return;
        setAgentRunPhase("requesting");
        if (!requestStatusStepIdRef.current) {
          const stepId = crypto.randomUUID();
          requestStatusStepIdRef.current = stepId;
          syncActivityTrace([
            ...activeRunTraceRef.current,
            {
              id: stepId,
              kind: "step",
              text: displayMessage,
              status: "running",
            },
          ]);
        } else {
          syncActivityTrace(
            updateStepText(
              activeRunTraceRef.current,
              requestStatusStepIdRef.current,
              displayMessage,
            ),
          );
        }
        return;
      }

      const requestStatusStepId = requestStatusStepIdRef.current;
      if (requestStatusStepId) {
        requestStatusStepIdRef.current = null;
        syncActivityTrace(
          activeRunTraceRef.current.map((item) =>
            item.kind === "step" && item.id === requestStatusStepId
              ? { ...item, status: "done" as const }
              : item,
          ),
        );
      }

      if (event.type === "workflow-progress") {
        setAgentRunPhase("working");
        const displayMessage = formatAgentProgressMessage(event.message);
        if (displayMessage) {
          syncActivityTrace(appendStep(activeRunTraceRef.current, displayMessage, "done"));
        }
        return;
      }

      if (event.type === "stage-started") {
        setAgentRunPhase("requesting");
        return;
      }

      if (event.type === "tool-state") {
        if (event.status === "running") {
          setAgentRunPhase("tool");
          syncActivityTrace(
            appendToolStart(activeRunTraceRef.current, event.toolCallId, event.toolName),
          );
        } else {
          setAgentRunPhase("working");
          syncActivityTrace(
            finishTool(activeRunTraceRef.current, event.toolCallId, event.toolName, event.status),
          );
        }
        return;
      }

      if (event.type === "approval-waiting") {
        setAgentRunPhase("waiting");
        syncActivityTrace(appendStep(activeRunTraceRef.current, "等待用户审批", "done"));
        return;
      }

      if (event.type === "tool-approval-waiting") {
        setAgentRunPhase("waiting");
        syncActivityTrace(
          appendToolApprovalWaiting(activeRunTraceRef.current, {
            approvalId: event.approvalId,
            toolName: event.toolName,
            reason: event.reason,
            detail: event.detail,
          }),
        );
        return;
      }

      if (event.type === "tool-approval-resolved") {
        setAgentRunPhase("working");
        syncActivityTrace(
          resolveToolApprovalItem(activeRunTraceRef.current, event.approvalId, event.status),
        );
        setDisplayCardStatus(
          `tool-approval:${event.approvalId}`,
          event.status === "approved" ? "resolved" : "dismissed",
        );
        return;
      }

      if (event.type === "task-list-updated") {
        setAgentRunPhase("working");
        syncActivityTrace(
          upsertTaskListTrace(activeRunTraceRef.current, {
            tasks: event.tasks,
            goal: event.goal,
          }),
        );
        return;
      }

      if (event.type === "thinking-chunk") {
        const nextModelStep = event.modelStep ?? 0;
        if (pendingReasoningRef.current?.modelStep !== nextModelStep) flushReasoning();
        const existing = activeRunTraceRef.current.find(
          (item) => item.kind === "reasoning" && (item.modelStep ?? 0) === nextModelStep,
        );
        const pending = pendingReasoningRef.current;
        // Bound the live projection, not the canonical model response or its archive.
        const remaining = 8_000 -
          (existing?.kind === "reasoning" ? existing.content.length : 0) -
          (pending?.text.length ?? 0);
        if (remaining <= 0 || !event.chunk) return;
        const text = event.chunk.length > remaining
          ? `${event.chunk.slice(0, remaining)}\n[实时思考展示已达上限；完整响应以模型诊断档案为准。]`
          : event.chunk;
        pendingReasoningRef.current = {
          modelStep: nextModelStep,
          text: (pending?.text ?? "") + text,
        };
        if (reasoningTimerRef.current === null) {
          setAgentRunPhase("thinking");
          reasoningTimerRef.current = setTimeout(flushReasoning, 100);
        }
        return;
      }

      if (event.type === "text-reset") {
        setAgentRunPhase("requesting");
        const reset = removeResponseAttempt(
          sealAllReasoning(activeRunTraceRef.current),
          activeRunContentRef.current,
          event.attemptId,
        );
        syncRunTranscript(reset.trace, reset.content);
        return;
      }

      if (event.type === "text-commit") {
        syncActivityTrace(commitResponseAttempt(activeRunTraceRef.current, event.attemptId));
        return;
      }

      if (event.type === "text-chunk") {
        requestStatusStepIdRef.current = null;

        setAgentRunPhase("responding");
        const contentStart = activeRunContentRef.current.length;
        const nextTrace = appendResponseChunk(
          activeRunTraceRef.current,
          contentStart,
          event.chunk.length,
          event.attemptId,
        );
        syncRunTranscript(nextTrace, activeRunContentRef.current + event.chunk);
      }
    });
    return () => {
      unsubscribe();
      if (reasoningTimerRef.current !== null) clearTimeout(reasoningTimerRef.current);
      reasoningTimerRef.current = null;
      pendingReasoningRef.current = null;
      for (const resolve of streamCompletionWaitersRef.current.values()) resolve();
      streamCompletionWaitersRef.current.clear();
      completedStreamRunIdsRef.current.clear();
    };
  }, [activeSessionIdRef, setChatMessages, syncActivityTrace, syncRunTranscript, flushReasoning]);

  const beginRunActivity = useCallback(
    (runId: string, messageId: string, sidechain: boolean) => {
      flushReasoning();
      syncActivityTrace([]);
      setAgentRunPhase("requesting");
      activeRunIdRef.current = runId;
      activeRunTraceRef.current = [];
      activeRunContentRef.current = "";
      requestStatusStepIdRef.current = null;
      streamMessageIdsRef.current.set(runId, messageId);
      sidechainRunRef.current = sidechain ? runId : null;
    },
    [syncActivityTrace, flushReasoning],
  );

  const finishRunActivity = useCallback(
    (runId: string) => {
      if (activeRunIdRef.current === runId) flushReasoning();
      streamMessageIdsRef.current.delete(runId);
      completedStreamRunIdsRef.current.delete(runId);
      streamCompletionWaitersRef.current.delete(runId);
      if (activeRunIdRef.current !== runId) return;
      if (sidechainRunRef.current === runId) sidechainRunRef.current = null;
      activeRunIdRef.current = null;
      setAgentRunPhase("idle");
      syncActivityTrace([]);
      requestStatusStepIdRef.current = null;
      activeRunTraceRef.current = [];
      activeRunContentRef.current = "";
    },
    [syncActivityTrace, flushReasoning],
  );

  const waitForRunStreamCompletion = useCallback((runId: string) => {
    if (completedStreamRunIdsRef.current.delete(runId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      streamCompletionWaitersRef.current.set(runId, resolve);
    });
  }, []);

  return {
    activityTrace,
    agentRunPhase,
    activeRunIdRef,
    activeRunTraceRef,
    streamMessageIdsRef,
    sidechainRunRef,
    syncActivityTrace,
    beginRunActivity,
    finishRunActivity,
    waitForRunStreamCompletion,
  };
}
