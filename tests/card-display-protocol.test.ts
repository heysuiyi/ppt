import { getCardPresentationPolicy } from "@shared/cards/card-presentation-policy";
import {
  clearAllDisplayCardManagers,
  findActiveToolPermissionCard,
  getPersistedDisplayCards,
  hydrateDisplayCardManagers,
  ingestDisplayEvent,
  recordDisplayCardAction,
  setDisplayCardStatus,
  useInteractionCardManager,
  usePermissionCardManager,
  useProgressCardManager,
  useReviewCardManager,
} from "@shared/cards/display-card-managers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  toResultDisplayEvents,
  toStreamDisplayEvent,
} from "../app/main/agent/display/display-event-adapter";
import { displayEventSchema } from "../src/shared/card-display-protocol";
import { createSvgTestSlide } from "../src/shared/presentation-fixtures";
import { createSessionPresentation } from "../src/shared/session";

const permissionEvent = {
  protocolVersion: 1 as const,
  eventId: "tool-approval:approval-1",
  emittedAt: "2026-07-15T00:00:00.000Z",
  kind: "permission.tool-requested" as const,
  category: "permission" as const,
  source: { kind: "tool" as const, toolName: "ExportPptx" },
  scope: { sessionId: "session-1", runId: "run-1" },
  semantics: {
    blocking: true,
    requiresResponse: true,
    priority: "critical" as const,
  },
  payload: {
    approvalId: "approval-1",
    toolName: "ExportPptx",
    reason: "需要写入导出文件",
    detail: "output.pptx",
  },
};

