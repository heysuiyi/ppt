import {
  type AgentActivityItem,
  agentActivityItemSchema,
  compactActivityTraceForPersistence,
} from "@shared/agent-activity";
import { describe, expect, it } from "vitest";
import {
  buildProcessView,
  buildTimelineSegments,
} from "../app/renderer/src/components/run-process/process-model";

const thought: AgentActivityItem = {
  id: "r1",
  kind: "reasoning",
  content: "核对上下文",
  streaming: true,
};
const tool: Extract<AgentActivityItem, { kind: "tool" }> = {
  id: "t1",
  kind: "tool",
  toolCallId: "c1",
  toolName: "ReadFile",
  status: "running",
};

describe("process projection invariants", () => {
  it("keeps process identity when filtered status completes, thinking appears and tools arrive", () => {
    const status: AgentActivityItem = {
      id: "status",
      kind: "step",
      text: "等待模型",
      status: "running",
      transient: true,
    };
    const initial = buildTimelineSegments([status]);
    const updated = buildTimelineSegments([{ ...status, status: "done" }, thought, tool]);
    expect(initial[0]).toMatchObject({ kind: "process", id: "status" });
    expect(updated[0]).toMatchObject({ kind: "process", id: "status" });
    const view = buildProcessView([status, thought, tool], { live: true });
    expect(view.rows.map((row) => row.id)).toEqual(["r1", "t1"]);
  });

  it("preserves response and independent task boundaries without reordering reasoning", () => {
    const reply: AgentActivityItem = { id: "reply", kind: "response", start: 0, end: 4 };
    const task: AgentActivityItem = {
      id: "task",
      kind: "task",
      taskId: "task-1",
      description: "研究",
      status: "running",
      steps: [],
    };
    const nextThought = { ...thought, id: "r2" };
    expect(buildTimelineSegments([thought, reply, tool, task, nextThought])).toEqual([
      { kind: "process", id: "r1", items: [thought] },
      { kind: "response", item: reply },
      { kind: "process", id: "t1", items: [tool] },
      { kind: "task", item: task },
      { kind: "process", id: "r2", items: [nextThought] },
    ]);
  });

  it.each(["completed", "failed", "interrupted", "waiting"] as const)(
    "does not animate stale running events after a %s outcome",
    (runStatus) => {
      const view = buildProcessView([thought, tool], { live: true, runStatus });
      expect(view.active).toBe(false);
      expect(view.rows.some((row) => row.active || row.streaming)).toBe(false);
      expect(view.rows.map((row) => row.id)).toEqual(["r1", "t1"]);
    },
  );

  it("distinguishes idle finished work from a running parallel tool after a reply", () => {
    expect(
      buildProcessView([{ ...tool, status: "completed" }], { live: true, hasLaterResponse: true })
        .active,
    ).toBe(false);
    expect(buildProcessView([tool], { live: true, hasLaterResponse: true }).active).toBe(true);
    expect(buildProcessView([tool], { live: false, hasLaterResponse: true }).active).toBe(false);
  });

  it("retains failure attention even when another tool is still running", () => {
    const view = buildProcessView([{ ...tool, id: "failed", status: "failed" }, tool], {
      live: true,
    });
    expect(view.active).toBe(true);
    expect(view.attention).toBe(true);
    expect(view.rows.find((row) => row.id === "failed")?.status).toBe("failed");
    expect(view.rows.find((row) => row.id === "t1")?.active).toBe(true);
  });

  it("preserves legacy progress and approval reasons instead of guessing from wording", () => {
    const items: AgentActivityItem[] = [
      { id: "legacy", kind: "step", text: "开始处理您的请求...", status: "done" },
      {
        id: "approval",
        kind: "tool-approval",
        approvalId: "a1",
        toolName: "WriteFile",
        reason: "即将覆盖作者文件",
        detail: "slides/page.svg",
        status: "denied",
      },
    ];
    const view = buildProcessView(items, { live: false });
    expect(view.rows.map((row) => row.id)).toEqual(["legacy", "approval"]);
    expect(JSON.stringify(view.rows[1])).toContain("即将覆盖作者文件");
    expect(view.attention).toBe(true);
  });

  it("keeps authorization controls outside records without changing the group identity on resolution", () => {
    const approval: Extract<AgentActivityItem, { kind: "tool-approval" }> = {
      id: "approval-first",
      kind: "tool-approval",
      approvalId: "a1",
      toolName: "WriteFile",
      reason: "覆盖文件",
      detail: "slides/page.svg",
      status: "pending",
    };
    const before = buildTimelineSegments([approval, thought]);
    const after = buildTimelineSegments([{ ...approval, status: "approved" }, thought]);
    expect(before[0]).toMatchObject({ kind: "process", id: "approval-first" });
    expect(after[0]).toMatchObject({ kind: "process", id: "approval-first" });
    const pending = buildProcessView([approval, thought], { live: true });
    expect(pending.attention).toBe(true);
    expect(pending.rows.map((row) => row.id)).toEqual(["r1"]);
    const resolved = buildProcessView([{ ...approval, status: "approved" }, thought], {
      live: true,
    });
    expect(resolved.rows.map((row) => row.id)).toEqual(["approval-first", "r1"]);
    expect(JSON.stringify(resolved.rows[0])).toContain(approval.reason);
  });

  it("round-trips the explicit transient marker through schema validation and persistence", () => {
    const status = agentActivityItemSchema.parse({
      id: "status",
      kind: "step",
      text: "连接中",
      status: "done",
      transient: true,
    });
    const persisted = compactActivityTraceForPersistence([status, thought]);
    expect(persisted?.find((item) => item.id === "status")).toMatchObject({ transient: true });
    expect(buildProcessView(persisted ?? [], { live: false }).rows.map((row) => row.id)).toEqual([
      "r1",
    ]);
  });

  it("retains task description and child outcomes, without inventing lead activity", () => {
    const task: AgentActivityItem = {
      id: "task",
      kind: "task",
      taskId: "task-1",
      description: "检查图表引用",
      status: "failed",
      steps: [
        { id: "step", type: "tool", text: "读取数据", toolName: "ReadFile", status: "failed" },
      ],
    };
    const view = buildProcessView([task], { live: false });
    expect(view.active).toBe(false);
    expect(view.attention).toBe(true);
    expect(JSON.stringify(view.rows)).toContain(task.description);
    expect(view.rows.find((row) => row.id === "step")?.status).toBe("failed");
  });
});
