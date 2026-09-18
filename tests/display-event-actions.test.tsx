// @vitest-environment jsdom

import {
  clearAllDisplayCardManagers,
  ingestDisplayEvent,
  setDisplayCardStatus,
  useReviewCardManager,
} from "@shared/cards/display-card-managers";
import { cleanup, render } from "@testing-library/react";
import { act, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityStreamController } from "../src/renderer/src/app/agent/useAgentActivityStream";
import {
  type ApplyAgentResult,
  useAgentResultHandler,
} from "../src/renderer/src/app/agent/useAgentResultHandler";
import {
  type DisplayEventActions,
  useDisplayEventActions,
} from "../src/renderer/src/app/cards/useDisplayEventActions";
import type { ChatMessage } from "../src/renderer/src/app/chatMessageRuntime";
import { useProjectStore } from "../src/renderer/src/components/project-store";
import type { AgentActivityItem } from "../src/shared/agent-activity";
import type { DisplayEvent } from "../src/shared/card-display-protocol";
import {
  type PptJobProjection,
  pptJobProjectionSchema,
} from "../src/shared/presentation-lifecycle";

const approvalEvent = {
  protocolVersion: 1 as const,
  eventId: "command-proposal:thread-1",
  emittedAt: "2026-07-25T00:00:00.000Z",
  kind: "review.command-proposal" as const,
  category: "review" as const,
  source: { kind: "tool" as const, toolName: "SubmitSvgDeck" },
  scope: {
    sessionId: "session-1",
    runId: "run-1",
    threadId: "thread-1",
    anchorMessageId: "assistant-1",
  },
  semantics: {
    blocking: true,
    requiresResponse: true,
    priority: "high" as const,
  },
  payload: {
    jobId: "job-1",
    queryId: "query-1",
    proposalId: "proposal-1",
    threadId: "thread-1",
    summary: "更新标题",
    commands: [
      {
        id: "command-1",
        type: "set-presentation-title" as const,
        title: "新标题",
      },
    ],
  },
} satisfies Extract<DisplayEvent, { kind: "review.command-proposal" }>;

const matchingPptJob = pptJobProjectionSchema.parse({
  jobId: "job-1",
  presentationId: "presentation-1",
  capability: "edit",
  requestId: "request-1",
  queryId: "query-1",
  status: "waiting_approval",
  stage: "proposal",
  stateRevision: 1,
  committedArtifacts: [],
  staleArtifacts: [],
  proposalId: "proposal-1",
  proposalStatus: "waiting_approval",
  updatedAt: "2026-07-25T00:00:00.000Z",
});

const patchEvent = {
  protocolVersion: 1 as const,
  eventId: "patch:thread-1",
  emittedAt: "2026-07-30T00:00:00.000Z",
  kind: "review.patch-ready" as const,
  category: "review" as const,
  source: { kind: "tool" as const, toolName: "EditFile" },
  scope: {
    sessionId: "session-1",
    runId: "run-1",
    threadId: "thread-1",
    anchorMessageId: "assistant-1",
  },
  semantics: {
    blocking: true,
    requiresResponse: true,
    priority: "high" as const,
  },
  payload: {
    patchId: "patch-1",
    threadId: "thread-1",
    targetPath: "brief.md",
    summary: "更新 brief",
    contentBefore: "# Before\n",
    contentAfter: "# After\n",
  },
} satisfies Extract<DisplayEvent, { kind: "review.patch-ready" }>;

let actions: DisplayEventActions;
let messages: ChatMessage[];
let busy: boolean;
const notify = vi.fn();
const syncPresentation = vi.fn(async () => undefined);
const startAgent = vi.fn(async () => undefined);
const originalHydrate = useProjectStore.getState().hydrateProjectArtifacts;

function Harness() {
  const initialTrace: AgentActivityItem[] = [
    {
      id: "response-waiting",
      kind: "response",
      start: 0,
      end: 20,
      streaming: false,
    },
  ];
  const [isBusy, setBusy] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "assistant-1",
      role: "assistant",
      content: "已提出排版更新方案，请在下方审核后应用。",
      activityTrace: initialTrace,
      runId: "run-1",
      runStatus: "completed",
      threadId: "thread-1",
    },
  ]);
  const activeRunTraceRef = useRef<AgentActivityItem[]>(initialTrace);
  const streamMessageIdsRef = useRef(new Map<string, string>());
  const sidechainRunRef = useRef<string | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const applyAgentResult: ApplyAgentResult = useAgentResultHandler({
    activeSessionId: "session-1",
    setChatMessages,
    syncPresentation,
    activity: {
      activeRunTraceRef,
      streamMessageIdsRef,
      sidechainRunRef,
    },
    notify,
  });
  const activity = {
    activityTrace: [],
    agentRunPhase: "idle",
    activeRunIdRef,
    activeRunTraceRef,
    streamMessageIdsRef,
    sidechainRunRef,
    syncActivityTrace(next: AgentActivityItem[]) {
      activeRunTraceRef.current = next;
    },
    beginRunActivity: vi.fn(),
    finishRunActivity: vi.fn(),
    waitForRunStreamCompletion: vi.fn(async () => undefined),
  } satisfies AgentActivityStreamController;

  actions = useDisplayEventActions({
    busy: isBusy,
    setBusy,
    activeSessionId: "session-1",
    setChatMessages,
    syncPresentation,
    setSelectedDesignSystem: vi.fn(),
    activity,
    agentRun: {
      startAgent,
      applyAgentResult,
    },
    notify,
  });
  messages = chatMessages;
  busy = isBusy;
  return null;
}