describe("card display protocol", () => {
  beforeEach(() => clearAllDisplayCardManagers());

  it("validates semantic events and keeps placement in renderer policy", () => {
    const event = displayEventSchema.parse(permissionEvent);
    const policy = getCardPresentationPolicy(event);

    expect(policy.host).toBe("composer-overlay");
    expect(policy.persistence).toBe("volatile");
    expect(event).not.toHaveProperty("component");
    expect(event).not.toHaveProperty("placement");
  });

  it("rejects a kind/category mismatch at the protocol boundary", () => {
    expect(() =>
      displayEventSchema.parse({
        ...permissionEvent,
        category: "notification",
      }),
    ).toThrow();
  });

  it("routes permission events to an independent blocking manager", () => {
    ingestDisplayEvent(permissionEvent);
    const cards = usePermissionCardManager.getState().cards;
    const active = findActiveToolPermissionCard(cards, "run-1");

    expect(active?.event.kind).toBe("permission.tool-requested");
    expect(useProgressCardManager.getState().cards).toHaveLength(0);
    expect(setDisplayCardStatus(permissionEvent.eventId, "resolved")).toBe(true);
    expect(
      findActiveToolPermissionCard(usePermissionCardManager.getState().cards, "run-1"),
    ).toBeUndefined();
  });

  it("adapts runtime events and terminal results without naming React components", () => {
    const streamDisplay = toStreamDisplayEvent(
      {
        type: "tool-approval-waiting",
        message: "等待授权",
        approvalId: "approval-2",
        toolName: "RewriteSlideContent",
        reason: "将修改演示文稿内容",
        detail: "slide-2",
      },
      "session-1",
      "run-2",
    );

    expect(streamDisplay?.kind).toBe("permission.tool-requested");
    expect(streamDisplay?.scope.runId).toBe("run-2");

    const svgPreviewDisplay = toStreamDisplayEvent(
      {
        type: "slide-preview-ready",
        message: "已生成页面预览",
        toolCallId: "preview-svg-1",
        toolName: "PreviewSvgPage",
        slideId: "svg-preview-abc",
        title: "P01",
        description: "content-exact SVG preview",
        thumbnail: null,
      },
      "session-1",
      "run-2",
    );
    expect(svgPreviewDisplay?.source).toMatchObject({
      kind: "tool",
      toolName: "PreviewSvgPage",
    });

    const resultEvents = toResultDisplayEvents(
      {
        status: "waiting-user",
        message: "请选择内容侧重点",
        threadId: "thread-1",
        question: {
          variant: "choices",
          selectionMode: "single",
          options: [{ id: "practice", title: "实践案例" }],
        },
      },
      "session-1",
      "run-2",
    );

    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]?.kind).toBe("interaction.question-requested");
    expect(resultEvents[0]?.scope.threadId).toBe("thread-1");
  });

  it("projects a completed SVG deck as an artifact without reopening layout choice", () => {
    const presentation = {
      ...createSessionPresentation("Content-only result"),
      revision: 4,
      slides: [
        createSvgTestSlide({
          id: "slide-svg-ready",
          title: "核心观点",
        }),
      ],
    };

    const resultEvents = toResultDisplayEvents(
      {
        status: "completed",
        presentation,
      },
      "session-1",
      "run-4",
    );

    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]?.kind).toBe("artifact.ready");
    expect(resultEvents.some((event) => event.kind === "interaction.layout-required")).toBe(false);
  });

  it("persists manager status and actions independently from chat messages", () => {
    const event = toResultDisplayEvents(
      {
        status: "waiting-user",
        message: "请选择内容侧重点",
        threadId: "thread-1",
        question: {
          variant: "choices",
          selectionMode: "single",
          options: [{ id: "practice", title: "实践案例" }],
        },
      },
      "session-1",
      "run-2",
    )[0]!;
    ingestDisplayEvent({ ...event, scope: { ...event.scope, anchorMessageId: "message-1" } });
    recordDisplayCardAction(
      event.eventId,
      "answer",
      {
        optionIds: ["practice"],
        value: "practice",
        label: "实践案例",
      },
      "resolved",
    );

    const snapshot = getPersistedDisplayCards();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.status).toBe("resolved");
    expect(snapshot[0]?.lastAction?.actionId).toBe("answer");

    clearAllDisplayCardManagers();
    hydrateDisplayCardManagers(snapshot);
    expect(useInteractionCardManager.getState().cards[0]?.lastAction?.payload).toMatchObject({
      value: "practice",
    });
  });

  it("silently retires legacy layout-choice cards during ingest and hydration", () => {
    const event = {
      protocolVersion: 1 as const,
      eventId: "layout-required:session-1:4",
      emittedAt: "2026-07-15T00:00:00.000Z",
      kind: "interaction.layout-required" as const,
      category: "interaction" as const,
      source: {
        kind: "domain" as const,
        entityType: "presentation",
        entityId: "session-1",
        revision: 4,
      },
      scope: { sessionId: "session-1", runId: "run-4" },
      semantics: {
        blocking: true,
        requiresResponse: true,
        priority: "high" as const,
      },
      payload: {
        presentationRevision: 4,
        slideCount: 8,
      },
    };

    ingestDisplayEvent(event);
    expect(useInteractionCardManager.getState().cards).toHaveLength(0);
    hydrateDisplayCardManagers([
      {
        event,
        status: "active",
        receivedAt: Date.now(),
      },
    ]);
    expect(useInteractionCardManager.getState().cards).toHaveLength(0);
    expect(getPersistedDisplayCards()).toHaveLength(0);
    clearAllDisplayCardManagers();
  });

  it("keeps the complete approval request in the review event payload", () => {
    const [event] = toResultDisplayEvents(
      {
        status: "approval-required",
        approval: {
          jobId: "job-review",
          queryId: "query-review",
          proposalId: "proposal-review",
          threadId: "thread-review",
          summary: "更新标题",
          commands: [{ id: "command-1", type: "set-presentation-title", title: "新标题" }],
          assumptions: ["保留现有页面"],
        },
      },
      "session-1",
      "run-3",
    );

    expect(event?.kind).toBe("review.command-proposal");
    if (event?.kind !== "review.command-proposal") throw new Error("missing review event");
    expect(event.payload.threadId).toBe("thread-review");
    expect(event.payload.commands).toHaveLength(1);
  });

  it("creates a fresh approval card for each ProposalId in the same thread", () => {
    const firstProposal = {
      status: "approval-required" as const,
      approval: {
        jobId: "job-review",
        queryId: "query-review",
        proposalId: "proposal-review-1",
        threadId: "thread-review",
        summary: "更新标题",
        commands: [{ id: "command-1", type: "set-presentation-title" as const, title: "新标题" }],
      },
    };
    const secondProposal = {
      ...firstProposal,
      approval: {
        ...firstProposal.approval,
        proposalId: "proposal-review-2",
      },
    };
    const [first] = toResultDisplayEvents(firstProposal, "session-1", "run-1");
    const [second] = toResultDisplayEvents(secondProposal, "session-1", "run-2");
    if (!first || !second) throw new Error("missing proposal events");

    expect(first?.eventId).toBe("command-proposal:proposal-review-1");
    expect(second?.eventId).toBe("command-proposal:proposal-review-2");
    expect(second?.eventId).not.toBe(first?.eventId);

    ingestDisplayEvent(first);
    recordDisplayCardAction(first.eventId, "approve", undefined, "resolved");
    ingestDisplayEvent(second);

    const cards = useReviewCardManager.getState().cards;
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      event: { eventId: "command-proposal:proposal-review-1" },
      status: "resolved",
    });
    expect(cards[1]).toMatchObject({
      event: { eventId: "command-proposal:proposal-review-2" },
      status: "active",
    });
    expect(cards[1]).not.toHaveProperty("lastAction");
  });

  it("reactivates a legacy proposal card whose resolved action belongs to an older run", () => {
    const [event] = toResultDisplayEvents(
      {
        status: "approval-required",
        approval: {
          jobId: "job-review",
          queryId: "query-review",
          proposalId: "proposal-svg",
          threadId: "thread-review",
          summary: "提交 SVG 幻灯片",
          commands: [{ id: "command-2", type: "set-presentation-title", title: "SVG 版本" }],
        },
      },
      "session-1",
      "run-new",
    );
    if (!event) throw new Error("missing proposal event");

    hydrateDisplayCardManagers([
      {
        event: {
          ...event,
          eventId: "command-proposal:thread-review",
        },
        status: "resolved",
        receivedAt: Date.now(),
        lastAction: {
          protocolVersion: 1,
          eventId: "command-proposal:thread-review",
          actionId: "approve",
          correlation: {
            sessionId: "session-1",
            runId: "run-old",
            threadId: "thread-review",
          },
        },
      },
    ]);

    const [card] = useReviewCardManager.getState().cards;
    expect(card).toMatchObject({
      event: {
        eventId: "command-proposal:thread-review",
        scope: { runId: "run-new" },
      },
      status: "active",
    });
    expect(card).not.toHaveProperty("lastAction");
  });
});
