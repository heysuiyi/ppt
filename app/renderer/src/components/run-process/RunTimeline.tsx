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
  const liveOrigin = useRef({
    documentId,
    live,
    provisionalResponse: false,
    responseId: undefined as string | undefined,
  });
  if (liveOrigin.current.documentId !== documentId) {
    liveOrigin.current = { documentId, live, provisionalResponse: false, responseId: undefined };
  } else if (live) {
    liveOrigin.current.live = true;
  }
  const markdownMode = liveOrigin.current.live ? "live" : "static";
  const segments = buildTimelineSegments(items);
  const firstResponse = segments.find((segment) => segment.kind === "response");
  if (!firstResponse && content) liveOrigin.current.provisionalResponse = true;
  if (firstResponse && liveOrigin.current.provisionalResponse) {
    liveOrigin.current.responseId ??= firstResponse.item.id;
  }
  // A late trace enriches the provisional response instead of replacing its document.
  const visibleSegments =
    firstResponse || !content ? segments : [...segments, { kind: "provisional-response" as const }];
  let lastResponseIndex = -1;
  for (let index = visibleSegments.length - 1; index >= 0; index -= 1) {
    const kind = visibleSegments[index]!.kind;
    if (kind === "response" || kind === "provisional-response") {
      lastResponseIndex = index;
      break;
    }
  }

  return (
    <div className="agent-run-timeline">
      {visibleSegments.map((segment, index) => {
        if (segment.kind === "response" || segment.kind === "provisional-response") {
          const item = segment.kind === "response" ? segment.item : undefined;
          const responseDocumentId =
            !item || item.id === liveOrigin.current.responseId
              ? `${documentId}:initial-response`
              : `${documentId}:${item.id}`;
          return (
            <div
              key={responseDocumentId}
              className="agent-run-block agent-run-block--response"
              data-run-block-id={item?.id}
              data-run-block-kind="response"
            >
              <MarkdownView
                documentId={responseDocumentId}
                content={item ? getResponseBlockContent(item, content) : content}
                mode={markdownMode}
                streaming={live && (!item || Boolean(item.streaming))}
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
              runStatus: index === visibleSegments.length - 1 ? runStatus : undefined,
            })}
          />
        );
      })}
      <RunDuration live={live} startedAt={startedAt} durationMs={durationMs} />
    </div>
  );
}
