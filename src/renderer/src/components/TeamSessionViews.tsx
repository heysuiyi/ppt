import type { TeamSessionProjection, TeamSessionStatus } from "@shared/team-session";
import type React from "react";
import { ProcessRecord } from "./run-process/ProcessRecord";

const STATUS_COPY: Record<TeamSessionStatus, string> = {
  running: "进行中",
  completed: "已完成",
  error: "执行失败",
  cancelled: "已取消",
};

function TeamStatusMark({ status }: { status: TeamSessionStatus }) {
  if (status === "running") {
    return (
      <span className="run-status-pulse team-session-status-spinner" aria-hidden="true">
        <i />
      </span>
    );
  }
  const glyph = status === "completed" ? "✓" : status === "error" ? "!" : "×";
  return (
    <span
      className={`team-session-status-mark team-session-status-mark--${status}`}
      aria-hidden="true"
    >
      {glyph}
    </span>
  );
}

export const FocusedTeamSession: React.FC<{ session: TeamSessionProjection }> = ({ session }) => (
  <section className="focused-team-session" aria-labelledby="focused-team-session-title">
    <header className={`focused-team-session-hero focused-team-session-hero--${session.status}`}>
      <div className="focused-team-session-status">
        <TeamStatusMark status={session.status} />
        <span>{STATUS_COPY[session.status]}</span>
      </div>
      <h2 id="focused-team-session-title">{session.title}</h2>
      <p>{session.currentActivity}</p>
      <div className="focused-team-session-meta">
        <span>{session.toolCount} 次操作</span>
        <span>{session.stepCount} 条事件</span>
      </div>
    </header>
    <div className="focused-team-session-stream">
      <div className="focused-team-session-stream-heading">
        <span>执行记录</span>
        {session.status === "running" && (
          <span className="focused-team-session-live">实时更新</span>
        )}
      </div>
      {session.activity.steps.length > 0 ? (
        <ProcessRecord items={[session.activity]} live={session.status === "running"} />
      ) : (
        <div className="focused-team-session-empty">任务正在初始化，事件到达后会在这里显示。</div>
      )}
    </div>
  </section>
);
