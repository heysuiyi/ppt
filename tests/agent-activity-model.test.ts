import { describe, expect, it } from "vitest";
import {
  type AgentActivityItem,
  appendReasoningChunk,
  appendToolStart,
  applyTeammateProgressEvent,
  compactActivityTraceForPersistence,
  finishTool,
  markTraceComplete,
  mergeActivityTraces,
  mergeResponseText,
} from "../src/shared/agent-activity";

describe("agent activity model", () => {
  it("tracks same-name tools by call id and preserves independent outcomes", () => {
    let trace: AgentActivityItem[] = [];
    trace = appendToolStart(trace, "call-a", "ReadPresentationSnapshot");
    trace = appendToolStart(trace, "call-b", "ReadPresentationSnapshot");
    trace = finishTool(trace, "call-b", "ReadPresentationSnapshot", "completed");
    trace = finishTool(trace, "call-a", "ReadPresentationSnapshot", "failed");

    expect(trace).toMatchObject([
      {
        kind: "tool",
        toolCallId: "call-a",
        toolName: "ReadPresentationSnapshot",
        status: "failed",
      },
      {
        kind: "tool",
        toolCallId: "call-b",
        toolName: "ReadPresentationSnapshot",
        status: "completed",
      },
    ]);
  });

  it("finishes a started tool once when result validation fails", () => {
    const started = appendToolStart([], "call-invalid", "SubmitCommands");
    const trace = finishTool(started, "call-invalid", "SubmitCommands", "invalid-input");

    expect(trace).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "call-invalid",
        toolName: "SubmitCommands",
        status: "invalid-input",
      }),
    ]);
    expect(trace[0]).not.toHaveProperty("label");
    expect(trace[0]).not.toHaveProperty("finishedLabel");
  });

  it("ignores duplicated and out-of-order tool lifecycle events", () => {
    let trace = finishTool([], "call-1", "ExportPptx", "completed");
    trace = appendToolStart(trace, "call-1", "ExportPptx");
    trace = finishTool(trace, "call-1", "ExportPptx", "failed");

    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({
      toolCallId: "call-1",
      status: "completed",
    });
  });

  it("seals one reasoning round before the next model step", () => {
    let trace: AgentActivityItem[] = [];
    trace = appendReasoningChunk(trace, "先梳理结构", 0);
    trace = appendReasoningChunk(trace, "，再检查内容", 0);
    trace = appendReasoningChunk(trace, "开始第二轮", 1);

    expect(trace).toMatchObject([
      {
        kind: "reasoning",
        content: "先梳理结构，再检查内容",
        modelStep: 0,
        streaming: false,
      },
      {
        kind: "reasoning",
        content: "开始第二轮",
        modelStep: 1,
        streaming: true,
      },
    ]);
  });

  it("merges same modelStep reasoning even when tools already follow it", () => {
    let trace: AgentActivityItem[] = [];
    trace = appendReasoningChunk(trace, "先看模板", 0);
    trace = appendToolStart(trace, "call-1", "ReadFile");
    trace = appendReasoningChunk(trace, "再补一句", 0);

    expect(trace.filter((item) => item.kind === "reasoning")).toHaveLength(1);
    expect(trace).toMatchObject([
      {
        kind: "reasoning",
        content: "先看模板再补一句",
        modelStep: 0,
        streaming: true,
      },
      {
        kind: "tool",
        toolName: "ReadFile",
      },
    ]);
  });

  it("keeps separate reasoning segments even when a retried turn reuses modelStep", () => {
    const first: AgentActivityItem = {
      id: "attempt-1",
      kind: "reasoning",
      content: "失败尝试",
      modelStep: 0,
      streaming: false,
    };
    const retry: AgentActivityItem = {
      id: "attempt-2",
      kind: "reasoning",
      content: "重试后的思考",
      modelStep: 0,
      streaming: true,
    };

    expect(mergeActivityTraces([first], [first, retry])).toMatchObject([
      { id: "attempt-1", content: "失败尝试", streaming: false },
      { id: "attempt-2", content: "重试后的思考", streaming: true },
    ]);
  });

  it("merges by stable identity without regressing terminal tool state", () => {
    const completed: AgentActivityItem = {
      id: "tool-final",
      kind: "tool",
      toolCallId: "call-1",
      toolName: "ExportPptx",
      status: "completed",
    };
    const staleRunning: AgentActivityItem = {
      id: "tool-stale",
      kind: "tool",
      toolCallId: "call-1",
      toolName: "ExportPptx",
      status: "running",
    };
    const merged = mergeActivityTraces([completed], [staleRunning]);

    expect(merged).toHaveLength(1);
    expect(merged?.[0]).toMatchObject({
      toolCallId: "call-1",
      status: "completed",
    });
  });

  it("uses the newest task-list snapshot regardless of trace length", () => {
    const task = {
      id: "task-1",
      revision: 0,
      subject: "起草 Brief",
      description: "",
      status: "in_progress" as const,
      owner: "agent",
      blocks: [],
      blockedBy: [],
      routing: { executionTarget: "lead" as const },
      completionPolicy: "direct" as const,
      review: { state: "none" as const },
      reviewReceipts: [],
    };
    const older: AgentActivityItem[] = [
      {
        id: "graph-old",
        kind: "tasklist",
        goal: "goal",
        tasks: [task],
      },
      { id: "step-1", kind: "step", text: "较长的旧快照", status: "done" },
    ];
    const newer: AgentActivityItem[] = [
      {
        id: "graph-new",
        kind: "tasklist",
        goal: "goal",
        tasks: [{ ...task, status: "completed", owner: undefined }],
      },
    ];

    const merged = mergeActivityTraces(older, newer);
    const graph = merged?.find((item) => item.kind === "tasklist");

    expect(merged).toHaveLength(2);
    expect(graph).toMatchObject({
      kind: "tasklist",
      tasks: [{ id: "task-1", status: "completed" }],
    });
  });

  it("closes unfinished lead activity with the requested terminal outcome", () => {
    const trace: AgentActivityItem[] = [
      {
        id: "reasoning",
        kind: "reasoning",
        content: "检查中",
        streaming: true,
      },
      {
        id: "tool",
        kind: "tool",
        toolCallId: "call-1",
        toolName: "SubmitCommands",
        status: "running",
      },
    ];

    const failed = markTraceComplete(trace, "failed");
    expect(failed).toMatchObject([
      { kind: "reasoning", streaming: false },
      { kind: "tool", status: "failed" },
    ]);
  });

  it("keeps repeated response text when a tool separates the two turns", () => {
    const content = "先说明相同结论。";
    const trace: AgentActivityItem[] = [
      {
        id: "response-before-tool",
        kind: "response",
        start: 0,
        end: content.length,
        streaming: false,
      },
      {
        id: "tool-between-responses",
        kind: "tool",
        toolCallId: "call-read",
        toolName: "ReadPresentationSnapshot",
        status: "completed",
      },
    ];

    const merged = mergeResponseText(trace, content, "相同结论");
    const responses = merged.trace.filter((item) => item.kind === "response");

    expect(mergeResponseText(trace, content, content)).toEqual({ trace, content });
    expect(merged.content).toBe("先说明相同结论。\n\n相同结论");
    expect(responses.map((item) => merged.content.slice(item.start, item.end))).toEqual([
      "先说明相同结论。",
      "\n\n相同结论",
    ]);
  });

  it("fails an unfinished teammate step when its assignment fails", () => {
    let trace: AgentActivityItem[] = [];
    trace = applyTeammateProgressEvent(trace, {
      type: "teammate-assignment-started",
      teammateName: "layout-worker",
      activityId: "task-1",
      description: "调整布局",
    });
    trace = applyTeammateProgressEvent(trace, {
      type: "teammate-tool-started",
      teammateName: "layout-worker",
      activityId: "task-1",
      toolName: "WriteFile",
      message: "正在写入",
    });
    trace = applyTeammateProgressEvent(trace, {
      type: "teammate-assignment-finished",
      teammateName: "layout-worker",
      activityId: "task-1",
      status: "failed",
    });

    expect(trace[0]).toMatchObject({
      kind: "task",
      status: "failed",
      steps: [{ type: "tool", status: "failed" }],
    });
  });

  it("bounds persisted trace size while retaining the current task list", () => {
    const trace: AgentActivityItem[] = [
      {
        id: "graph",
        kind: "tasklist",
        goal: "layout",
        tasks: [],
      },
      ...Array.from(
        { length: 100 },
        (_, index): AgentActivityItem => ({
          id: `step-${index}`,
          kind: "step",
          text: "x".repeat(10_000),
          status: "done",
        }),
      ),
    ];

    const compacted = compactActivityTraceForPersistence(trace)!;

    expect(compacted.length).toBeLessThanOrEqual(80);
    expect(compacted.some((item) => item.id === "graph")).toBe(true);
    expect(compacted.some((item) => item.id === "step-99")).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(compacted)).byteLength).toBeLessThanOrEqual(
      96 * 1_024,
    );
  });

  it("keeps response ordering structural without evicting the newest tool", () => {
    const trace = Array.from({ length: 100 }, (_, index): AgentActivityItem[] => [
      {
        id: `response-${index}`,
        kind: "response",
        start: index,
        end: index + 1,
        streaming: false,
      },
      {
        id: `tool-${index}`,
        kind: "tool",
        toolCallId: `call-${index}`,
        toolName: "ReadPresentationSnapshot",
        status: "completed",
      },
    ]).flat();

    const compacted = compactActivityTraceForPersistence(trace)!;

    expect(compacted.filter((item) => item.kind === "response")).toHaveLength(100);
    expect(compacted.some((item) => item.id === "tool-99")).toBe(true);
    expect(compacted.at(-1)?.id).toBe("tool-99");
  });
});
