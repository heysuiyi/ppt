// @vitest-environment jsdom

import type { AgentActivityItem } from "@shared/agent-activity";
import { deriveAgentRunPresentation } from "@shared/agent-run-presentation";
import type { AgentTaskNode } from "@shared/agent-task-list";
import { projectTeamSession } from "@shared/team-session";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunTerminalNotice } from "../src/renderer/src/components/AgentRunTerminalNotice";
import { RunStatusIndicator } from "../src/renderer/src/components/RunStatusIndicator";
import { RunDuration } from "../src/renderer/src/components/run-process/RunDuration";
import { RunTimeline } from "../src/renderer/src/components/run-process/RunTimeline";
import { FocusedTeamSession } from "../src/renderer/src/components/TeamSessionViews";

const thought: Extract<AgentActivityItem, { kind: "reasoning" }> = {
  id: "thought-1",
  kind: "reasoning",
  content: "先核对模板与页面结构。",
  streaming: true,
};
const tool: Extract<AgentActivityItem, { kind: "tool" }> = {
  id: "tool-1",
  kind: "tool",
  toolCallId: "call-1",
  toolName: "ReadFile",
  status: "running",
};
const response: Extract<AgentActivityItem, { kind: "response" }> = {
  id: "response-1",
  kind: "response",
  start: 0,
  end: 5,
};

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => Object.assign(new EventTarget(), { matches: true })),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function disclosure() {
  return screen.getByRole("button", { expanded: true });
}

