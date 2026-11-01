// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskPlanCard } from "../app/renderer/src/components/TaskPlanCard";
import type { AgentTaskNode } from "../src/shared/agent-task-list";
import type { TeamSessionProjection } from "../src/shared/team-session";

afterEach(cleanup);

const task: AgentTaskNode = {
  id: "1",
  revision: 1,
  subject: "生成排版计划 layout-plan",
  description: "为每页选择合适版式",
  status: "in_progress",
  routing: { executionTarget: "teammate" },
  completionPolicy: "review_required",
  owner: "layout_planner",
  blocks: [],
  blockedBy: [],
  review: { state: "none" },
  reviewReceipts: [],
};

const session: TeamSessionProjection = {
  id: "1",
  taskListId: "1",
  agentName: "layout_planner",
  title: task.subject,
  currentActivity: "正在分析任务上下文…",
  status: "running",
  toolCount: 11,
  stepCount: 16,
  activity: {
    id: "task-activity-1",
    kind: "task",
    taskId: "1",
    taskListId: "1",
    agentName: "layout_planner",
    description: task.description,
    status: "running",
    steps: [],
  },
};

describe("TaskPlanCard", () => {
  it("merges task and execution activity into one compact summary", () => {
    render(<TaskPlanCard tasks={[task]} sessions={[session]} live />);

    expect(screen.getByText(task.subject)).not.toBeNull();
    expect(screen.getByText("正在分析任务上下文…")).not.toBeNull();
    expect(screen.getByLabelText("任务完成进度").textContent).toContain("0/1");
    expect(screen.queryByText("layout_planner")).toBeNull();
    expect(screen.queryByText(/Lead/)).toBeNull();
    expect(screen.queryByText(/工具操作/)).toBeNull();
    expect(screen.queryByRole("button", { name: "详情" })).toBeNull();
  });

  it("reveals task rows and opens the existing detail view on demand", () => {
    const onOpenTask = vi.fn();
    render(
      <TaskPlanCard
        goal="完成整套演示"
        tasks={[task]}
        sessions={[session]}
        live
        onOpenTask={onOpenTask}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /生成排版计划/ }));
    expect(screen.getByText("完成整套演示")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(onOpenTask).toHaveBeenCalledWith("1");
  });
});
