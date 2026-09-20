// @vitest-environment jsdom

import {
  clearAllDisplayCardManagers,
  usePermissionCardManager,
} from "@shared/cards/display-card-managers";
import { cleanup, render } from "@testing-library/react";
import { act, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentActivityStreamController,
  useAgentActivityStream,
} from "../src/renderer/src/app/agent/useAgentActivityStream";
import type { ChatMessage } from "../src/renderer/src/app/chatMessageRuntime";
import type { AgentStreamEvent } from "../src/shared/ipc";

let emit: (event: AgentStreamEvent) => void;
let controller: AgentActivityStreamController;
let messages: ChatMessage[];

function Harness() {
  const activeSessionIdRef = useRef("session-1");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "message-1",
      role: "assistant",
      content: "",
      runId: "run-1",
      runStatus: "running",
    },
  ]);
  controller = useAgentActivityStream({
    activeSessionIdRef,
    setChatMessages,
  });
  messages = chatMessages;
  return <div data-phase={controller.agentRunPhase} />;
}

describe("agent activity stream projection", () => {
  beforeEach(() => {
    clearAllDisplayCardManagers();
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        onAgentStream(handler: (event: AgentStreamEvent) => void) {
          emit = handler;
          return vi.fn();
        },
      },
    });
  });

  afterEach(cleanup);

  it("coalesces interleaved lead and teammate reasoning and preserves tool ordering", () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      act(() => controller.beginRunActivity("run-1", "message-1", false));
      const teammate = { runId: "run-1", teammateName: "researcher", activityId: "assignment-1" };
      act(() =>
        emit({ ...teammate, type: "teammate-assignment-started", description: "核验资料" }),
      );
      const beforeChunks = controller.activityTrace;
      act(() => {
        for (let i = 0; i < 1000; i++) {
          emit({ runId: "run-1", type: "thinking-chunk", modelStep: 0, chunk: "L".repeat(50) });
          emit({ ...teammate, type: "teammate-thinking-chunk", chunk: "T".repeat(50) });
        }
      });
      expect(controller.activityTrace).toBe(beforeChunks);
      act(() => vi.advanceTimersByTime(100));
      const lead = controller.activityTrace.find((item) => item.kind === "reasoning");
      const task = controller.activityTrace.find((item) => item.kind === "task");
      expect(lead?.kind === "reasoning" && lead.content.length).toBeLessThan(8100);
      if (task?.kind !== "task") throw new Error("Missing assignment");
      expect(task.steps).toHaveLength(1);
      expect(task.steps[0].text).toContain("T".repeat(8000));
      expect(task.steps[0].text.length).toBeLessThan(8100);
      const cappedTrace = controller.activityTrace;
      act(() => emit({ ...teammate, type: "teammate-thinking-chunk", chunk: "overflow" }));
      act(() => vi.advanceTimersByTime(100));
      expect(controller.activityTrace).toBe(cappedTrace);

      const second = { ...teammate, activityId: "assignment-2" };
      act(() => {
        emit({ ...second, type: "teammate-assignment-started", description: "另一项核验" });
        emit({ ...second, type: "teammate-thinking-chunk", chunk: "先查来源" });
        emit({ ...second, type: "teammate-tool-started", toolName: "ReadFile", message: "读取" });
        emit({ ...second, type: "teammate-assignment-finished", status: "completed" });
      });
      const secondTask = controller.activityTrace.find(
        (item) => item.kind === "task" && item.taskId === "assignment-2",
      );
      if (secondTask?.kind !== "task") throw new Error("Missing second assignment");
      expect(secondTask.steps.map((step) => step.type)).toEqual(["reasoning", "tool"]);
      expect(secondTask.steps[0]).toMatchObject({ text: "先查来源", streaming: false });
      expect(secondTask.status).toBe("completed");
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("bounds teammate updates after the lead ends and discards another session's events", () => {
    vi.useFakeTimers();
    try {
      const view = render(<Harness />);
      act(() => controller.beginRunActivity("run-1", "message-1", false));
      const teammate = { runId: "run-1", teammateName: "researcher", activityId: "assignment-1" };
      act(() => {
        emit({ ...teammate, type: "teammate-assignment-started", description: "核验资料" });
        emit({ ...teammate, type: "teammate-thinking-chunk", chunk: "start" });
        controller.finishRunActivity("run-1");
      });
      act(() => {
        emit({
          ...teammate,
          sessionId: "other",
          type: "teammate-thinking-chunk",
          chunk: "wrong".repeat(2000),
        });
        for (let i = 0; i < 1000; i++) {
          emit({ ...teammate, type: "teammate-thinking-chunk", chunk: "x".repeat(50) });
        }
      });
      act(() => vi.advanceTimersByTime(100));
      expect(controller.activityTrace).toEqual([]);
      const task = messages[0].activityTrace?.find((item) => item.kind === "task");
      if (task?.kind !== "task") throw new Error("Missing persisted assignment");
      expect(task.steps[0].text).toContain(`start${"x".repeat(7995)}`);
      expect(task.steps[0].text.length).toBeLessThan(8100);
      expect(task.steps[0].text).not.toContain("wrong");
      act(() => emit({ ...teammate, type: "teammate-assignment-finished", status: "completed" }));
      expect(messages[0].activityTrace?.find((item) => item.kind === "task")).toMatchObject({
        status: "completed",
      });
      const second = { ...teammate, activityId: "assignment-2" };
      act(() => {
        emit({ ...second, type: "teammate-assignment-started", description: "下一项" });
        emit({ ...second, type: "teammate-thinking-chunk", chunk: "pending" });
      });
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("batches and bounds long reasoning while flushing before text and completion", () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      act(() => controller.beginRunActivity("run-1", "message-1", false));
      act(() => {
        for (let i = 0; i < 1000; i++) {
          emit({ runId: "run-1", type: "thinking-chunk", chunk: "x".repeat(50), modelStep: 0 });
        }
      });
      expect(controller.activityTrace).toEqual([]);
      act(() => vi.advanceTimersByTime(100));
      const reasoning = controller.activityTrace[0];
      expect(reasoning.kind).toBe("reasoning");
      if (reasoning.kind !== "reasoning") throw new Error("Missing reasoning");
      expect(reasoning.content.length).toBeLessThan(8100);
      expect(reasoning.content.startsWith("x".repeat(8000))).toBe(true);

      act(() => emit({ runId: "run-1", type: "thinking-chunk", chunk: "next", modelStep: 1 }));
      act(() => emit({ runId: "run-1", type: "text-chunk", chunk: "done", attemptId: "answer" }));
      expect(controller.activityTrace.map((item) => item.kind)).toEqual([
        "reasoning",
        "reasoning",
        "response",
      ]);
      expect(messages[0].content).toBe("done");
      act(() => emit({ runId: "run-1", type: "thinking-chunk", chunk: "last", modelStep: 2 }));
      act(() => controller.finishRunActivity("run-1"));
      act(() => vi.runAllTimers());
      expect(controller.activityTrace).toEqual([]);
      expect(messages[0].activityTrace?.at(-1)).toMatchObject({
        kind: "reasoning",
        content: "last",
      });
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("appends response, tool, and later response blocks in event order", async () => {
    render(<Harness />);
    act(() => controller.beginRunActivity("run-1", "message-1", false));
    expect(controller.agentRunPhase).toBe("requesting");

    act(() =>
      emit({
        runId: "run-1",
        type: "thinking-chunk",
        chunk: "检查页面结构",
        modelStep: 0,
      }),
    );
    expect(controller.agentRunPhase).toBe("thinking");

    act(() =>
      emit({
        runId: "run-1",
        type: "text-chunk",
        attemptId: "attempt-intro",
        chunk: "我先检查。",
      }),
    );
    act(() =>
      emit({
        runId: "run-1",
        type: "text-commit",
        attemptId: "attempt-intro",
      }),
    );
    const firstResponse = controller.activityTrace.find((item) => item.kind === "response");
    expect(firstResponse).toMatchObject({
      kind: "response",
      start: 0,
      end: 5,
      streaming: false,
    });

    act(() =>
      emit({
        runId: "run-1",
        type: "tool-state",
        toolCallId: "call-a",
        toolName: "ReadPresentationSnapshot",
        status: "running",
        message: "读取中",
      }),
    );
    const runningTool = controller.activityTrace.find((item) => item.kind === "tool");
    act(() =>
      emit({
        runId: "run-1",
        type: "tool-state",
        toolCallId: "call-a",
        toolName: "ReadPresentationSnapshot",
        status: "completed",
        message: "读取完成",
      }),
    );

    const completedTool = controller.activityTrace.find((item) => item.kind === "tool");
    expect(completedTool).toMatchObject({
      id: runningTool?.id,
      toolCallId: "call-a",
      status: "completed",
    });

    act(() =>
      emit({
        runId: "run-1",
        type: "text-chunk",
        attemptId: "attempt-bad",
        chunk: "错误草稿",
      }),
    );
    expect(messages[0]?.content).toBe("我先检查。错误草稿");
    expect(controller.agentRunPhase).toBe("responding");

    act(() =>
      emit({
        runId: "run-1",
        type: "text-reset",
        attemptId: "attempt-bad",
      }),
    );
    expect(messages[0]?.content).toBe("我先检查。");
    expect(controller.activityTrace.filter((item) => item.kind === "response")).toEqual([
      firstResponse,
    ]);
    expect(controller.agentRunPhase).toBe("requesting");

    act(() =>
      emit({
        runId: "run-1",
        type: "text-chunk",
        attemptId: "attempt-good",
        chunk: "最终回复",
      }),
    );
    act(() =>
      emit({
        runId: "run-1",
        type: "text-commit",
        attemptId: "attempt-good",
      }),
    );
    expect(messages[0]?.content).toBe("我先检查。最终回复");
    expect(
      controller.activityTrace.filter((item) => item.kind !== "reasoning").map((item) => item.kind),
    ).toEqual(["response", "tool", "response"]);
    expect(controller.activityTrace.filter((item) => item.kind === "response")).toMatchObject([
      {
        id: firstResponse?.id,
        start: 0,
        end: 5,
        streaming: false,
      },
      {
        start: 5,
        end: 9,
        attemptId: "attempt-good",
        streaming: false,
      },
    ]);

    const completed = controller.waitForRunStreamCompletion("run-1");
    act(() => emit({ runId: "run-1", type: "stream-completed" }));
    await expect(completed).resolves.toBeUndefined();
  });

  it("ignores stale runs and duplicate tool lifecycle events", () => {
    render(<Harness />);
    act(() => controller.beginRunActivity("run-1", "message-1", false));

    act(() =>
      emit({
        runId: "run-stale",
        type: "text-chunk",
        chunk: "不应出现",
      }),
    );
    expect(messages[0]?.content).toBe("");

    const started: AgentStreamEvent = {
      runId: "run-1",
      type: "tool-state",
      toolCallId: "call-1",
      toolName: "ExportPptx",
      status: "running",
      message: "导出中",
    };
    const completed: AgentStreamEvent = {
      ...started,
      status: "completed",
      message: "导出完成",
    };
    act(() => {
      emit(started);
      emit(started);
      emit(completed);
      emit(completed);
    });

    expect(controller.activityTrace.filter((item) => item.kind === "tool")).toMatchObject([
      { toolCallId: "call-1", status: "completed" },
    ]);
  });

  it("moves tool approval from waiting to a durable terminal state", () => {
    render(<Harness />);
    act(() => controller.beginRunActivity("run-1", "message-1", false));

    act(() => {
      emit({
        runId: "run-1",
        type: "tool-approval-waiting",
        message: "等待授权",
        approvalId: "approval-1",
        toolName: "ExportPptx",
        reason: "需要写入文件",
        detail: "output.pptx",
      });
      emit({
        runId: "run-1",
        type: "display-event",
        event: {
          protocolVersion: 1,
          eventId: "tool-approval:approval-1",
          emittedAt: "2026-07-25T00:00:00.000Z",
          kind: "permission.tool-requested",
          category: "permission",
          source: { kind: "tool", toolName: "ExportPptx" },
          scope: { sessionId: "session-1", runId: "run-1" },
          semantics: {
            blocking: true,
            requiresResponse: true,
            priority: "critical",
          },
          payload: {
            approvalId: "approval-1",
            toolName: "ExportPptx",
            reason: "需要写入文件",
            detail: "output.pptx",
          },
        },
      });
    });

    expect(controller.agentRunPhase).toBe("waiting");
    expect(controller.activityTrace).toEqual([
      expect.objectContaining({
        kind: "tool-approval",
        approvalId: "approval-1",
        status: "pending",
      }),
    ]);
    expect(usePermissionCardManager.getState().cards[0]?.status).toBe("active");

    act(() =>
      emit({
        runId: "run-1",
        type: "tool-approval-resolved",
        message: "工具授权已拒绝",
        approvalId: "approval-1",
        toolName: "ExportPptx",
        status: "denied",
      }),
    );

    expect(controller.agentRunPhase).toBe("working");
    expect(controller.activityTrace[0]).toMatchObject({ status: "denied" });
    expect(usePermissionCardManager.getState().cards[0]?.status).toBe("dismissed");
  });
});
