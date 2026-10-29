import { type AgentActivityItem, getResponseBlockContent } from "@shared/agent-activity";
import {
  buildAgentRunTimelineSegments,
  isToolBatchActive,
  shouldAutoCollapseToolBatch,
} from "@shared/agent-run-timeline-segments";
import type { AgentTaskNode } from "@shared/agent-task-list";
import { buildProcessTraceRows } from "@shared/process-trace-rows";
import type React from "react";
import { useRef } from "react";
import { ProcessTraceItem } from "./ProcessTraceItem";
import { ProcessTracePanel } from "./ProcessTracePanel";
import { MarkdownView } from "./markdown/MarkdownView";

interface AgentRunTimelineProps {
  documentId: string;
  items: AgentActivityItem[];
  content: string;
  live?: boolean;
  /** Persisted run wall duration; shown once on the last completed tool batch. */
  durationMs?: number;
  teamGraphTasks?: AgentTaskNode[];
}

export const AgentRunTimeline: React.FC<AgentRunTimelineProps> = ({
  documentId,
  items,
  content,
  live = false,
  durationMs,
  teamGraphTasks = [],
}) => {
  const liveOriginRef = useRef({ documentId, live });
  if (liveOriginRef.current.documentId !== documentId) {
    liveOriginRef.current = { documentId, live };
  } else if (live) {
    liveOriginRef.current.live = true;
  }
  const markdownMode = liveOriginRef.current.live ? "live" : "static";

  if (items.length === 0) {
    return content ? (
      <div className="agent-run-timeline">
        <MarkdownView
          documentId={documentId}
          content={content}
          mode={markdownMode}
          streaming={live}
          className="assistant-response"
        />
      </div>
    ) : null;
  }

  const segments = buildAgentRunTimelineSegments(items);
  let lastToolBatchIndex = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index]!.kind === "tool_batch") {
      lastToolBatchIndex = index;
      break;
    }
  }

  return (
    <div className="agent-run-timeline">
      {segments.map((segment, segmentIndex) => {
        if (segment.kind === "response") {
          const item = segment.item;
          return (
            <div
              key={item.id}
              className="agent-run-block agent-run-block--response"
              data-run-block-id={item.id}
              data-run-block-kind="response"
            >
              <MarkdownView
                documentId={`${documentId}:${item.id}`}
                content={getResponseBlockContent(item, content)}
                mode={markdownMode}
                streaming={live && Boolean(item.streaming)}
                className="assistant-response"
              />
            </div>
          );
        }

        if (segment.kind === "task") {
          const item = segment.item;
          const graphTaskId = item.taskListId ?? item.taskId;
          if (teamGraphTasks.some((task) => task.id === graphTaskId)) {
            return null;
          }
          const rows = buildProcessTraceRows([item], live);
          if (rows.length === 0) return null;
          return (
            <div
              key={item.id}
              className="agent-run-block agent-run-block--activity"
              data-run-block-id={item.id}
              data-run-block-kind={item.kind}
            >
              {rows.map((row) => (
                <ProcessTraceItem
                  key={row.id}
                  row={row}
                  defaultExpanded={Boolean(row.streaming || (row.active && row.kind !== "thought"))}
                />
              ))}
            </div>
          );
        }

        if (segment.kind === "thought") {
          const item = segment.item;
          const streaming = live && Boolean(item.streaming);
          const rows = buildProcessTraceRows([item], live);
          if (rows.length === 0) return null;
          const row = rows[0]!;
          return (
            <div
              key={item.id}
              className="agent-run-block agent-run-block--thought"
              data-run-block-id={item.id}
              data-run-block-kind="thought"
            >
              <ProcessTraceItem row={row} defaultExpanded={streaming} />
            </div>
          );
        }

        const hasLaterResponse = segments
          .slice(segmentIndex + 1)
          .some((later) => later.kind === "response");
        const batchActive = isToolBatchActive({
          items: segment.items,
          runLive: live,
          hasLaterResponse,
        });
        const autoCollapse = shouldAutoCollapseToolBatch({
          items: segment.items,
          runLive: live,
          hasLaterResponse,
        });
        const showPersistedDuration =
          !live && !batchActive && segmentIndex === lastToolBatchIndex ? durationMs : undefined;

        return (
          <div
            key={segment.items[0]!.id}
            className="agent-run-activity-cluster"
            data-run-block-kind="tool_batch"
          >
            <ProcessTracePanel
              items={segment.items}
              live={batchActive}
              shouldAutoCollapse={autoCollapse}
              durationMs={showPersistedDuration}
            />
          </div>
        );
      })}
    </div>
  );
};
