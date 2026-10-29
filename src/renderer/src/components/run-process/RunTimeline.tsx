import { type AgentActivityItem, getResponseBlockContent } from "@shared/agent-activity";
import type { AgentTaskNode } from "@shared/agent-task-list";
import type { SessionChatMessage } from "@shared/session";
import { useRef } from "react";
import { MarkdownView } from "../markdown/MarkdownView";
import { ProcessRecord } from "./ProcessRecord";
import { ProcessSection } from "./ProcessSection";
import { buildProcessView, buildTimelineSegments } from "./process-model";
import { RunDuration } from "./RunDuration";

interface RunTimelineProps {
  documentId: string;
  items: AgentActivityItem[];
  content: string;
  live?: boolean;
  startedAt?: number;
  durationMs?: number;
  runStatus?: SessionChatMessage["runStatus"];
  teamGraphTasks?: AgentTaskNode[];
}

export function RunTimeline({
  documentId,
  items,
  content,
  live = false,
  startedAt,
  durationMs,
  runStatus,
  teamGraphTasks = [],
}: RunTimelineProps) {
  const liveOrigin = useRef({ documentId, live });
  if (liveOrigin.current.documentId !== documentId) {
    liveOrigin.current = { documentId, live };
  } else if (live) {
    liveOrigin.current.live = true;
  }
  const markdownMode = liveOrigin.current.live ? "live" : "static";
  const segments = buildTimelineSegments(items);
  let lastResponseIndex = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index]!.kind === "response") {
      lastResponseIndex = index;
      break;
    }
  }

  return (
    <div className="agent-run-timeline">
      {segments.length === 0 && content && (
        <MarkdownView
          documentId={documentId}
          content={content}
          mode={markdownMode}
          streaming={live}
          className="assistant-response"
        />
      )}
      {segments.map((segment, index) => {
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
          if (teamGraphTasks.some((task) => task.id === (item.taskListId ?? item.taskId))) {
            return null;
          }
          return (
            <div key={item.id} data-run-block-id={item.id} data-run-block-kind="task">
              <ProcessRecord items={[item]} live={item.status === "running"} />
            </div>
          );
        }
        return (
          <ProcessSection
            key={`${documentId}:${segment.id}`}
            view={buildProcessView(segment.items, {
              live,
              hasLaterResponse: index < lastResponseIndex,
              runStatus: index === segments.length - 1 ? runStatus : undefined,
            })}
          />
        );
      })}
      <RunDuration live={live} startedAt={startedAt} durationMs={durationMs} />
    </div>
  );
}
