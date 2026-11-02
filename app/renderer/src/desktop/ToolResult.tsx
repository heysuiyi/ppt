import { useId, useState } from "react";
import type { HarnessError, HarnessToolDisplay } from "../../../shared/harness-ipc";
import { getToolLabel } from "./tool-presentation";
import "./tool-result.css";

export interface ToolResultProps {
  readonly name: string;
  readonly status: "dispatched" | "completed" | "failed" | "unknown" | "recorded";
  readonly display?: HarnessToolDisplay;
  readonly effects?: "none" | "applied" | "unknown";
  readonly error?: HarnessError;
}

const statusLabels: Record<ToolResultProps["status"], string> = {
  dispatched: "处理中",
  completed: "已完成",
  failed: "失败",
  unknown: "结果未知",
  recorded: "结果已记录",
};

function ToolIcon({ name }: { name: string }) {
  if (name === "glob" || name === "grep") {
    return (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    );
  }
  if (name === "edit") {
    return <path d="m15 4 5 5M4 20l4-1L20 7a2.1 2.1 0 0 0-3-3L5 16l-1 4Z" />;
  }
  if (name === "read" || name === "write") {
    return (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
        <path d="M14 3v6h6M8 13h8m-8 4h6" />
      </>
    );
  }
  return (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </>
  );
}

const previewLimits: Readonly<Record<string, number>> = {
  read: 12,
  glob: 8,
  grep: 6,
  write: 6,
  edit: 40,
};

function ToolOutput({ name, lines }: { name: string; lines: readonly string[] }) {
  const [expanded, setExpanded] = useState(false);
  const limit = previewLimits[name] ?? 12;
  const long = lines.length > limit;
  let preview = lines.slice(0, limit);
  // 与 CLI 一样，编辑预览为旧片段和新片段分别留出空间。
  if (name === "edit" && lines[0]?.startsWith("- ")) {
    const newFragment = lines.findIndex((line) => line.startsWith("+ "));
    if (newFragment > 0) {
      preview = [
        ...lines.slice(0, Math.min(newFragment, limit)),
        ...(newFragment > limit ? ["…"] : []),
        ...lines.slice(newFragment, newFragment + limit),
      ];
    }
  }
  return (
    <div className="desktop-tool-result__output">
      <pre
        className="desktop-tool-result__literal"
        role="region"
        aria-label="工具结果预览"
        tabIndex={0}
        hidden={expanded}
      >
        <code>{preview.join("\n")}</code>
      </pre>
      {long && (
        <details
          className="desktop-tool-result__details"
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary>
            {expanded ? "收起结果" : "展开全部"}（{lines.length} 行）
          </summary>
          <pre
            className="desktop-tool-result__literal desktop-tool-result__literal--expanded"
            role="region"
            aria-label="工具完整预览"
            tabIndex={0}
          >
            <code>{lines.join("\n")}</code>
          </pre>
        </details>
      )}
    </div>
  );
}

/** 只呈现宿主已限量、已白名单投影的 DTO，不解析工具原始结果。 */
export function ToolResult({ name, status, display, effects, error }: ToolResultProps) {
  const [expanded, setExpanded] = useState(false);
  const [detailsMounted, setDetailsMounted] = useState(false);
  const detailsId = useId();
  const statusId = `${detailsId}-status`;
  const hasDetails = Boolean(
    display &&
      (display.title || display.summary?.length || display.output.length || display.input.length),
  );
  const emptyResult = status !== "dispatched" && !error && !display?.summary?.length;
  const target = error ? `${error.code}: ${error.message}` : display?.title;
  const header = (
    <>
      <span className="desktop-tool-result__icon-slot" aria-hidden="true">
        <svg
          className="desktop-tool-result__icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <ToolIcon name={name} />
        </svg>
        {hasDetails && (
          <svg
            className="desktop-tool-result__chevron"
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m5 3 5 5-5 5" />
          </svg>
        )}
      </span>
      <span className="desktop-tool-result__identity">
        <strong className="desktop-tool-result__name" title={name}>
          {getToolLabel(name)}
        </strong>
        {target && (
          <>
            <span className="desktop-tool-result__separator" aria-hidden="true">
              ·
            </span>
            <span className="desktop-tool-result__target" title={target}>
              {target}
            </span>
          </>
        )}
      </span>
      <span id={statusId} className="desktop-tool-result__status" role="status">
        {statusLabels[status]}
      </span>
    </>
  );

  return (
    <section className="desktop-tool-result" data-status={status} aria-label={`${name} 工具结果`}>
      {hasDetails ? (
        <button
          type="button"
          className="desktop-tool-result__header"
          aria-label={`${name} 工具详情`}
          aria-describedby={statusId}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => {
            setDetailsMounted(true);
            setExpanded(!expanded);
          }}
        >
          {header}
        </button>
      ) : (
        <div className="desktop-tool-result__header">{header}</div>
      )}
      {error && (
        <p className="desktop-tool-result__error" aria-label="工具错误">
          <code>{error.code}</code>: {error.message}
        </p>
      )}
      {effects !== undefined && effects !== "none" && (
        <p className="desktop-tool-result__impact" aria-label="工具影响">
          {effects === "applied"
            ? "已产生外部影响；失败或取消不会撤销。"
            : "外部影响未知；请勿直接重复执行。"}
        </p>
      )}
      {hasDetails && (
        <div
          id={detailsId}
          className="desktop-tool-result__body desktop-fold"
          hidden={!expanded}
          inert={!expanded}
          aria-hidden={!expanded}
        >
          <div className="desktop-fold__inner">
            {detailsMounted && (
              <>
                {display?.title && (
                  <p className="desktop-tool-result__target-detail">{display.title}</p>
                )}
                {display?.summary && display.summary.length > 0 && (
                  <p className="desktop-tool-result__summary">{display.summary.join("\n")}</p>
                )}
                {display && display.output.length > 0 ? (
                  <ToolOutput name={name} lines={display.output} />
                ) : emptyResult ? (
                  <p className="desktop-tool-result__empty">无结果预览</p>
                ) : null}
                {display && display.input.length > 0 && (
                  <details className="desktop-tool-result__details desktop-tool-result__parameters">
                    <summary>参数</summary>
                    <pre
                      className="desktop-tool-result__literal"
                      role="region"
                      aria-label="工具参数"
                      tabIndex={0}
                    >
                      <code>{display.input.join("\n")}</code>
                    </pre>
                  </details>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {!hasDetails && emptyResult && (
        <p className="desktop-tool-result__empty">{display ? "无结果预览" : "未保留结果预览"}</p>
      )}
    </section>
  );
}
