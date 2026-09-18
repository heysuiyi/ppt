// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunAccepted, AgentStreamEvent, SubmitAgentRequest } from "../src/shared/ipc";

afterEach(() => vi.resetModules());

describe("Renderer submit boundary", () => {
  it("uses one submit IPC and listens before Main can accept or stream", async () => {
    const { executeAgentRun } = await import("../src/renderer/src/app/agent/agentRunExecution");
    let accept!: (event: AgentRunAccepted) => void;
    let stream!: (event: AgentStreamEvent) => void;
    const stopAccepted = vi.fn();
    const stopStream = vi.fn();
    const request: SubmitAgentRequest = {
      requestId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(),
      assistantMessageId: crypto.randomUUID(),
      target: { type: "new-session" },
      prompt: "做演示文稿",
      modelId: "saved-model",
      action: { type: "message" },
    };
    const submit = vi.fn(async () => {
      accept({
        requestId: request.requestId,
        runId: request.requestId,
        sessionId: "session",
        threadId: "thread",
        bootstrap: { sessions: [] },
      });
      stream({ type: "stage-started", runId: request.requestId, stage: "any", message: "开始" });
      return { status: "chat", message: "完成" };
    });
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        submitAgentRun: submit,
        onAgentRunAccepted: (listener: typeof accept) => {
          accept = listener;
          return stopAccepted;
        },
        onAgentStream: (listener: typeof stream) => {
          stream = listener;
          return stopStream;
        },
      },
    });
    const onAccepted = vi.fn();
    const onRunning = vi.fn();
    await expect(executeAgentRun({ request, onAccepted, onRunning })).resolves.toEqual({
      status: "chat",
      message: "完成",
    });
    expect(submit).toHaveBeenCalledExactlyOnceWith(request);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onRunning).toHaveBeenCalledTimes(1);
    expect(stopAccepted).toHaveBeenCalledOnce();
    expect(stopStream).toHaveBeenCalledOnce();
  });

  it("does not submit using stale settings after a failed settings save", async () => {
    const { saveExecutionSettings } = await import(
      "../src/renderer/src/app/agentSettingsPersistence"
    );
    const { executeAgentRun } = await import("../src/renderer/src/app/agent/agentRunExecution");
    const submit = vi.fn();
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        submitAgentRun: submit,
        saveAgentSettings: vi.fn().mockRejectedValue(new Error("settings write failed")),
      },
    });
    const { agentSettingsSchema } = await import("../src/shared/agent-settings");
    const { DEFAULT_AGENT_STEP_LIMITS } = await import("../src/shared/agent-step-limits");
    const settings = agentSettingsSchema.parse({
      vendors: [],
      gateway: {},
      stepLimits: DEFAULT_AGENT_STEP_LIMITS,
      executionStrategy: "AUTO",
      defaultTemplateId: "test",
    });
    await expect(saveExecutionSettings(settings)).rejects.toThrow("settings write failed");
    const request: SubmitAgentRequest = {
      requestId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(),
      assistantMessageId: crypto.randomUUID(),
      target: { type: "new-session" },
      prompt: "test",
      modelId: "test",
      action: { type: "message" },
    };
    await expect(
      executeAgentRun({ request, onAccepted: vi.fn(), onRunning: vi.fn() }),
    ).rejects.toThrow("settings write failed");
    expect(submit).not.toHaveBeenCalled();
  });
});
