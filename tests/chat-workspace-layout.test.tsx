// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChatWorkspace,
  type ChatWorkspaceProps,
} from "../src/renderer/src/components/ChatWorkspace";
import {
  clearAllDisplayCardManagers,
  ingestDisplayEvent,
  setDisplayCardStatus,
} from "../src/shared/cards/display-card-managers";

afterEach(() => {
  cleanup();
  clearAllDisplayCardManagers();
});

function workspaceProps(isNewChat: boolean): ChatWorkspaceProps {
  return {
    session: {
      id: isNewChat ? "" : "session-1",
      conversationTitle: isNewChat ? undefined : "季度复盘",
      messages: isNewChat ? [] : [{ id: "user-1", role: "user", content: "季度复盘" }],
    },
    run: {
      activityTrace: [],
      phase: "idle",
      busy: false,
    },
    composer: {
      request: "",
      onChangeRequest: vi.fn(),
      onSubmitRequest: vi.fn(),
      models: [],
      selectedModelId: "",
      onSelectModel: vi.fn(),
      workspacePath: "",
      onPrepareWorkspace: vi.fn(),
      onProposePrompt: vi.fn(),
    },
    deck: {
      isMirrorOpen: false,
      onToggleMirror: vi.fn(),
      onOpenPreview: vi.fn(),
      onExport: vi.fn(),
    },
    actions: {
      onResolveApproval: vi.fn(),
      onResolvePatch: vi.fn(),
      onResolveQuestion: vi.fn(),
      onReviseOutline: vi.fn(),
      onUpdateMessageContent: vi.fn(),
      notify: vi.fn(),
    },
  };
}