describe("run process disclosure", () => {
  it.each([true, false])(
    "retains visible response text and selection when its trace arrives with live=%s",
    (live) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => Object.assign(new EventTarget(), { matches: false })),
      );
      const content = "Already selected reply.";
      const view = render(
        <RunTimeline documentId="late-trace" items={[]} content={content} live />,
      );
      act(() => vi.advanceTimersByTime(10_000));
      const host = view.container.querySelector(".markdown-body")!;
      const paragraph = host.querySelector("p")!;
      const anchor = host.parentElement;
      const selection = document.getSelection()!;
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 8);
      range.setEnd(paragraph.firstChild!, 16);
      selection.addRange(range);

      view.rerender(
        <RunTimeline documentId="late-trace" items={[thought]} content={content} live />,
      );
      expect(view.container.querySelector(".assistant-response")).toBe(host);
      expect(host.textContent).toBe(content);
      const traceResponse: AgentActivityItem = {
        id: "late-response",
        kind: "response",
        start: 0,
        end: content.length,
        streaming: live,
      };
      view.rerender(
        <RunTimeline
          documentId="late-trace"
          items={[thought, traceResponse]}
          content={content}
          live={live}
        />,
      );

      expect(view.container.querySelector(".assistant-response")).toBe(host);
      expect(host.querySelector("p")).toBe(paragraph);
      expect(host.parentElement).toBe(anchor);
      expect(host.textContent).toBe(content);
      expect(selection.toString()).toBe("selected");
      expect(host.closest("[data-run-block-id]")?.getAttribute("data-run-block-id")).toBe(
        "late-response",
      );
      act(() => vi.advanceTimersByTime(10_000));
      expect(host.textContent).toBe(content);
      expect(selection.toString()).toBe("selected");
      selection.removeAllRanges();
    },
  );

  it("continues an in-flight provisional response instead of replaying its released prefix", () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => Object.assign(new EventTarget(), { matches: false })),
    );
    const content = "A long live reply that is still being released to the reader. ".repeat(10);
    const view = render(<RunTimeline documentId="in-flight" items={[]} content={content} live />);
    act(() => vi.advanceTimersByTime(120));
    const host = view.container.querySelector(".markdown-body")!;
    const released = host.textContent!;
    expect(released.length).toBeGreaterThan(0);
    expect(released.length).toBeLessThan(content.length);

    view.rerender(
      <RunTimeline
        documentId="in-flight"
        items={[{ id: "response", kind: "response", start: 0, end: content.length }]}
        content={content}
      />,
    );

    expect(view.container.querySelector(".markdown-body")).toBe(host);
    expect(host.textContent).toBe(released);
    act(() => vi.advanceTimersByTime(30_000));
    expect(host.textContent).toBe(content.trimEnd());
  });

  it("closes completed process work when provisional response content appears, not at trace handoff", () => {
    const completedThought = { ...thought, streaming: false };
    const content = "The visible response is already here.";
    const view = render(
      <RunTimeline
        documentId="provisional-disclosure"
        items={[completedThought]}
        content=""
        live
      />,
    );
    const entrance = disclosure();
    expect(screen.getByText(thought.content)).not.toBeNull();

    view.rerender(
      <RunTimeline
        documentId="provisional-disclosure"
        items={[completedThought]}
        content={content}
        live
      />,
    );
    expect(screen.getByRole("button", { expanded: false })).toBe(entrance);
    expect(screen.queryByText(thought.content)).toBeNull();
    const host = view.container.querySelector(".assistant-response");

    view.rerender(
      <RunTimeline
        documentId="provisional-disclosure"
        items={[
          completedThought,
          { id: "late-response", kind: "response", start: 0, end: content.length, streaming: true },
        ]}
        content={content}
        live
      />,
    );
    expect(screen.getByRole("button", { expanded: false })).toBe(entrance);
    expect(view.container.querySelector(".assistant-response")).toBe(host);
    expect(screen.queryByText(thought.content)).toBeNull();
  });

  it("opens reasoning with one click and keeps the same entrance when tools arrive", () => {
    const view = render(
      <RunTimeline documentId="run" items={[{ ...thought, streaming: false }]} content="" />,
    );
    expect(screen.queryByText(thought.content)).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    const entrance = disclosure();
    expect(screen.getByText(thought.content)).not.toBeNull();
    expect(screen.getAllByRole("button")).toEqual([entrance]);

    view.rerender(<RunTimeline documentId="run" items={[thought, tool]} content="" live />);
    expect(disclosure()).toBe(entrance);
    expect(screen.getByText(thought.content)).not.toBeNull();
    expect(screen.getAllByRole("button")).toEqual([entrance]);
  });

  it("automatically closes completed work when a later response starts, preserving reply order", () => {
    const initial: AgentActivityItem[] = [response, tool];
    const view = render(<RunTimeline documentId="run" items={initial} content="先检查文件" live />);
    const firstReply = document.querySelector('[data-run-block-id="response-1"]');
    expect(disclosure()).not.toBeNull();
    const finalItems: AgentActivityItem[] = [
      response,
      { ...tool, status: "completed" },
      {
        id: "response-2",
        kind: "response",
        start: 5,
        end: 9,
        streaming: true,
      },
    ];
    view.rerender(
      <RunTimeline documentId="run" items={finalItems} content="先检查文件检查完成" live />,
    );
    expect(screen.getByRole("button", { expanded: false })).not.toBeNull();
    expect(document.querySelector('[data-run-block-id="tool-1"]')).toBeNull();
    expect(document.querySelector('[data-run-block-id="response-1"]')).toBe(firstReply);
    const blocks = [...document.querySelectorAll('[data-run-block-kind="response"]')];
    expect(blocks.map((block) => block.getAttribute("data-run-block-id"))).toEqual([
      "response-1",
      "response-2",
    ]);
  });

  it.each([true, false])(
    "honors a user's open=%s choice through completion and more streamed work",
    (pinnedOpen) => {
      const view = render(<RunTimeline documentId="run" items={[thought]} content="" live />);
      fireEvent.click(disclosure());
      if (pinnedOpen) fireEvent.click(screen.getByRole("button", { expanded: false }));
      view.rerender(<RunTimeline documentId="run" items={[thought, tool]} content="" live />);
      expect(screen.getByRole("button", { expanded: pinnedOpen })).not.toBeNull();
      view.rerender(
        <RunTimeline
          documentId="run"
          items={[{ ...thought, streaming: false }, { ...tool, status: "completed" }, response]}
          content="已完成检查"
        />,
      );
      expect(screen.getByRole("button", { expanded: pinnedOpen })).not.toBeNull();
      expect(screen.queryByText(thought.content) !== null).toBe(pinnedOpen);
    },
  );

  it("retains long thought expansion after streaming stops and the section is reopened", () => {
    const longThought = { ...thought, content: `${"检查页面结构。".repeat(220)}末尾证据` };
    const view = render(<RunTimeline documentId="run" items={[longThought]} content="" live />);
    fireEvent.click(screen.getByRole("button", { name: "展开全文" }));
    expect(screen.getByText(longThought.content)).not.toBeNull();
    const entrance = screen.getByRole("button", { name: /收起.*过程/ });
    fireEvent.click(entrance);
    fireEvent.click(screen.getByRole("button", { name: /展开.*过程/ }));
    expect(screen.getByRole("button", { name: "收起全文" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    view.rerender(
      <RunTimeline
        documentId="run"
        items={[{ ...longThought, streaming: false }, response]}
        content="已完成检查"
      />,
    );
    expect(screen.getByRole("button", { name: "收起全文" })).not.toBeNull();
    expect(screen.getByText(longThought.content)).not.toBeNull();
  });

  it("does not render an empty disclosure for transient-only work or keep it after completion", () => {
    const status: AgentActivityItem = {
      id: "status",
      kind: "step",
      text: "正在连接模型",
      status: "running",
      transient: true,
    };
    const view = render(<RunTimeline documentId="run" items={[status]} content="" live />);
    expect(screen.getByText(status.text)).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(
      <RunTimeline documentId="run" items={[{ ...status, status: "done" }]} content="" />,
    );
    expect(screen.queryByText(status.text)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps a failure discoverable while its details are collapsed", () => {
    render(
      <RunTimeline
        documentId="run"
        items={[{ ...tool, status: "failed" }]}
        content=""
        runStatus="failed"
      />,
    );
    const entrance = screen.getByRole("button", { expanded: false });
    expect(entrance.textContent).toMatch(/未完成|失败/);
    fireEvent.click(entrance);
    expect(document.querySelector('[data-run-block-id="tool-1"]')?.textContent).toMatch(
      /未完成|失败/,
    );
  });

  it("resets user choices for a different message even when event IDs are reused", () => {
    const view = render(<RunTimeline documentId="run-a" items={[thought]} content="" live />);
    fireEvent.click(disclosure());
    view.rerender(<RunTimeline documentId="run-b" items={[thought]} content="" live />);
    expect(disclosure()).not.toBeNull();
    expect(screen.getByText(thought.content)).not.toBeNull();
  });

  it("does not repeat a task already shown by the task plan", () => {
    const graphTask: AgentTaskNode = {
      id: "task-1",
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
      <RunTimeline
        documentId="run"
        content=""
        live
        teamGraphTasks={[graphTask]}
        items={[
          {
            id: "task-event",
            kind: "task",
            taskId: "task-1",
            taskListId: "task-1",
            description: graphTask.description,
            status: "running",
            steps: [],
          },
        ]}
      />,
    );
    expect(screen.queryByText(graphTask.description)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows team records directly and lets teammate work outlive the lead run", () => {
    const task: Extract<AgentActivityItem, { kind: "task" }> = {
      id: "task-event",
      kind: "task",
      taskId: "task-1",
      description: "生成页面布局",
      status: "running",
      steps: [
        {
          id: "task-thought",
          type: "reasoning",
          text: "比较两种布局",
          status: "running",
          streaming: true,
        },
      ],
    };
    const view = render(<FocusedTeamSession session={projectTeamSession(task)} />);
    expect(screen.getByText("比较两种布局")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    view.unmount();
    render(
      <RunTimeline
        documentId="lead-finished"
        items={[task]}
        content=""
        live={false}
        runStatus="completed"
      />,
    );
    expect(screen.getByText("比较两种布局")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("message-level duration", () => {
  it("uses the authoritative start across remounts and switches to persisted terminal duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const view = render(<RunDuration live startedAt={8_000} />);
    expect(view.container.textContent).toContain("12 秒");
    act(() => vi.advanceTimersByTime(2_000));
    expect(view.container.textContent).toContain("14 秒");
    view.rerender(<RunDuration live={false} startedAt={8_000} durationMs={12_400} />);
    expect(view.container.textContent).toContain("12 秒");
    act(() => vi.advanceTimersByTime(10_000));
    expect(view.container.textContent).toContain("12 秒");
    view.rerender(<RunDuration live startedAt={31_000} />);
    expect(view.container.textContent).toContain("1 秒");
  });

  it("never invents a start time and represents a measured zero duration", () => {
    const view = render(<RunDuration live />);
    expect(view.container.textContent).toBe("");
    view.rerender(<RunDuration live={false} durationMs={0} />);
    expect(view.container.textContent).toContain("0 秒");
  });

  it("shows one duration for a reasoning-only run, outside all process sections", () => {
    const view = render(
      <RunTimeline
        documentId="run"
        items={[{ ...thought, streaming: false }]}
        content=""
        durationMs={10_000}
      />,
    );
    expect(screen.getAllByText(/10 秒/)).toHaveLength(1);
    const duration = screen.getByText(/10 秒/);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getAllByText(/10 秒/)).toEqual([duration]);
    expect(view.container.textContent).toContain(thought.content);
  });
});

describe("run status and outcomes", () => {
  it("prefers an actual running tool over a generic phase", () => {
    const presentation = deriveAgentRunPresentation("tool", [
      { ...tool, toolName: "ReadPresentationSnapshot" },
    ]);
    expect(presentation.phase).toBe("tool");
    expect(presentation.animated).toBe(true);
    expect(presentation.label).toContain("读取演示文稿");
  });

  it("shows permission waiting rather than claiming the tool is still executing", () => {
    render(<RunStatusIndicator phase="waiting" activityTrace={[tool]} />);
    expect(screen.getByRole("status").textContent).toContain("等待你的确认");
  });

  it("keeps interrupted and failed outcomes outside assistant transcript text", () => {
    const interrupted = render(<AgentRunTerminalNotice status="interrupted" />);
    expect(interrupted.getByRole("status").textContent).toContain("中断");
    interrupted.unmount();
    render(
      <AgentRunTerminalNotice
        status="failed"
        error="模型服务暂时不可用"
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("模型服务暂时不可用");
    expect(screen.getByRole("button", { name: "重试" })).not.toBeNull();
  });
});
