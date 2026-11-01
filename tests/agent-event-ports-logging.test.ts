import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEventPorts } from "../app/main/agent/runtime/lifecycle/agent-event-ports";
import type { ConversationDatabase } from "../app/main/conversation-database";
import { withLogContext } from "../app/main/logging/log-context";
import { createTestLogCollector } from "./test-log-collector";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AgentEventPorts logging", () => {
  it("projects tool requests, execution state, and bounded results into correlated logs", () => {
    const { logger, records } = createTestLogCollector("agent-runtime-events");
    const ports = new AgentEventPorts({
      threadId: "thread-1",
      runId: "run-1",
      logger,
      appendTranscript: vi.fn(),
    });

    withLogContext({ runId: "run-1", threadId: "thread-1", queryId: "query-1" }, () => {
      ports.audit(
        "tool_call",
        {
          toolUseId: "call-1",
          toolName: "ExampleTool",
          input: {
            apiKey: "sk-1234567890abcdefghij",
            pngBase64: "a".repeat(2_000),
          },
        },
        "model_only",
      );
      ports.renderer({
        type: "tool-state",
        toolCallId: "call-1",
        toolName: "ExampleTool",
        status: "running",
        message: "running",
      });
      vi.advanceTimersByTime(25);
      ports.renderer({
        type: "tool-state",
        toolCallId: "call-1",
        toolName: "ExampleTool",
        status: "completed",
        message: "done",
      });
      ports.audit(
        "tool_result",
        {
          toolUseId: "call-1",
          toolName: "ExampleTool",
          isError: false,
          content: [
            { type: "text", text: "completed" },
            { type: "image", mediaType: "image/png", data: "b".repeat(2_000) },
          ],
        },
        "model_only",
      );
    });

    const infoEntries = records
      .filter((record) => record.level === "info")
      .map((record) => ({ ...record.data, ...record.context, event: record.event }));
    expect(infoEntries.find((entry) => entry.event === "tool.call.requested")).toMatchObject({
      runId: "run-1",
      threadId: "thread-1",
      queryId: "query-1",
      toolCallId: "call-1",
      toolName: "ExampleTool",
    });
    expect(infoEntries.find((entry) => entry.event === "tool.execution.finished")).toMatchObject({
      toolCallId: "call-1",
      status: "completed",
      durationMs: 25,
    });
    expect(infoEntries.find((entry) => entry.event === "tool.result.delivered")).toMatchObject({
      toolCallId: "call-1",
      contentBlockCount: 2,
      textLength: 9,
      imageCount: 1,
    });

    const debugText = JSON.stringify(records.filter((record) => record.level === "debug"));
    expect(debugText).not.toContain("sk-1234567890abcdefghij");
    expect(debugText).not.toContain("a".repeat(2_000));
    expect(debugText).not.toContain("b".repeat(2_000));
  });

  it("logs failed tool states as warnings", () => {
    const { logger, records } = createTestLogCollector("agent-runtime-events");
    const ports = new AgentEventPorts({
      threadId: "thread-1",
      runId: "run-1",
      logger,
      appendTranscript: vi.fn(),
    });

    ports.renderer({
      type: "tool-state",
      toolCallId: "call-failed",
      toolName: "ExampleTool",
      status: "failed",
      message: "failed",
      error: "network unavailable",
    });

    expect(
      records
        .filter((record) => record.level === "warn")
        .map((record) => ({ ...record.data, event: record.event })),
    ).toContainEqual(
      expect.objectContaining({
        event: "tool.execution.finished",
        status: "failed",
        toolCallId: "call-failed",
      }),
    );
  });

  it("does not let audit persistence or transcript failures affect runtime control flow", () => {
    const { logger, records } = createTestLogCollector("agent-runtime-events");
    const conversationDatabase = {
      appendRuntimeEvent: vi.fn(() => {
        throw new Error("database unavailable");
      }),
    } as unknown as ConversationDatabase;
    const ports = new AgentEventPorts({
      threadId: "thread-1",
      runId: "run-1",
      conversationDatabase,
      logger,
      appendTranscript: () => {
        throw new Error("transcript unavailable");
      },
    });

    expect(() => ports.audit("workflow_progress", { message: "test" }, "internal")).not.toThrow();

    const warnings = records
      .filter((record) => record.level === "warn")
      .map((record) => ({ ...record.data, event: record.event }));
    expect(warnings).toContainEqual(
      expect.objectContaining({
        event: "runtime.audit.persist-failed",
        eventKind: "workflow_progress",
      }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({
        event: "runtime.audit.transcript-failed",
        eventKind: "workflow_progress",
      }),
    );
  });
});
