import type { AgentToolDisplayCategory } from "@shared/agent-activity-display";
import type { ProcessTraceRow } from "@shared/process-trace-rows";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  Edit3Icon,
  EyeIcon,
  FileIcon,
  SearchIcon,
  UsersIcon,
} from "./Icons";
import { MarkdownView } from "./markdown/MarkdownView";
import { useChatFold } from "./useChatFold";

interface ProcessTraceItemProps {
  row: ProcessTraceRow;
  defaultExpanded?: boolean;
}

type IconComponent = React.FC<{ size?: number; className?: string }>;

const TOOL_CATEGORY_ICONS: Record<AgentToolDisplayCategory, IconComponent> = {
  read: FileIcon,
  search: SearchIcon,
  inspect: EyeIcon,
  change: Edit3Icon,
  coordinate: UsersIcon,
  other: CircleIcon,
};

export const ProcessTraceItem: React.FC<ProcessTraceItemProps> = ({
  row,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const liveBodyRef = useRef<HTMLDivElement>(null);
  const { anchorRef: titleRef, transactFold } = useChatFold<HTMLButtonElement>();
  const hasBody = Boolean(row.content?.trim() || (row.lines && row.lines.length > 0));
  const effectiveExpanded = hasBody && expanded;
  const CaretIcon = effectiveExpanded ? ChevronDownIcon : ChevronRightIcon;
  const ToolCategoryIcon = row.toolCategory ? TOOL_CATEGORY_ICONS[row.toolCategory] : null;

  useEffect(() => {
    if (row.kind === "thought") {
      if (row.streaming) {
        setExpanded(true);
        return;
      }
      // Completed thoughts stay collapsed unless the user opens them.
      if (!row.streaming && !defaultExpanded) {
        setExpanded(false);
      }
      return;
    }
    if (defaultExpanded || row.active) {
      setExpanded(true);
    }
  }, [defaultExpanded, row.active, row.kind, row.streaming]);

  useEffect(() => {
    if (!row.streaming || !effectiveExpanded) return;
    const body = liveBodyRef.current;
    if (!body) return;
    body.scrollTop = body.scrollHeight;
  }, [row.streaming, effectiveExpanded]);

  const toggleExpanded = () => {
    transactFold(() => setExpanded((value) => !value));
  };

  const statusIndicator = row.status ? (
    <span
      className={`process-trace-row-status process-trace-row-status--${row.status}`}
      aria-hidden="true"
    >
      {ToolCategoryIcon && row.toolCategory ? (
        <ToolCategoryIcon
          size={12}
          className={`process-trace-row-tool-icon process-trace-row-tool-icon--${row.toolCategory}`}
        />
      ) : (
        <i />
      )}
    </span>
  ) : null;

  if (row.kind === "progress") {
    return (
      <div
        className={`process-trace-row process-trace-row--progress${row.active ? " process-trace-row--active" : ""}`}
      >
        <MarkdownView
          documentId={row.id}
          content={row.title}
          className="assistant-response process-trace-progress-content"
        />
      </div>
    );
  }

  return (
    <div
      className={[
        "process-trace-row",
        `process-trace-row--${row.kind}`,
        row.active ? "process-trace-row--active" : "",
        row.status ? `process-trace-row--status-${row.status}` : "",
        row.kind === "tool" ? "process-trace-row--enter" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {hasBody ? (
        <button
          ref={titleRef}
          type="button"
          className="process-trace-row-title process-trace-row-title--interactive"
          onClick={toggleExpanded}
          aria-expanded={effectiveExpanded}
        >
          {statusIndicator}
          <span className="process-trace-row-toggle" aria-hidden="true">
            <CaretIcon size={12} />
          </span>
          <span className="process-trace-row-label">{row.title}</span>
        </button>
      ) : (
        <div className="process-trace-row-title">
          {statusIndicator ?? <span className="process-trace-row-caret" aria-hidden="true" />}
          <span className="process-trace-row-label">{row.title}</span>
        </div>
      )}
      {effectiveExpanded && (
        <div
          ref={row.streaming ? liveBodyRef : undefined}
          className={["process-trace-row-body", row.streaming ? "process-trace-row-body--live" : ""]
            .filter(Boolean)
            .join(" ")}
        >
          {row.content !== undefined && (
            <pre className="process-trace-row-text">
              {row.content}
              {row.streaming && <span className="reasoning-cursor" aria-hidden="true" />}
            </pre>
          )}
          {row.lines?.map((line, index) => (
            // Process lines are positional; repeated content has no stable id.
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered process lines
            <div key={index} className="process-trace-row-line">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
