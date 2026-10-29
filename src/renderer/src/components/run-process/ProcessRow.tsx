import type { AgentToolDisplayCategory } from "@shared/agent-activity-display";
import { type ComponentType, useId } from "react";
import { CircleIcon, Edit3Icon, EyeIcon, FileIcon, SearchIcon, UsersIcon } from "../Icons";
import { MarkdownView } from "../markdown/MarkdownView";
import { useChatFold } from "../useChatFold";
import type { ProcessRowModel } from "./process-model";

interface ProcessRowProps {
  row: ProcessRowModel;
  expanded: boolean;
  onToggleDetail: (id: string) => void;
}

const TOOL_ICONS: Record<
  AgentToolDisplayCategory,
  ComponentType<{ size?: number; className?: string }>
> = {
  read: FileIcon,
  search: SearchIcon,
  inspect: EyeIcon,
  change: Edit3Icon,
  coordinate: UsersIcon,
  other: CircleIcon,
};

const STATUS_LABELS = {
  running: "执行中",
  completed: "已完成",
  failed: "执行失败",
  denied: "已拒绝",
  "invalid-input": "参数或前置条件不满足",
} as const;

function thoughtPreview(content: string): { text: string; long: boolean } {
  const prefix = content.slice(0, 1200);
  let end = prefix.length;
  let position = -1;
  for (let line = 0; line < 12; line += 1) {
    position = prefix.indexOf("\n", position + 1);
    if (position === -1) break;
    if (line === 11) end = position;
  }
  return { text: content.slice(0, end), long: end < content.length };
}

export function ProcessRow({ row, expanded, onToggleDetail }: ProcessRowProps) {
  const bodyId = useId();
  const { anchorRef, transactFold } = useChatFold<HTMLButtonElement>();
  const className = [
    "run-process-row",
    `run-process-row--${row.kind}`,
    row.active ? "run-process-row--active" : "",
    row.status ? `run-process-row--${row.status}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (row.kind === "progress") {
    return (
      <div className={className}>
        <MarkdownView
          documentId={row.id}
          content={row.content ?? row.title}
          className="run-process-progress"
        />
      </div>
    );
  }

  if (row.kind === "thought") {
    const content = row.content ?? row.lines?.join("\n") ?? "";
    const preview = thoughtPreview(content);
    return (
      <div className={className} aria-label="思考内容">
        <pre id={bodyId} className="run-process-thought" aria-busy={Boolean(row.streaming)}>
          {expanded || !preview.long ? content : `${preview.text}…`}
          {row.streaming && <span className="run-process-cursor" aria-hidden="true" />}
        </pre>
        {preview.long && (
          <button
            ref={anchorRef}
            type="button"
            className="run-process-detail-toggle"
            onClick={() => transactFold(() => onToggleDetail(row.id))}
            aria-expanded={expanded}
            aria-controls={bodyId}
          >
            {expanded ? "收起全文" : "展开全文"}
          </button>
        )}
      </div>
    );
  }

  const hasDetails = Boolean(row.content?.trim() || row.lines?.length);
  const ToolIcon = TOOL_ICONS[row.toolCategory ?? "other"];
  const title = (
    <>
      <span className="run-process-row-icon" aria-hidden="true">
        <ToolIcon size={12} />
      </span>
      <span className="run-process-row-label">{row.title}</span>
      {row.status && <span className="run-process-sr-only">{STATUS_LABELS[row.status]}</span>}
    </>
  );

  return (
    <div className={className}>
      <div className="run-process-row-title">{title}</div>
      {hasDetails && (
        <div id={bodyId} className="run-process-row-details">
          {row.content !== undefined && <pre className="run-process-text">{row.content}</pre>}
          {row.lines?.map((line, index) => (
            // Detail lines are positional and may repeat verbatim.
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered process detail lines
            <div key={index} className="run-process-text">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
