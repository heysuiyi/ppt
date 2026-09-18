// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityStreamController } from "../src/renderer/src/app/agent/useAgentActivityStream";
import { useAgentRunController } from "../src/renderer/src/app/agent/useAgentRunController";
import { resolveAgentGatewayPreferences } from "../src/shared/agent-gateway-config";
import { DEFAULT_AGENT_STEP_LIMITS } from "../src/shared/agent-step-limits";

describe("useAgentRunController model guard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("fails closed before session or run side effects when no model is available", async () => {
    const createSession = vi.fn();
    const saveSessionMessages = vi.fn();
    const startAgentRun = vi.fn();
    const continueAgentRun = vi.fn();
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        createSession,
        saveSessionMessages,
        startAgentRun,
        continueAgentRun,
      },
    });

    const setRequest = vi.fn();
    const setBusy = vi.fn();
    const setChatMessages = vi.fn();
    const applySessionState = vi.fn();
    const syncPresentation = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
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
      waitForRunStreamCompletion: vi.fn().mockResolvedValue(undefined),
    };

    const { result } = renderHook(() =>
      useAgentRunController({
        request: "生成一份季度经营复盘",
        setRequest,
        busy: false,
        setBusy,
        activeSessionId: "",
        sessionLoaded: false,
        localStoragePath: "",
        chatMessages: [],
        setChatMessages,
        applySessionState,
        syncPresentation,
        settings: {
          agentStepLimits: DEFAULT_AGENT_STEP_LIMITS,
          agentGatewayPreferences: resolveAgentGatewayPreferences(),
          enabledModels: [],
          selectedModel: undefined,
          executionStrategy: "REQUEST_APPROVAL",
        },
        activity,
        notify,
      }),
    );

    await act(async () => {
      await result.current.startAgent();
    });

    expect(notify).toHaveBeenCalledWith("没有可用的已配置模型；请先在设置中保存 API Key");
    expect(setBusy).not.toHaveBeenCalled();
    expect(setChatMessages).not.toHaveBeenCalled();
    expect(applySessionState).not.toHaveBeenCalled();
    expect(activity.beginRunActivity).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(saveSessionMessages).not.toHaveBeenCalled();
    expect(startAgentRun).not.toHaveBeenCalled();
    expect(continueAgentRun).not.toHaveBeenCalled();
  });
});