describe("display event approval actions", () => {
  beforeEach(() => {
    clearAllDisplayCardManagers();
    notify.mockClear();
    syncPresentation.mockClear();
    startAgent.mockClear();
    useProjectStore.setState({
      hydrateProjectArtifacts: vi.fn(async () => undefined),
      pptJob: matchingPptJob,
    });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({
      hydrateProjectArtifacts: originalHydrate,
      pptJob: null,
    });
  });

  it("keeps the completed Query intact when Proposal application fails", async () => {
    const resumeAgentRun = vi.fn(async () => ({
      status: "failed" as const,
      error: "演示文稿已变化，请重新生成方案。",
    }));
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        resumeAgentRun,
      },
    });
    render(<Harness />);

    await act(async () => {
      await actions.resolveApproval(approvalEvent, true);
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "assistant-1",
      runStatus: "completed",
    });
    expect(messages[0]?.runError).toBeUndefined();
    expect(resumeAgentRun).toHaveBeenCalledWith("session-1", "proposal-1", true);
    expect(notify).toHaveBeenCalledWith("演示文稿已变化，请重新生成方案。");
    expect(busy).toBe(false);
  });

  it("keeps the Proposal active while the lifecycle projection is unavailable", async () => {
    const resumeAgentRun = vi.fn();
    useProjectStore.setState({ pptJob: null });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { resumeAgentRun },
    });
    ingestDisplayEvent(approvalEvent);
    render(<Harness />);

    await act(async () => {
      await actions.resolveApproval(approvalEvent, true);
    });

    expect(resumeAgentRun).not.toHaveBeenCalled();
    expect(useReviewCardManager.getState().cards[0]?.status).toBe("active");
    expect(notify).toHaveBeenCalledWith("演示文稿生命周期状态尚未加载，请稍后重试。");
    expect(busy).toBe(false);
  });

  it.each<[string, PptJobProjection]>([
    [
      "the ProposalId differs",
      {
        ...matchingPptJob,
        proposalId: "proposal-2",
        stateRevision: 2,
      },
    ],
    [
      "the Job is not waiting for approval",
      {
        ...matchingPptJob,
        status: "waiting_user",
        stateRevision: 2,
      },
    ],
    [
      "the Proposal is no longer waiting for approval",
      {
        ...matchingPptJob,
        proposalStatus: "superseded",
        stateRevision: 2,
      },
    ],
  ])("refuses a persisted Proposal card when %s", async (_case, pptJob) => {
    const resumeAgentRun = vi.fn();
    useProjectStore.setState({ pptJob });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { resumeAgentRun },
    });
    ingestDisplayEvent(approvalEvent);
    render(<Harness />);

    await act(async () => {
      await actions.resolveApproval(approvalEvent, true);
    });

    expect(resumeAgentRun).not.toHaveBeenCalled();
    expect(useReviewCardManager.getState().cards[0]?.status).toBe("resolved");
    expect(notify).toHaveBeenCalledWith(
      "该 Proposal 已失效或不再等待审批，请基于当前演示重新生成。",
    );
    expect(busy).toBe(false);
  });

  it("reactivates the review card when IPC itself fails without adding raw transcript text", async () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        resumeAgentRun: vi.fn(async () => {
          throw new Error("internal stack detail");
        }),
      },
    });
    ingestDisplayEvent(approvalEvent);
    setDisplayCardStatus(approvalEvent.eventId, "resolved");
    render(<Harness />);

    await act(async () => {
      await actions.resolveApproval(approvalEvent, true);
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.runStatus).toBe("completed");
    expect(useReviewCardManager.getState().cards[0]?.status).toBe("active");
    expect(notify).toHaveBeenCalledWith("确认变更失败，请重试。");
    expect(busy).toBe(false);
  });

  it("sends the question identity for Main to validate before settling it", () => {
    render(<Harness />);
    const questionEvent = {
      protocolVersion: 1 as const,
      eventId: "question-1",
      emittedAt: "2026-07-25T00:00:00.000Z",
      kind: "interaction.question-requested" as const,
      category: "interaction" as const,
      source: { kind: "tool" as const, toolName: "AskUser" },
      scope: {
        sessionId: "session-1",
        runId: "run-1",
        threadId: "thread-1",
        anchorMessageId: "assistant-1",
      },
      semantics: {
        blocking: true,
        requiresResponse: true,
        priority: "high" as const,
      },
      payload: {
        message: "请选择目标受众",
      },
    } satisfies Extract<DisplayEvent, { kind: "interaction.question-requested" }>;

    act(() => {
      actions.resolveQuestion(questionEvent, {
        optionIds: [],
        value: "面向管理层",
        label: "管理层",
        resolvedAt: "2026-07-25T00:00:00.000Z",
      });
    });

    expect(messages[0]?.runStatus).toBe("completed");
    expect(startAgent).toHaveBeenCalledWith("面向管理层", undefined, {
      userDisplayContent: "管理层",
      questionRunId: "run-1",
    });
  });

  it("applies a patch only through open/save after matching its complete baseline", async () => {
    const openProjectFile = vi.fn(async () => ({
      path: "brief.md",
      content: "# Before\n",
      version: `sha256:${"a".repeat(64)}`,
      mtimeMs: 1,
      size: 9,
      encoding: "utf8" as const,
      newline: "lf" as const,
      editToken: "11111111-1111-4111-8111-111111111111",
      editable: true,
    }));
    const saveProjectFile = vi.fn(async () => ({
      path: "brief.md",
      changed: true,
      changedArtifactId: "brief",
      version: `sha256:${"b".repeat(64)}`,
      mtimeMs: 2,
      size: 8,
      encoding: "utf8" as const,
      newline: "lf" as const,
      characterCount: 8,
      editToken: "11111111-1111-4111-8111-111111111111",
    }));
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { openProjectFile, saveProjectFile },
    });
    render(<Harness />);

    await act(async () => {
      await actions.resolvePatch(patchEvent, true);
    });

    expect(openProjectFile).toHaveBeenCalledWith("session-1", "brief.md");
    expect(saveProjectFile).toHaveBeenCalledWith(
      "session-1",
      "brief.md",
      "# After\n",
      "11111111-1111-4111-8111-111111111111",
      `sha256:${"a".repeat(64)}`,
    );
    expect(useProjectStore.getState().hydrateProjectArtifacts).toHaveBeenCalledWith("session-1");
    expect(notify).toHaveBeenCalledWith("补丁已应用");
  });

  it("keeps a patch active when its disk baseline changed or is missing", async () => {
    const openProjectFile = vi.fn(async () => ({
      path: "brief.md",
      content: "# Newer disk content\n",
      version: `sha256:${"c".repeat(64)}`,
      mtimeMs: 2,
      size: 21,
      encoding: "utf8" as const,
      newline: "lf" as const,
      editToken: "22222222-2222-4222-8222-222222222222",
      editable: true,
    }));
    const saveProjectFile = vi.fn();
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { openProjectFile, saveProjectFile },
    });
    ingestDisplayEvent(patchEvent);
    setDisplayCardStatus(patchEvent.eventId, "resolved");
    render(<Harness />);

    await act(async () => {
      await actions.resolvePatch(patchEvent, true);
    });

    expect(saveProjectFile).not.toHaveBeenCalled();
    expect(useReviewCardManager.getState().cards[0]?.status).toBe("active");
    expect(notify).toHaveBeenCalledWith("补丁基线已变化，当前补丁未应用；请重新读取后生成新补丁。");

    const missingBaselineEvent = {
      ...patchEvent,
      eventId: "patch:missing-baseline",
      payload: {
        ...patchEvent.payload,
        patchId: "patch-2",
        contentBefore: undefined,
      },
    };
    ingestDisplayEvent(missingBaselineEvent);
    setDisplayCardStatus(missingBaselineEvent.eventId, "resolved");
    openProjectFile.mockClear();
    notify.mockClear();

    await act(async () => {
      await actions.resolvePatch(missingBaselineEvent, true);
    });

    expect(openProjectFile).not.toHaveBeenCalled();
    expect(saveProjectFile).not.toHaveBeenCalled();
    expect(
      useReviewCardManager
        .getState()
        .cards.find((card) => card.event.eventId === missingBaselineEvent.eventId)?.status,
    ).toBe("active");
    expect(notify).toHaveBeenCalledWith("补丁缺少完整的读取基线，无法安全应用。");
  });
});
