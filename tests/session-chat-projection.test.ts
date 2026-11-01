import { describe, expect, it } from "vitest";
import {
  findActiveThreadId,
  toSessionChatMessages,
} from "../app/renderer/src/app/chatMessageRuntime";
import type { PersistedDisplayCard } from "../src/shared/card-display-protocol";
import { type SessionChatMessage, sessionChatMessageSchema } from "../src/shared/session";

function pendingReview(): PersistedDisplayCard {
  return {
    event: {
      protocolVersion: 1,
      eventId: "review-1",
      emittedAt: "2026-07-15T00:00:00.000Z",
      kind: "review.command-proposal",
      category: "review",
      source: { kind: "tool", toolName: "SubmitCommands" },
      scope: { sessionId: "session-1", threadId: "thread-1", anchorMessageId: "a-1" },
      semantics: { blocking: true, requiresResponse: true, priority: "high" },
      payload: {
        jobId: "job-1",
        queryId: "query-1",
        proposalId: "proposal-1",
        threadId: "thread-1",
        summary: "更新排版",
        commands: [],
      },
    },
    status: "active",
    receivedAt: 1,
  };
}

describe("session chat projection", () => {
  it("recovers a waiting thread only when no blocking review card exists", () => {
    const messages: SessionChatMessage[] = [
      { id: "u-1", role: "user", content: "继续" },
      {
        id: "a-1",
        role: "assistant",
        content: "请补充信息",
        activityTrace: [
          {
            id: "response-waiting",
            kind: "response",
            start: 0,
            end: 5,
            streaming: false,
          },
        ],
        runId: "run-1",
        runStatus: "waiting",
        threadId: "thread-1",
      },
    ];
    expect(findActiveThreadId(messages)).toBe("thread-1");
    expect(findActiveThreadId(messages, [pendingReview()])).toBeUndefined();
  });

  it("persists canonical run identity and full text without display-buffer state", () => {
    const messages: SessionChatMessage[] = [
      { id: "u-1", role: "user", content: "生成演示文稿" },
      {
        id: "a-1",
        role: "assistant",
        content: "已生成完整演示文稿",
        runId: "run-1",
        runStatus: "completed",
        activityTrace: [
          {
            id: "response-1",
            kind: "response",
            start: 0,
            end: 3,
            streaming: false,
          },
          {
            id: "tool-1",
            kind: "tool",
            toolCallId: "call-1",
            toolName: "ExportPptx",
            status: "completed",
          },
          {
            id: "response-2",
            kind: "response",
            start: 3,
            end: 9,
            streaming: false,
          },
        ],
      },
    ];

    expect(toSessionChatMessages(messages)).toEqual(messages);
    const serialized = JSON.stringify(toSessionChatMessages(messages));
    expect(serialized).not.toContain("revealedCount");
    expect(serialized).not.toContain('"loading"');
    expect(serialized).not.toContain('"active"');
  });

  it("rejects the retired flat run-message shape", () => {
    expect(
      sessionChatMessageSchema.safeParse({
        id: "assistant-flat",
        role: "assistant",
        content: "正文不能脱离运行时间线",
        runId: "run-flat",
        runStatus: "completed",
      }).success,
    ).toBe(false);
  });
});
