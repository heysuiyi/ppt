import type { Dispatch, SetStateAction } from "react";
import { describe, expect, it, vi } from "vitest";
import { handleAgentRunFailure } from "../app/renderer/src/app/agent/agentRunFailure";
import type { ChatMessage } from "../app/renderer/src/app/chatMessageRuntime";

function createMessageState(initial: ChatMessage[]) {
  let messages = initial;
  const setMessages: Dispatch<SetStateAction<ChatMessage[]>> = (action) => {
    messages = typeof action === "function" ? action(messages) : action;
  };
  return {
    get messages() {
      return messages;
    },
    setMessages,
  };
}

describe("agent run terminal state", () => {
  it("preserves partial text and records interruption outside the transcript", () => {
    const state = createMessageState([
      {
        id: "assistant-1",
        role: "assistant",
        content: "已生成部分内容",
        runId: "run-1",
        runStatus: "running",
      },
    ]);
    const notify = vi.fn();

    handleAgentRunFailure({
      error: Object.assign(new Error("display copy can change"), { name: "AbortError" }),
      isSidechain: false,
      runMessageId: "assistant-1",
      activeTrace: [
        {
          id: "response-1",
          kind: "response",
          start: 0,
          end: 7,
          streaming: false,
        },
        {
          id: "tool-1",
          kind: "tool",
          toolCallId: "call-1",
          toolName: "ExportPptx",
          status: "running",
        },
      ],
      setChatMessages: state.setMessages,
      notify,
    });

    expect(state.messages[0]).toMatchObject({
      content: "已生成部分内容",
      runStatus: "interrupted",
      activityTrace: [{ kind: "response" }, { kind: "tool", status: "denied" }],
    });
    expect(state.messages[0]?.content).not.toContain("会话已中断");
    expect(notify).toHaveBeenCalledWith("会话已中断");
  });

  it("does not infer interruption from failure copy", () => {
    const state = createMessageState([
      {
        id: "assistant-1",
        role: "assistant",
        content: "部分回复",
        runStatus: "running",
      },
    ]);

    handleAgentRunFailure({
      error: new Error("任务已取消。"),
      isSidechain: false,
      runMessageId: "assistant-1",
      activeTrace: [
        {
          id: "response-1",
          kind: "response",
          start: 0,
          end: 6,
          streaming: false,
        },
      ],
      setChatMessages: state.setMessages,
      notify: vi.fn(),
    });

    expect(state.messages[0]).toMatchObject({ runStatus: "failed" });
  });

  it("preserves partial text and stores a public failure detail structurally", () => {
    const state = createMessageState([
      {
        id: "assistant-1",
        role: "assistant",
        content: "已完成前两页",
        runId: "run-1",
        runStatus: "running",
      },
    ]);

    handleAgentRunFailure({
      error: new Error("unexpected tool error"),
      isSidechain: false,
      runMessageId: "assistant-1",
      activeTrace: [],
      setChatMessages: state.setMessages,
      notify: vi.fn(),
    });

    expect(state.messages[0]).toMatchObject({
      content: "已完成前两页",
      runStatus: "failed",
      runError: "处理请求时遇到问题，请稍后重试。",
    });
  });

  it("does not expose schema diagnostics in the structured error", () => {
    const state = createMessageState([
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        runId: "run-1",
        runStatus: "running",
      },
    ]);

    handleAgentRunFailure({
      error: new Error(
        "Error invoking remote method 'agent:start': ModelOutputError: " +
          'Unrecognized key: "language"; Invalid input: expected 1 at version',
      ),
      isSidechain: false,
      runMessageId: "assistant-1",
      activeTrace: [],
      setChatMessages: state.setMessages,
      notify: vi.fn(),
    });

    expect(state.messages[0]?.runError).toBe("处理请求时遇到问题，请稍后重试。");
    expect(state.messages[0]?.runError).not.toContain("ModelOutputError");
    expect(state.messages[0]?.runError).not.toContain("language");
  });

  it("does not invent a visible message when an unanchored sidechain fails", () => {
    const state = createMessageState([]);

    handleAgentRunFailure({
      error: new Error("background failure"),
      isSidechain: true,
      runMessageId: undefined,
      activeTrace: [],
      setChatMessages: state.setMessages,
      notify: vi.fn(),
    });

    expect(state.messages).toEqual([]);
  });
});
