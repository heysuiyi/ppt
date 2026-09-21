// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAgentRun } from "../src/renderer/src/app/agent/agentRunExecution";
import type { AgentActivityStreamController } from "../src/renderer/src/app/agent/useAgentActivityStream";
import { useAgentRunController } from "../src/renderer/src/app/agent/useAgentRunController";
import { useSessionController } from "../src/renderer/src/app/session/useSessionController";
import { useProjectStore } from "../src/renderer/src/components/project-store";
import { createSessionPresentation, type SessionBootstrap } from "../src/shared/session";

vi.mock("../src/renderer/src/app/agent/agentRunExecution", () => ({ executeAgentRun: vi.fn() }));

function snapshot(id: string): SessionBootstrap {
  const session = {
    id,
    title: id,
    createdAt: "2026-09-17",
    updatedAt: "2026-09-17",
    slideCount: 0,
    revision: 0,
    workspacePath: `e:/work/${id}`,
  };
  return {
    sessions: [session],
    activeSession: {
      session,
      presentation: createSessionPresentation(id),
      messages: [],
      displayCards: [],
      project: { rootPath: `e:/work/${id}/sandboxes/${id}`, artifacts: [] },
    },
  };
}

const originalStore = useProjectStore.getState();
const options = {
  busy: false,
  presentation: undefined,
  loadPresentation: vi.fn(),
  resetPresentation: vi.fn(),
  syncPresentation: vi.fn(async () => undefined),
  notify: vi.fn(),
  markSettingsSaving: vi.fn(),
};
const selectSession = vi.fn(async (id: string) => snapshot(id));
const deleteSession = vi.fn();
const selectDirectory = vi.fn();
const createSession = vi.fn(async () => snapshot("created"));
const saveSessionMessages = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({
    hydrateProjectArtifacts: vi.fn(async () => undefined),
    hydratePptJob: vi.fn(async () => undefined),
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSessionState: vi.fn(async () => ({ sessions: [] })),
      createSession,
      selectSession,
      deleteSession,
      selectDirectory,
      saveSessionMessages,
      pollLeadInbox: vi.fn(async () => ({ hasMessages: false, count: 0 })),
      saveSessionDisplayCards: vi.fn(async () => undefined),
    },
  });
});

async function setupRun() {
  const activity: AgentActivityStreamController = {
    activityTrace: [],
    agentRunPhase: "idle",
    activeRunIdRef: { current: null },
    activeRunTraceRef: { current: [] },
    streamMessageIdsRef: { current: new Map() },
    sidechainRunRef: { current: null },
    syncActivityTrace: vi.fn(),
    beginRunActivity: vi.fn(),
    finishRunActivity: vi.fn(),
    waitForRunStreamCompletion: vi.fn(async () => undefined),
  };
  const model = {
    id: "model",
    name: "Model",
    provider: "openai" as const,
    model: "model",
    baseURL: "https://example.com",
    credentialConfigured: true,
  };
  const hook = renderHook(() => {
    const [busy, setBusy] = useState(false);
    const session = useSessionController({ ...options, busy });
    const run = useAgentRunController({
      ...session,
      busy,
      setBusy,
      syncPresentation: options.syncPresentation,
      notify: options.notify,
      activity,
      settings: {
        enabledModels: [model],
        selectedModel: model,
        executionStrategy: "REQUEST_APPROVAL",
      },
    });
    return { session, run, busy };
  });
  await waitFor(() => expect(hook.result.current.session.sessionLoaded).toBe(true));
  return hook;
}

