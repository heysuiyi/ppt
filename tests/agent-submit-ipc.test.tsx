// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunAccepted, AgentStreamEvent, SubmitAgentRequest } from "../app/shared/ipc";
import { submitAgentRequestSchema } from "../app/shared/ipc";

// Reload the modules under test to isolate their pending-save queue between test cases.
afterEach(() => vi.resetModules());

describe("Renderer submit boundary", () => {
  it("uses one submit IPC and listens before Main can accept or stream", async () => {
    const { executeAgentRun } = await import("../app/renderer/src/app/agent/agentRunExecution");
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
      reasoningEffort: "high",
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

  it("validates optional request reasoning effort without null reset semantics", () => {
    const request = {
      requestId: crypto.randomUUID(),
      userMessageId: crypto.randomUUID(),
      assistantMessageId: crypto.randomUUID(),
      target: { type: "new-session" },
      prompt: "test",
      modelId: "saved-model",
      action: { type: "message" },
    };
    expect(submitAgentRequestSchema.parse(request)).not.toHaveProperty("reasoningEffort");
    for (const reasoningEffort of ["none", "minimal", "low", "medium", "high", "xhigh"])
      expect(submitAgentRequestSchema.parse({ ...request, reasoningEffort }).reasoningEffort).toBe(
        reasoningEffort,
      );
    for (const reasoningEffort of [null, "", "HIGH", "ultra", 3])
      expect(submitAgentRequestSchema.safeParse({ ...request, reasoningEffort }).success).toBe(
        false,
      );
  });

  it("does not submit using stale settings after a failed settings save", async () => {
    const { saveExecutionPreferences } = await import(
      "../app/renderer/src/app/agentSettingsPersistence"
    );
    const { executeAgentRun } = await import("../app/renderer/src/app/agent/agentRunExecution");
    const submit = vi.fn();
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        submitAgentRun: submit,
        saveAgentPreferences: vi.fn().mockRejectedValue(new Error("settings write failed")),
      },
    });
    const { agentPreferencesSchema } = await import("../src/shared/agent-configuration");
    const { DEFAULT_AGENT_STEP_LIMITS } = await import("../src/shared/agent-step-limits");
    const preferences = agentPreferencesSchema.parse({
      gateway: {},
      stepLimits: DEFAULT_AGENT_STEP_LIMITS,
      executionStrategy: "AUTO",
      defaultTemplateId: "test",
    });
    await expect(saveExecutionPreferences(preferences)).rejects.toThrow("settings write failed");
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
