import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withLogContext } from "../app/main/agent/logger";
import { AgentEventPorts } from "../app/main/agent/runtime/lifecycle/agent-event-ports";
import type { ConversationDatabase } from "../app/main/conversation-database";

const originalLogLevel = process.env.AGENT_LOG_LEVEL;
const originalLogFile = process.env.AGENT_LOG_FILE;

beforeEach(() => {
  process.env.AGENT_LOG_LEVEL = "debug";
  process.env.AGENT_LOG_FILE = "false";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
});

afterEach(() => {
  if (originalLogLevel === undefined) delete process.env.AGENT_LOG_LEVEL;
  else process.env.AGENT_LOG_LEVEL = originalLogLevel;
  if (originalLogFile === undefined) delete process.env.AGENT_LOG_FILE;
  else process.env.AGENT_LOG_FILE = originalLogFile;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AgentEventPorts logging", () => {
  it("projects tool requests, execution state, and bounded results into correlated logs", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const ports = new AgentEventPorts({
      threadId: "thread-1",
      runId: "run-1",
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

    const infoEntries = entriesFrom(info.mock.calls);
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

    const debugText = debug.mock.calls.map(([line]) => String(line)).join("\n");
    expect(debugText).not.toContain("sk-1234567890abcdefghij");
    expect(debugText).toContain("Binary data omitted");
  });

  it("logs failed tool states as warnings", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ports = new AgentEventPorts({
      threadId: "thread-1",
      runId: "run-1",
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

    expect(entriesFrom(warn.mock.calls)).toContainEqual(
      expect.objectContaining({
        event: "tool.execution.finished",
        status: "failed",
        toolCallId: "call-failed",
      }),
    );
  });

  it("does not let audit persistence or transcript failures affect runtime control flow", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const conversationDatabase = {
      appendRuntimeEvent: vi.fn(() => {
        throw new Error("database unavailable");
      }),
    } as unknown as ConversationDatabase;
    const ports = new AgentEventPorts({
      threadId: "thread-1",
      runId: "run-1",
      conversationDatabase,
      appendTranscript: () => {
        throw new Error("transcript unavailable");
      },
    });

    expect(() => ports.audit("workflow_progress", { message: "test" }, "internal")).not.toThrow();

    const warnings = entriesFrom(warn.mock.calls);
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

function entriesFrom(calls: unknown[][]): Array<Record<string, unknown>> {
  return calls.map(([line]) => {
    const text = String(line);
    return JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
  });
}