describe("composer submission boundaries", () => {
  it("does not start an inbox turn when an existing session is loaded", async () => {
    vi.mocked(window.desktopApi.pollLeadInbox).mockResolvedValue({
      hasMessages: true,
      count: 1,
      preview: "interrupted teammate",
      types: ["error"],
    });
    const { result } = await setupRun();
    await act(async () => result.current.session.selectSession("restored"));
    expect(window.desktopApi.pollLeadInbox).not.toHaveBeenCalled();
    expect(executeAgentRun).not.toHaveBeenCalled();
  });

  it("enables inbox turns after an explicit run, then stops after an inbox failure", async () => {
    const { result } = await setupRun();
    vi.mocked(executeAgentRun).mockImplementationOnce(async ({ request, onAccepted }) => {
      onAccepted({
        requestId: request.requestId,
        runId: request.requestId,
        sessionId: "created",
        threadId: "thread",
        bootstrap: snapshot("created"),
      });
      return { status: "chat", message: "done" };
    });
    await act(async () => result.current.run.startAgent("start"));
    vi.mocked(window.desktopApi.pollLeadInbox).mockResolvedValue({
      hasMessages: true,
      count: 1,
      preview: "result",
      types: ["result"],
    });
    vi.mocked(executeAgentRun).mockRejectedValueOnce(new Error("lease busy"));
    await waitFor(() => expect(executeAgentRun).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    const pollsAfterFailure = vi.mocked(window.desktopApi.pollLeadInbox).mock.calls.length;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1_100)));
    expect(executeAgentRun).toHaveBeenCalledTimes(2);
    expect(window.desktopApi.pollLeadInbox).toHaveBeenCalledTimes(pollsAfterFailure);
  });

  it("fills suggestions without starting a run", async () => {
    const { result } = await setupRun();
    act(() => result.current.run.suggestPrompt("建议内容"));
    expect(result.current.session.request).toBe("建议内容");
    expect(createSession).not.toHaveBeenCalled();
    expect(executeAgentRun).not.toHaveBeenCalled();
  });

  it("keeps the initial draft and leaves the session uncreated when creation fails", async () => {
    const { result } = await setupRun();
    vi.mocked(executeAgentRun).mockRejectedValueOnce(new Error("create failed"));
    act(() => result.current.session.setRequest("保留首次输入"));
    await act(async () => result.current.run.startAgent());
    expect(result.current.session.request).toBe("保留首次输入");
    expect(result.current.session.activeSessionId).toBe("");
    expect(result.current.busy).toBe(false);
    expect(createSession).not.toHaveBeenCalled();
    expect(saveSessionMessages).not.toHaveBeenCalled();
  });

  it("retains the draft when Main rejects admission", async () => {
    const { result } = await setupRun();
    vi.mocked(executeAgentRun).mockRejectedValueOnce(new Error("save failed"));
    act(() => result.current.session.setRequest("保存失败时保留"));
    await act(async () => result.current.run.startAgent());
    expect(result.current.session.activeSessionId).toBe("");
    expect(result.current.session.request).toBe("保存失败时保留");
    expect(saveSessionMessages).not.toHaveBeenCalled();
  });

  it("consumes the submitted draft even if the model later fails, preserving the user message", async () => {
    const { result } = await setupRun();
    vi.mocked(executeAgentRun).mockImplementationOnce(async ({ request, onAccepted }) => {
      const state = snapshot("created");
      state.activeSession!.messages = [
        { id: request.userMessageId, role: "user", content: request.prompt },
        {
          id: request.assistantMessageId,
          role: "assistant",
          content: "",
          runId: request.requestId,
          runStatus: "running",
        },
      ];
      onAccepted({
        requestId: request.requestId,
        runId: request.requestId,
        sessionId: "created",
        threadId: request.requestId,
        bootstrap: state,
      });
      throw new Error("model failed");
    });
    act(() => result.current.session.setRequest("模型失败仍可重试"));
    await act(async () => result.current.run.startAgent());
    expect(result.current.session.request).toBe("");
    expect(result.current.session.chatMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "模型失败仍可重试" }),
      ]),
    );
    expect(result.current.busy).toBe(false);
  });
});

afterEach(() => {
  cleanup();
  useProjectStore.setState(originalStore, true);
});

async function setup() {
  const hook = renderHook(() => useSessionController(options));
  await waitFor(() => expect(hook.result.current.sessionLoaded).toBe(true));
  return hook;
}

describe("session composer drafts", () => {
  it("restores separate drafts when switching between empty sessions", async () => {
    const { result } = await setup();
    await act(async () => result.current.selectSession("a"));
    act(() => result.current.setRequest("A 未发送"));
    await act(async () => result.current.selectSession("b"));
    expect(result.current.request).toBe("");
    act(() => result.current.setRequest("B 未发送"));
    await act(async () => result.current.selectSession("a"));
    expect(result.current.request).toBe("A 未发送");
    expect(result.current.chatMessages).toEqual([]);
    expect(result.current.localStoragePath).toBe("e:/work/a");
    await act(async () => result.current.selectSession("b"));
    expect(result.current.request).toBe("B 未发送");
  });

  it("retains input when switching fails", async () => {
    const { result } = await setup();
    await act(async () => result.current.selectSession("a"));
    act(() => result.current.setRequest("保留"));
    selectSession.mockRejectedValueOnce(new Error("failed"));
    await act(async () => result.current.selectSession("b"));
    expect(result.current.activeSessionId).toBe("a");
    expect(result.current.request).toBe("保留");
    expect(result.current.isSessionSwitching).toBe(false);
  });

  it("migrates the draft on creation and retains it until submission consumes it", async () => {
    const { result } = await setup();
    act(() => result.current.setRequest("首次请求"));
    act(() => result.current.applySessionState(snapshot("a"), { preserveDraft: true }));
    expect(result.current.request).toBe("首次请求");
    act(() => result.current.setRequest(""));
    await act(async () => result.current.selectSession("b"));
    await act(async () => result.current.selectSession("a"));
    expect(result.current.request).toBe("");
  });

  it("starts a fresh draft without discarding an existing session draft", async () => {
    const { result } = await setup();
    await act(async () => result.current.selectSession("a"));
    act(() => result.current.setRequest("A 未发送"));
    act(() => result.current.newSessionInWorkspace("E:/new"));
    expect(result.current.request).toBe("");
    expect(result.current.localStoragePath).toBe("e:/new");
    act(() => result.current.setRequest("临时输入"));
    act(() => result.current.newSessionInWorkspace("E:/other"));
    expect(result.current.request).toBe("");
    await act(async () => result.current.selectSession("a"));
    expect(result.current.request).toBe("A 未发送");
  });

  it("preserves the current draft on unrelated deletion and removes a deleted session draft", async () => {
    const { result } = await setup();
    await act(async () => result.current.selectSession("b"));
    act(() => result.current.setRequest("B 未发送"));
    await act(async () => result.current.selectSession("a"));
    act(() => result.current.setRequest("A 未发送"));
    deleteSession.mockResolvedValueOnce(snapshot("a"));
    await act(async () => result.current.deleteSession("b"));
    expect(result.current.request).toBe("A 未发送");
    await act(async () => result.current.selectSession("b"));
    expect(result.current.request).toBe("");
  });

  it("cannot change the workspace of an existing empty session", async () => {
    const { result } = await setup();
    await act(async () => result.current.selectSession("a"));
    await act(async () => result.current.selectWorkspaceFolder());
    expect(selectDirectory).not.toHaveBeenCalled();
    expect(result.current.localStoragePath).toBe("e:/work/a");
  });
});
