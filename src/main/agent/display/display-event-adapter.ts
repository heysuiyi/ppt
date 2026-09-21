import { createDisplayEventId, type DisplayEvent } from "@shared/card-display-protocol";
import type { AgentRunResult } from "@shared/ipc";
import type { AgentServiceEvent } from "../../plugins/ppt/service";

function now(): string {
  return new Date().toISOString();
}

export function toStreamDisplayEvent(
  event: AgentServiceEvent,
  sessionId: string,
  runId: string,
): DisplayEvent | undefined {
  if (event.type === "tool-approval-waiting") {
    return {
      protocolVersion: 1,
      eventId: `tool-approval:${event.approvalId}`,
      emittedAt: now(),
      kind: "permission.tool-requested",
      category: "permission",
      source: { kind: "tool", toolName: event.toolName },
      scope: { sessionId, runId },
      semantics: {
        blocking: true,
        requiresResponse: true,
        priority: "critical",
      },
      payload: {
        approvalId: event.approvalId,
        toolName: event.toolName,
        reason: event.reason,
        detail: event.detail,
      },
    };
  }

  if (event.type === "task-list-updated") {
    return {
      protocolVersion: 1,
      // One semantic card per run; later updates replace the prior snapshot.
      eventId: `task-list:${sessionId}:${runId}`,
      emittedAt: now(),
      kind: "progress.task-list-updated",
      category: "progress",
      source: { kind: "agent" },
      scope: { sessionId, runId },
      semantics: {
        blocking: false,
        requiresResponse: false,
        priority: "normal",
      },
      payload: {
        tasks: event.tasks,
        goal: event.goal,
        listRevision: event.listRevision,
        state: event.state,
        archive: event.archive,
      },
    };
  }

  if (event.type === "slide-preview-ready") {
    return {
      protocolVersion: 1,
      eventId: `slide-preview:${runId}:${event.toolCallId}`,
      emittedAt: now(),
      kind: "artifact.slide-preview",
      category: "artifact",
      source: {
        kind: "tool",
        toolName: event.toolName ?? "PreviewSlide",
        toolCallId: event.toolCallId,
      },
      scope: { sessionId, runId },
      semantics: {
        blocking: false,
        requiresResponse: false,
        priority: "normal",
      },
      payload: {
        slideId: event.slideId,
        title: event.title,
        description: event.description,
        thumbnail: event.thumbnail,
        ...(event.thumbnailError ? { thumbnailError: event.thumbnailError } : {}),
      },
    };
  }

  return undefined;
}

export function toResultDisplayEvents(
  result: AgentRunResult,
  sessionId: string,
  runId?: string,
): DisplayEvent[] {
  const scope = {
    sessionId,
    ...(runId ? { runId } : {}),
  };

  if (result.status === "waiting-user" && result.question) {
    return [
      {
        protocolVersion: 1,
        eventId: createDisplayEventId("question"),
        emittedAt: now(),
        kind: "interaction.question-requested",
        category: "interaction",
        source: { kind: "tool", toolName: "AskUser" },
        scope: {
          ...scope,
          ...(result.threadId ? { threadId: result.threadId } : {}),
        },
        semantics: {
          blocking: true,
          requiresResponse: true,
          priority: "high",
        },
        payload: {
          message: result.message,
          question: result.question,
        },
      },
    ];
  }

  if (result.status === "approval-required") {
    return [
      {
        protocolVersion: 1,
        // ProposalId is the durable business identity. Replaying the same Query
        // or Renderer projection must address the same approval card.
        eventId: `command-proposal:${result.approval.proposalId}`,
        emittedAt: now(),
        kind: "review.command-proposal",
        category: "review",
        source: { kind: "tool", toolName: "SubmitSvgDeck" },
        scope: {
          ...scope,
          threadId: result.approval.threadId,
        },
        semantics: {
          blocking: true,
          requiresResponse: true,
          priority: result.approval.risk === "high" ? "critical" : "high",
        },
        payload: result.approval,
      },
    ];
  }

  if (result.status === "completed") {
    const presentation = result.presentation;
    return [
      {
        protocolVersion: 1,
        eventId: `artifact:deck:${sessionId}:${presentation.revision}`,
        emittedAt: now(),
        kind: "artifact.ready",
        category: "artifact",
        source: {
          kind: "domain",
          entityType: "presentation",
          entityId: sessionId,
          revision: presentation.revision,
        },
        scope,
        semantics: {
          blocking: false,
          requiresResponse: false,
          priority: "normal",
        },
        payload: {
          artifactId: "deck",
          artifactType: "deck",
          title: presentation.title,
          revision: presentation.revision,
        },
      },
    ];
  }

  return [];
}
