import { Fragment, useId, useMemo, useState } from "react";
import type { HarnessHistoryEntry, HarnessSnapshot } from "../../../shared/harness-ipc";
import { DesktopMessage } from "./DesktopMessage";
import { ToolResult, type ToolResultProps } from "./ToolResult";
import { getToolSummary } from "./tool-presentation";
import type { WorkspaceToolProgress, WorkspaceViewState } from "./workspace-controller";
import "./desktop-transcript.css";

type TranscriptEntry =
  | Exclude<HarnessHistoryEntry, { role: "tool" }>
  | { readonly role: "tool"; readonly tool: ToolResultProps };

interface TranscriptRow {
  readonly key: string;
  readonly entry: TranscriptEntry;
  readonly streaming?: boolean;
  readonly liveTool?: boolean;
}

interface TranscriptTurn {
  readonly key: string;
  readonly user?: TranscriptRow;
  readonly rows: TranscriptRow[];
}

const processLabels: Record<HarnessSnapshot["status"], string> = {
  idle: "执行过程",
  running: "正在处理",
  waiting: "等待你的确认",
  completed: "已完成",
  cancelled: "已停止",
  interrupted: "任务已中断",
  failed: "任务未完成",
};

function ProcessRows({
  rows,
  status,
}: {
  rows: readonly TranscriptRow[];
  status?: HarnessSnapshot["status"];
}) {
  const [open, setOpen] = useState(true);
  const [stepsOpen, setStepsOpen] = useState(true);
  const id = useId();
  const summaries = new Set<string>();
  for (const { entry } of rows) {
    if (entry.role !== "tool") continue;
    const state = entry.tool.status;
    summaries.add(
      state === "failed"
        ? "工具执行失败"
        : state === "unknown"
          ? "工具结果未知"
          : `${state === "dispatched" ? "正在" : "已"}${getToolSummary(entry.tool.name)}`,
    );
  }
  const summary = [...summaries].join("、") || "思考过程";
  const risks = rows.filter(
    ({ entry }) =>
      entry.role === "tool" &&
      (entry.tool.error || entry.tool.effects === "applied" || entry.tool.effects === "unknown"),
  );
  return (
    <section
      className="ui-workspace-message desktop-process"
      data-message-role="process"
      aria-label="执行过程"
    >
      <button
        type="button"
        className="desktop-process__heading"
        aria-label="执行过程"
        aria-expanded={open}
        aria-controls={`${id}-process`}
        onClick={() => setOpen(!open)}
      >
        <span>{status ? processLabels[status] : "执行过程"}</span>
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
          data-open={open}
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      <div
        id={`${id}-process`}
        className="desktop-process__content desktop-fold"
        hidden={!open}
        inert={!open}
        aria-hidden={!open}
      >
        <div className="desktop-fold__inner">
          <button
            type="button"
            className="desktop-process__summary"
            aria-label="过程步骤"
            aria-expanded={stepsOpen}
            aria-controls={`${id}-steps`}
            onClick={() => setStepsOpen(!stepsOpen)}
          >
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
              data-open={stepsOpen}
            >
              <path d="m4 6 4 4 4-4" />
            </svg>
            <span>{summary}</span>
          </button>
          <div
            id={`${id}-steps`}
            className="desktop-process__steps desktop-fold"
            hidden={!stepsOpen}
            inert={!stepsOpen}
            aria-hidden={!stepsOpen}
          >
            <div className="desktop-fold__inner desktop-process__step-list">
              {rows.map((row) => (
                <TranscriptMessage key={row.key} row={row} />
              ))}
            </div>
          </div>
        </div>
      </div>
      {(!open || !stepsOpen) && risks.length > 0 && (
        <div className="desktop-process__risks" aria-label="过程风险">
          {risks.map(
            ({ key, entry }) =>
              entry.role === "tool" && (
                <div key={key}>
                  {entry.tool.error && (
                    <p className="desktop-process__error">
                      {entry.tool.error.code}: {entry.tool.error.message}
                    </p>
                  )}
                  {entry.tool.effects === "applied" && <p>已产生外部影响；失败或取消不会撤销。</p>}
                  {entry.tool.effects === "unknown" && <p>外部影响未知；请勿直接重复执行。</p>}
                </div>
              ),
          )}
        </div>
      )}
    </section>
  );
}

