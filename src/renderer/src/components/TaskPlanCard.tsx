import type { AgentTaskNode } from "@shared/agent-task-list";
import type { TeamSessionProjection } from "@shared/team-session";
import type React from "react";
import { useMemo, useState } from "react";
import { Button } from "./Button";
import { ChevronDownIcon, ChevronRightIcon } from "./Icons";
import { useChatFold } from "./useChatFold";

function TaskStatusIcon({ task }: { task: AgentTaskNode }) {
  if (task.review.state === "requested")
    return (
      <span className="task-plan-icon review-requested" aria-hidden="true">
        ◇
      </span>
    );
  const { status } = task;
  if (status === "completed")
    return (
      <span className="task-plan-icon done" aria-hidden="true">
        ✓
      </span>
    );
  if (status === "in_progress") {
    return (
      <span className="run-status-pulse task-plan-spinner" aria-hidden="true">
        <i />
      </span>
    );
  }
  return (
    <span className="task-plan-icon pending" aria-hidden="true">
      ○
    </span>
  );
}

interface TaskPlanCardProps {
  goal?: string | null;
  tasks: AgentTaskNode[];
  sessions?: TeamSessionProjection[];
  live?: boolean;
  state?: "open" | "closed" | "archived";
  archive?: { outcome: "completed" | "abandoned"; reason?: string };
  onOpenTask?: (sessionId: string) => void;
}

export const TaskPlanCard: React.FC<TaskPlanCardProps> = ({
  goal,
  tasks,
  sessions = [],
  live = false,
  state = "open",
  archive,
  onOpenTask,
}) => {
  const [expanded, setExpanded] = useState(false);
  const { anchorRef: headerRef, transactFold } = useChatFold<HTMLButtonElement>();

  const toggleExpanded = () => {
    transactFold(() => setExpanded((value) => !value));
  };

  const hasActive = tasks.some(
    (task) => task.status === "in_progress" || task.review.state === "requested",
  );
  const sessionByTaskId = useMemo(() => {
    const result = new Map<string, TeamSessionProjection>();
    for (const session of sessions) {
      result.set(session.taskListId ?? session.id, session);
    }
    return result;
  }, [sessions]);
  const currentTask =
    tasks.find((task) => task.review.state === "requested") ??
    tasks.find((task) => task.status === "in_progress") ??
    tasks.find((task) => task.status === "pending") ??
    tasks.at(-1);
  const currentSession = currentTask ? sessionByTaskId.get(currentTask.id) : undefined;
  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const summaryTitle =
    state === "archived"
      ? archive?.outcome === "abandoned"
        ? "任务已结束"
        : "任务已完成"
      : currentTask?.review.state === "requested"
        ? `待验收 · ${currentTask.subject}`
        : currentTask?.status === "in_progress"
          ? currentTask.subject
          : currentTask?.status === "pending"
            ? `等待执行 · ${currentTask.subject}`
            : "任务进度";
  const summaryActivity =
    currentSession?.currentActivity ??
    (currentTask?.review.state === "requested"
      ? "结果已提交，正在等待验收"
      : currentTask?.status === "in_progress"
        ? "正在处理…"
        : currentTask?.status === "pending"
          ? "将在前置任务完成后开始"
          : undefined);

  if (tasks.length === 0) return null;

  return (
    <section
      className={`task-plan-card${hasActive && live ? " task-plan-card--active" : ""}`}
      aria-label="任务进度"
    >
      <button
        ref={headerRef}
        type="button"
        className="task-plan-card-header"
        onClick={toggleExpanded}
        aria-expanded={expanded}
      >
        {currentTask && <TaskStatusIcon task={currentTask} />}
        <span className="task-plan-card-summary">
          <span className="task-plan-card-title">{summaryTitle}</span>
          {summaryActivity && <span className="task-plan-card-activity">{summaryActivity}</span>}
        </span>
        <span className="task-plan-card-position" aria-label="任务完成进度">
          {state === "archived" && archive?.outcome === "abandoned"
            ? "已放弃"
            : state === "archived"
              ? "全部完成"
              : `${completedCount}/${tasks.length} 已完成`}
        </span>
        {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
      </button>
      {expanded && (
        <div className="task-plan-card-body">
          {goal && (
            <div className="task-plan-card-goal">
              <span className="task-plan-card-goal-label">目标</span>
              <p className="task-plan-card-goal-text">{goal}</p>
            </div>
          )}
          {tasks.length > 0 && (
            <ul className="task-plan-list">
              {tasks.map((task) => {
                const session = sessionByTaskId.get(task.id);
                const taskState =
                  task.review.state === "requested"
                    ? "等待验收"
                    : task.status === "completed"
                      ? "已完成"
                      : task.status === "in_progress"
                        ? (session?.currentActivity ?? "正在处理…")
                        : "等待执行";
                return (
                  <li
                    key={task.id}
                    className={`task-plan-item task-plan-item--${
                      task.review.state === "requested" ? "review-requested" : task.status
                    }`}
                  >
                    <TaskStatusIcon task={task} />
                    <span className="task-plan-item-copy">
                      <span className="task-plan-item-title">{task.subject}</span>
                      <span className="task-plan-item-state">{taskState}</span>
                    </span>
                    {session && onOpenTask && (
                      <Button variant="quiet" size="sm" onClick={() => onOpenTask(session.id)}>
                        详情
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};
