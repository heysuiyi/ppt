import { describe, expect, it } from "vitest";
import { AgentEventPorts } from "../app/main/agent/runtime/lifecycle/agent-event-ports";

describe("agent event envelope", () => {
  it("forwards a structured tool state with stable call identity", () => {
    const received: unknown[] = [];
    const events = new AgentEventPorts({
      threadId: "thread-1",
      runId: "run-1",
      appendTranscript: () => undefined,
      onProgress: (event) => received.push(event),
    });
    events.renderer({
      type: "tool-state",
      message: "正在读取演示文稿",
      toolCallId: "call-1",
      toolName: "ReadPresentationSnapshot",
      status: "running",
    });

    expect(received).toEqual([
      {
        type: "tool-state",
        message: "正在读取演示文稿",
        toolCallId: "call-1",
        toolName: "ReadPresentationSnapshot",
        status: "running",
      },
    ]);
  });

  it("isolates renderer failures and creates a namespaced run envelope", () => {
    const events = new AgentEventPorts({
      threadId: "thread-1",
      runId: "run-1",
      appendTranscript: () => undefined,
      onProgress: () => {
        throw new Error("renderer unavailable");
      },
    });

    expect(() => events.renderer({ type: "workflow-progress", message: "working" })).not.toThrow();
    expect(
      events.envelope("tool", "tool_state", {
        toolCallId: "call-1",
        status: "completed",
      }),
    ).toMatchObject({
      threadId: "thread-1",
      runId: "run-1",
      namespace: "tool",
      type: "tool_state",
      payload: { toolCallId: "call-1", status: "completed" },
    });
  });

  it("emits at most one terminal state for each tool call", () => {
    const received: Array<{ type: string; [key: string]: unknown }> = [];
    const events = new AgentEventPorts({
      threadId: "thread-1",
      runId: "run-1",
      appendTranscript: () => undefined,
      onProgress: (event) => received.push(event),
    });
    const base = {
      type: "tool-state",
      message: "tool",
      toolCallId: "call-1",
      toolName: "ExportPptx",
    };

    events.renderer({ ...base, status: "running" });
    events.renderer({ ...base, status: "running" });
    events.renderer({ ...base, status: "denied" });
    events.renderer({ ...base, status: "denied" });
    events.renderer({ ...base, status: "running" });

    expect(received.map((event) => event.status)).toEqual(["running", "denied"]);
  });
});
