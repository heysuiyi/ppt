// @vitest-environment jsdom

import { deriveAgentRunPresentation } from "@shared/agent-run-presentation";
import { buildProcessTraceRows } from "@shared/process-trace-rows";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunTerminalNotice } from "../src/renderer/src/components/AgentRunTerminalNotice";
import { AgentRunTimeline } from "../src/renderer/src/components/AgentRunTimeline";
import { ProcessTraceItem } from "../src/renderer/src/components/ProcessTraceItem";
import { RunStatusIndicator } from "../src/renderer/src/components/RunStatusIndicator";
import type { AgentActivityItem } from "../src/shared/agent-activity";
import type { AgentTaskNode } from "../src/shared/agent-task-list";

afterEach(cleanup);

describe("agent run presentation", () => {
  it("keeps activity at the tail while appending text, tool, then text", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });

    const Surface = ({
      items,
      content,
      busy,
    }: {
      items: AgentActivityItem[];
      content: string;
      busy: boolean;
    }) => (
      <div data-testid="surface">
        <AgentRunTimeline documentId="test-run" items={items} content={content} live={busy} />
      </div>
    );

    const view = render(<Surface items={[]} content="" busy />);
    const surface = screen.getByTestId("surface");
    expect(surface.querySelector("[data-run-block-kind]")).toBeNull();

    const firstText: AgentActivityItem[] = [
      {
        id: "response-1",
        kind: "response",
        start: 0,
        end: 5,
        streaming: true,
      },
    ];
    view.rerender(<Surface items={firstText} content="我先检查。" busy />);
    const firstResponse = surface.querySelector('[data-run-block-id="response-1"]');
    expect(firstResponse).not.toBeNull();
    expect(surface.querySelector(".process-trace-row-status--running")).toBeNull();

    const withTool: AgentActivityItem[] = [
      { ...firstText[0]!, streaming: false },
      {
        id: "tool-1",
        kind: "tool",
        toolCallId: "call-1",
        toolName: "ReadPresentationSnapshot",
        status: "running",
      },
    ];
    view.rerender(<Surface items={withTool} content="我先检查。" busy />);
    // Working tool batch stays expanded (Cursor-style).
    expect(screen.getByRole("button", { name: "收起执行过程" })).not.toBeNull();
    expect(surface.querySelector('[data-run-block-id="response-1"]')).toBe(firstResponse);
    const tool = surface.querySelector('[data-run-block-id="tool-1"]');
    expect(tool).not.toBeNull();
    expect(surface.querySelectorAll(".process-trace-row-status--running")).toHaveLength(1);

    const finalItems: AgentActivityItem[] = [
      withTool[0]!,
      { ...withTool[1]!, status: "completed" },
      {
        id: "response-2",
        kind: "response",
        start: 5,
        end: 9,
        streaming: true,
      },
    ];
    view.rerender(<Surface items={finalItems} content="我先检查。处理完成" busy />);
    // Tools finished and trailing response started → auto-collapse.
    expect(screen.getByRole("button", { name: "展开执行过程" })).not.toBeNull();
    expect(surface.querySelector('[data-run-block-id="tool-1"]')).toBeNull();
    expect(
      [...surface.querySelectorAll("[data-run-block-kind]")].map((element) =>
        element.getAttribute("data-run-block-kind"),
      ),
    ).toEqual(["response", "tool_batch", "response"]);
    expect(surface.querySelector('[data-run-block-id="response-1"]')).toBe(firstResponse);

    view.rerender(
      <Surface
        items={finalItems.map((item) =>
          item.kind === "response" ? { ...item, streaming: false } : item,
        )}
        content="我先检查。处理完成"
        busy={false}
      />,
    );
    expect(surface.querySelector('[data-run-block-id="response-1"]')).toBe(firstResponse);
    expect(surface.querySelector('[data-run-block-id="tool-1"]')).toBeNull();
  });

  it("shows persisted 已工作 duration on the last completed tool batch", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });

    const items: AgentActivityItem[] = [
      {
        id: "tool-1",
        kind: "tool",
        toolCallId: "call-1",
        toolName: "ReadPresentationSnapshot",
        status: "completed",
      },
      {
        id: "response-1",
        kind: "response",
        start: 0,
        end: 4,
      },
    ];

    render(<AgentRunTimeline documentId="test-run" items={items} content="完成了。" live={false} durationMs={12_400} />);

    expect(screen.getByText("已工作 12 秒")).not.toBeNull();
  });

  it("uses the active tool as the primary loading message", () => {
    const trace: AgentActivityItem[] = [
      {
        id: "tool-1",
        kind: "tool",
        toolCallId: "call-1",
        toolName: "ReadPresentationSnapshot",
        status: "running",
      },
    ];

    expect(deriveAgentRunPresentation("tool", trace)).toEqual({
      phase: "tool",
      label: "正在读取演示文稿…",
      animated: true,
    });
  });

  it.each(["requesting", "thinking", "working"] as const)(
    "shows run status with glyph and shimmer during a %s gap",
    (phase) => {
      render(<RunStatusIndicator phase={phase} activityTrace={[]} />);

      expect(document.querySelector(".loading-indicator--sm")).not.toBeNull();
      expect(document.querySelectorAll(".agent-run-status--shimmer")).toHaveLength(1);
      expect(screen.getByRole("status").textContent).toBeTruthy();
    },
  );

  it("keeps timeline thought separate while dock status owns the step copy", () => {
    render(
      <div data-testid="surface">
        <AgentRunTimeline
          documentId="test-run"
          content=""
          live
          items={[
            {
              id: "reason-1",
              kind: "reasoning",
              content: "",
              streaming: true,
            },
          ]}
        />
        <RunStatusIndicator
          phase="thinking"
          activityTrace={[
            {
              id: "reason-1",
              kind: "reasoning",
              content: "",
              streaming: true,
            },
          ]}
        />
      </div>,
    );

    const surface = screen.getByTestId("surface");
    expect(surface.querySelector(".process-trace-panel")).toBeNull();
    expect(surface.querySelector('[data-run-block-kind="thought"]')).not.toBeNull();
    expect(surface.querySelector(".loading-indicator--sm")).not.toBeNull();
    expect(surface.querySelectorAll(".agent-run-status--shimmer")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("正在思考页面内容");
  });

  it("final text round collapses prior tool_batch", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });

    const tools: AgentActivityItem[] = [
      {
        id: "tool-1",
        kind: "tool",
        toolCallId: "call-1",
        toolName: "ReadFile",
        status: "completed",
      },
      {
        id: "tool-2",
        kind: "tool",
        toolCallId: "call-2",
        toolName: "WriteFile",
        status: "completed",
      },
    ];

    const view = render(<AgentRunTimeline documentId="test-run" content="" live items={tools} />);
    expect(document.querySelector('[data-run-block-id="tool-1"]')).not.toBeNull();

    view.rerender(
      <AgentRunTimeline
        documentId="test-run"
        content="本轮已完成：已写入设计规格与页面计划。"
        live
        items={[
          ...tools,
          {
            id: "response-final",
            kind: "response",
            start: 0,
            end: 20,
            streaming: false,
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "展开执行过程" })).not.toBeNull();
    expect(document.querySelector('[data-run-block-id="tool-1"]')).toBeNull();
    expect(document.querySelector('[data-run-block-id="response-final"]')).not.toBeNull();
    expect(document.body.textContent).toContain("本轮已完成");
  });

  it("run end without trailing response still collapses (!live)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });

    const tools: AgentActivityItem[] = [
      {
        id: "tool-1",
        kind: "tool",
        toolCallId: "call-1",
        toolName: "PreviewSlide",
        status: "completed",
      },
      {
        id: "tool-2",
        kind: "tool",
        toolCallId: "call-2",
        toolName: "PreviewSlide",
        status: "completed",
      },
    ];

    const view = render(<AgentRunTimeline documentId="test-run" content="" live items={tools} />);
    expect(document.querySelector('[data-run-block-id="tool-1"]')).not.toBeNull();

    view.rerender(<AgentRunTimeline documentId="test-run" content="" live={false} items={tools} />);

    expect(screen.getByRole("button", { name: "展开执行过程" })).not.toBeNull();
    expect(document.querySelector('[data-run-block-id="tool-1"]')).toBeNull();
    expect(screen.getByRole("button", { name: "展开执行过程" }).textContent).toContain("检查 2 次");
  });

  it("pinned batch survives final round", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });

    const completedTools: AgentActivityItem[] = [
      {
        id: "preview-1",
        kind: "tool",
        toolCallId: "preview-call-1",
        toolName: "PreviewSlide",
        status: "completed",
      },
      {
        id: "preview-2",
        kind: "tool",
        toolCallId: "preview-call-2",
        toolName: "PreviewSlide",
        status: "completed",
      },
    ];

    const view = render(<AgentRunTimeline documentId="test-run" content="" live items={completedTools} />);
    expect(document.querySelector('[data-run-block-id="preview-1"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "收起执行过程" }));
    fireEvent.click(screen.getByRole("button", { name: "展开执行过程" }));
    expect(document.querySelector('[data-run-block-id="preview-1"]')).not.toBeNull();

    view.rerender(
      <AgentRunTimeline
        documentId="test-run"
        content="任务总结：导出已提交审批。"
        live={false}
        items={[
          ...completedTools,
          {
            id: "response-1",
            kind: "response",
            start: 0,
            end: 14,
          },
        ]}
      />,
    );
    expect(document.querySelector('[data-run-block-id="preview-1"]')).not.toBeNull();
    expect(document.querySelector('[data-run-block-id="response-1"]')).not.toBeNull();
  });

  it("groups thought into the following tool batch panel", () => {
    render(
      <AgentRunTimeline
        documentId="test-run"
        content=""
        live
        items={[
          {
            id: "reason-1",
            kind: "reasoning",
            content: "分析需求",
            streaming: false,
          },
          {
            id: "tool-1",
            kind: "tool",
            toolCallId: "c1",
            toolName: "ReadFile",
            status: "running",
          },
        ]}
      />,
    );

    expect(document.querySelector(".agent-run-block--thought")).toBeNull();
    expect(document.querySelector('[data-run-block-kind="tool_batch"]')).not.toBeNull();
    expect(document.querySelector(".process-trace-panel")).not.toBeNull();
    expect(
      document.querySelector('.process-trace-panel [data-run-block-kind="thought"]'),
    ).not.toBeNull();
    expect(document.querySelector(".process-trace-panel")?.textContent).toContain("思考");
  });

  it("turns permission waiting into a static glyph instead of a shimmer", () => {
    render(
      <RunStatusIndicator
        phase="waiting"
        activityTrace={[
          {
            id: "tool-awaiting-approval",
            kind: "tool",
            toolCallId: "call-awaiting-approval",
            toolName: "ExecuteCommand",
            status: "running",
          },
        ]}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("等待你的确认");
    expect(document.querySelector(".loading-indicator--paused")).not.toBeNull();
    expect(document.querySelector(".agent-run-status--paused")).not.toBeNull();
    expect(document.querySelector(".agent-run-status--shimmer")).toBeNull();
  });

  it("renders independent running pulse and failure state for same-name tool calls", () => {
    const rows = buildProcessTraceRows(
      [
        {
          id: "tool-a",
          kind: "tool",
          toolCallId: "call-a",
          toolName: "ReadPresentationSnapshot",
          status: "running",
        },
        {
          id: "tool-b",
          kind: "tool",
          toolCallId: "call-b",
          toolName: "ReadPresentationSnapshot",
          status: "failed",
        },
      ],
      true,
    );

    const running = render(<ProcessTraceItem row={rows[0]!} />);
    expect(running.container.querySelector(".process-trace-row-status--running")).not.toBeNull();
    expect(running.container.querySelector(".process-trace-row-tool-icon--read")).not.toBeNull();
    expect(running.container.textContent).toContain("正在读取演示文稿");
    running.unmount();

    const failed = render(<ProcessTraceItem row={rows[1]!} />);
    expect(failed.container.querySelector(".process-trace-row-status--failed")).not.toBeNull();
    expect(failed.container.textContent).toContain("读取演示文稿未完成");
    expect(failed.container.textContent).not.toContain("ReadPresentationSnapshot");
  });

  it("maps tool categories and terminal status glyphs into distinct class names", () => {
    const rows = buildProcessTraceRows(
      [
        {
          id: "tool-search",
          kind: "tool",
          toolCallId: "call-search",
          toolName: "WebSearch",
          status: "completed",
        },
        {
          id: "tool-change",
          kind: "tool",
          toolCallId: "call-change",
          toolName: "WriteFile",
          status: "failed",
        },
        {
          id: "tool-denied",
          kind: "tool",
          toolCallId: "call-denied",
          toolName: "EditFile",
          status: "denied",
        },
      ],
      false,
    );

    expect(rows.map((row) => row.toolCategory)).toEqual(["search", "change", "change"]);

    const search = render(<ProcessTraceItem row={rows[0]!} />);
    expect(
      search.container.querySelector(
        ".process-trace-row-status--completed .process-trace-row-tool-icon--search",
      ),
    ).not.toBeNull();
    expect(search.container.querySelector(".process-trace-row-status-glyph")).toBeNull();
    expect(search.container.textContent).not.toMatch(/[✓!]/);
    search.unmount();

    const change = render(<ProcessTraceItem row={rows[1]!} />);
    expect(
      change.container.querySelector(
        ".process-trace-row-status--failed .process-trace-row-tool-icon--change",
      ),
    ).not.toBeNull();
    expect(change.container.textContent).not.toMatch(/[✓!]/);
    change.unmount();

    const denied = render(<ProcessTraceItem row={rows[2]!} />);
    expect(
      denied.container.querySelector(
        ".process-trace-row-status--denied .process-trace-row-tool-icon--change",
      ),
    ).not.toBeNull();
    expect(denied.container.querySelector(".process-trace-row-status--failed")).toBeNull();
    expect(denied.container.textContent).not.toMatch(/[✓!]/);
  });

  it("exposes one keyboard target for an expandable trace row", () => {
    render(
      <ProcessTraceItem
        row={{
          id: "thought-1",
          kind: "thought",
          title: "查看思考过程",
          content: "正在分析页面结构",
          active: false,
        }}
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button").textContent).toContain("查看思考过程");
  });

  it("collapses adjacent completed tools into one disclosure", () => {
    render(
      <AgentRunTimeline
        documentId="test-run"
        content=""
        items={[
          {
            id: "preview-1",
            kind: "tool",
            toolCallId: "preview-call-1",
            toolName: "PreviewSlide",
            status: "completed",
          },
          {
            id: "preview-2",
            kind: "tool",
            toolCallId: "preview-call-2",
            toolName: "PreviewSlide",
            status: "completed",
          },
        ]}
      />,
    );

    const disclosure = screen.getByRole("button", { name: "展开执行过程" });
    expect(disclosure.textContent).toContain("检查 2 次");
    expect(document.querySelector('[data-run-block-id="preview-1"]')).toBeNull();

    fireEvent.click(disclosure);
    expect(document.querySelector('[data-run-block-id="preview-1"]')).not.toBeNull();
    expect(document.querySelector('[data-run-block-id="preview-2"]')).not.toBeNull();
  });

  it("does not duplicate a task activity already represented by the task panel", () => {
    const graphTask: AgentTaskNode = {
      id: "layout-task",
      revision: 1,
      subject: "生成排版计划",
      description: "为每页选择版式",
      status: "in_progress",
      routing: { executionTarget: "teammate" },
      completionPolicy: "review_required",
      owner: "layout_planner",
      blocks: [],
      blockedBy: [],
      review: { state: "none" },
      reviewReceipts: [],
    };

    render(
      <AgentRunTimeline
        documentId="test-run"
        content=""
        live
        teamGraphTasks={[graphTask]}
        items={[
          {
            id: "layout-activity",
            kind: "task",
            taskId: "layout-task",
            taskListId: "layout-task",
            agentName: "layout_planner",
            description: graphTask.description,
            status: "running",
            steps: [],
          },
        ]}
      />,
    );

    expect(document.querySelector('[data-run-block-kind="task"]')).toBeNull();
    expect(document.querySelector(".team-session-card")).toBeNull();
  });

  it("renders interrupted and failed outcomes outside assistant transcript text", () => {
    const interrupted = render(<AgentRunTerminalNotice status="interrupted" />);
    expect(interrupted.getByRole("status").textContent).toBe("会话已中断");
    interrupted.unmount();

    render(
      <AgentRunTerminalNotice
        status="failed"
        error="模型服务暂时不可用"
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("本次处理未完成");
    expect(screen.getByRole("status").textContent).toContain("模型服务暂时不可用");
    expect(screen.getByRole("button", { name: "重试" })).not.toBeNull();
  });
});
