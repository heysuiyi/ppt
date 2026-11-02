import { useState } from "react";
import type { HarnessError, HarnessToolDisplay } from "../../../shared/harness-ipc";
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
  return (
    <section className="desktop-tool-result" data-status={status} aria-label={`${name} 工具结果`}>
      <header className="desktop-tool-result__header">
        <strong className="desktop-tool-result__name">{name}</strong>
        {display?.title && (
          <span className="desktop-tool-result__target" title={display.title}>
            {display.title}
          </span>
        )}
        <span className="desktop-tool-result__status">{statusLabels[status]}</span>
      </header>
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
      {display?.summary && display.summary.length > 0 && (
        <p className="desktop-tool-result__summary">{display.summary.join("\n")}</p>
      )}
      {display && display.output.length > 0 ? (
        <ToolOutput name={name} lines={display.output} />
      ) : status !== "dispatched" && !error && !display?.summary?.length ? (
        <p className="desktop-tool-result__empty">{display ? "无结果预览" : "未保留结果预览"}</p>
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
    </section>
  );
}