describe("ChatWorkspace layouts", () => {
  it("keeps one focused input through welcome, entering and session creation", () => {
    const props = workspaceProps(true);
    props.composer.request = "准备发送";
    const { rerender } = render(<ChatWorkspace {...props} />);
    const input = screen.getByRole("combobox", { name: "向演示文稿 Agent 输入指令" });
    expect(document.activeElement).toBe(input);

    props.run = { ...props.run, busy: true, activeRunId: "run-1", onCancel: vi.fn() };
    props.session.messages = [{ id: "user-1", role: "user", content: "准备发送" }];
    rerender(<ChatWorkspace {...props} />);
    expect(screen.getByRole("combobox", { name: "向演示文稿 Agent 输入指令" })).toBe(input);
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByRole("button", { name: "中止当前 Agent 会话" }));
    expect(props.run.onCancel).toHaveBeenCalledTimes(1);

    props.session.id = "created-session";
    rerender(<ChatWorkspace {...props} />);
    expect(screen.getByRole("combobox", { name: "向演示文稿 Agent 输入指令" })).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("combobox", { name: "向演示文稿 Agent 输入指令" })).toHaveLength(1);
  });

  it("returns to welcome after creation failure without replacing or clearing the input", () => {
    const props = workspaceProps(true);
    props.composer.request = "保留失败草稿";
    props.run.busy = true;
    props.session.messages = [{ id: "optimistic", role: "user", content: "保留失败草稿" }];
    const { rerender } = render(<ChatWorkspace {...props} />);
    const input = screen.getByRole("combobox", { name: "向演示文稿 Agent 输入指令" });
    props.run.busy = false;
    rerender(<ChatWorkspace {...props} />);
    expect(screen.getByRole("combobox", { name: "向演示文稿 Agent 输入指令" })).toBe(input);
    expect(input.textContent).toBe("保留失败草稿");
    expect(input.hasAttribute("readonly")).toBe(false);
  });

  it("shows welcome for a bound empty session, hides slash commands and protects the directory", () => {
    const props = workspaceProps(true);
    props.session.id = "empty-session";
    props.composer.workspacePath = "e:/reports";
    props.composer.request = "/";
    const { rerender } = render(<ChatWorkspace {...props} />);
    expect(screen.getByText("已绑定目录")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更换" })).toBeNull();
    expect(screen.queryByRole("listbox", { name: "提示词模板" })).toBeNull();

    props.session.messages = [{ id: "user-1", role: "user", content: "开始" }];
    rerender(<ChatWorkspace {...props} />);
    expect(screen.getByRole("listbox", { name: "提示词模板" })).toBeTruthy();
    expect(screen.queryByText("已绑定目录")).toBeNull();
  });

  it("locks controls while switching and derives the target layout when the switch finishes", () => {
    const props = workspaceProps(false);
    props.session.isSwitching = true;
    const { rerender } = render(<ChatWorkspace {...props} />);
    const input = screen.getByRole("combobox", { name: "向演示文稿 Agent 输入指令" });
    expect(input.hasAttribute("readonly")).toBe(true);
    props.session = { id: "empty-target", messages: [] };
    props.composer.request = "恢复目标草稿";
    rerender(<ChatWorkspace {...props} />);
    expect(screen.getByRole("combobox", { name: "向演示文稿 Agent 输入指令" })).toBe(input);
    expect(input.hasAttribute("readonly")).toBe(false);
    expect(input.textContent).toBe("恢复目标草稿");
  });

  it("keeps team focus and approval navigation under the region owner, resetting focus on session change", () => {
    const props = workspaceProps(false);
    props.run.activeRunId = "run-1";
    props.run.activityTrace = [
      {
        id: "trace-1",
        kind: "task",
        taskId: "task-1",
        taskListId: "task-1",
        agentName: "writer",
        description: "起草大纲",
        status: "running",
        steps: [],
      },
    ];
    props.actions.onResolveToolApproval = vi.fn();
    ingestDisplayEvent({
      protocolVersion: 1,
      eventId: "plan-1",
      emittedAt: "2026-09-18T00:00:00Z",
      kind: "progress.task-list-updated",
      category: "progress",
      source: { kind: "tool", toolName: "TaskList" },
      scope: { sessionId: "session-1", runId: "run-1" },
      semantics: { blocking: false, requiresResponse: false, priority: "normal" },
      payload: {
        tasks: [
          {
            id: "task-1",
            revision: 0,
            subject: "起草大纲",
            description: "",
            status: "in_progress",
            routing: { executionTarget: "teammate" },
            completionPolicy: "review_required",
            owner: "writer",
            blocks: [],
            blockedBy: [],
            review: { state: "none" },
            reviewReceipts: [],
          },
        ],
      },
    });
    const { container, rerender } = render(<ChatWorkspace {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /起草大纲/ }));
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(container.querySelector(".focused-team-session")).not.toBeNull();

    act(() =>
      ingestDisplayEvent({
        protocolVersion: 1,
        eventId: "permission-1",
        emittedAt: "2026-09-18T00:00:00Z",
        kind: "permission.tool-requested",
        category: "permission",
        source: { kind: "tool", toolName: "ExportPptx" },
        scope: { sessionId: "session-1", runId: "run-1" },
        semantics: { blocking: true, requiresResponse: true, priority: "critical" },
        payload: {
          approvalId: "approval-1",
          toolName: "ExportPptx",
          reason: "写入文件",
          detail: "out.pptx",
        },
      }),
    );
    expect(screen.getAllByRole("region", { name: "需要你的授权" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /写入文件/ }));
    expect(container.querySelector(".focused-team-session")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "允许继续" }));
    expect(props.actions.onResolveToolApproval).toHaveBeenCalledWith("approval-1", true);
    act(() => {
      setDisplayCardStatus("permission-1", "resolved");
    });
    expect(container.querySelector(".focused-team-session")).not.toBeNull();

    props.session = {
      id: "session-2",
      messages: [{ id: "user-2", role: "user", content: "另一个会话" }],
    };
    props.run.activityTrace = [];
    rerender(<ChatWorkspace {...props} />);
    expect(container.querySelector(".focused-team-session")).toBeNull();
    expect(screen.getByText("另一个会话")).toBeTruthy();
  });
});