function TranscriptMessage({ row }: { row: TranscriptRow }) {
  const { entry } = row;
  return (
    <article
      className={`ui-workspace-message${entry.role === "user" ? " desktop-user-message" : ""}${row.streaming && entry.role === "assistant" ? " desktop-preview" : ""}`}
      data-message-role={entry.role}
      data-chat-scroll-anchor={row.key}
      aria-label={
        entry.role === "user"
          ? "你的消息"
          : entry.role === "assistant"
            ? row.streaming
              ? "临时输出预览"
              : "助手消息"
            : row.liveTool && entry.role === "tool"
              ? `工具状态 ${entry.tool.name}`
              : undefined
      }
    >
      {entry.role === "tool" ? (
        <ToolResult
          name={entry.tool.name}
          status={entry.tool.status}
          display={entry.tool.display}
          effects={entry.tool.effects}
          error={entry.tool.error}
        />
      ) : (
        <DesktopMessage role={entry.role} text={entry.text} streaming={row.streaming} />
      )}
    </article>
  );
}

/** 仅组织展示轮次，不重建规范历史、不估算耗时，也不把折叠当成执行取消。 */
export function DesktopTranscript({
  sessionId,
  history,
  tools,
  preview,
  status,
}: {
  readonly sessionId?: string;
  readonly history: readonly HarnessHistoryEntry[];
  readonly tools: readonly WorkspaceToolProgress[];
  readonly preview: WorkspaceViewState["preview"];
  readonly status?: HarnessSnapshot["status"];
}) {
  const turns = useMemo(() => {
    const rows: TranscriptRow[] = history.map((entry, index) => ({
      key: `${sessionId}-history-${index}`,
      entry:
        entry.role === "tool"
          ? {
              role: "tool",
              tool: {
                ...entry.tool,
                status:
                  entry.tool.status ??
                  (entry.tool.result === "error"
                    ? "failed"
                    : entry.tool.result === "missing"
                      ? "unknown"
                      : "recorded"),
              },
            }
          : entry,
    }));
    if (preview?.reasoning)
      rows.push({
        key: `${sessionId}-reasoning-preview`,
        entry: { role: "reasoning", text: preview.reasoning },
        streaming: true,
      });
    for (const tool of tools)
      rows.push({
        key: JSON.stringify([
          tool.identity.queryId,
          tool.invocationIdentity?.runId ?? tool.identity.runId,
          tool.step,
          tool.callId,
        ]),
        entry: {
          role: "tool",
          tool,
        },
        liveTool: true,
      });
    if (preview?.text)
      rows.push({
        key: `${sessionId}-text-preview`,
        entry: { role: "assistant", text: preview.text },
        streaming: true,
      });
    const result: TranscriptTurn[] = [];
    for (const row of rows) {
      if (row.entry.role === "user" || result.length === 0)
        result.push({
          key: `${sessionId}-turn-${result.length}`,
          user: row.entry.role === "user" ? row : undefined,
          rows: [],
        });
      if (row.entry.role !== "user") result[result.length - 1].rows.push(row);
    }
    return result;
  }, [sessionId, history, tools, preview]);
  return (
    <>
      {turns.map((turn, index) => {
        let lastProcess = turn.rows.length - 1;
        while (
          lastProcess >= 0 &&
          turn.rows[lastProcess].entry.role !== "tool" &&
          turn.rows[lastProcess].entry.role !== "reasoning"
        )
          lastProcess -= 1;
        return (
          <Fragment key={turn.key}>
            {turn.user && <TranscriptMessage row={turn.user} />}
            {lastProcess >= 0 && (
              <ProcessRows
                rows={turn.rows.slice(0, lastProcess + 1)}
                status={index === turns.length - 1 ? status : undefined}
              />
            )}
            {turn.rows.slice(lastProcess + 1).map((row) => (
              <TranscriptMessage key={row.key} row={row} />
            ))}
          </Fragment>
        );
      })}
    </>
  );
}
