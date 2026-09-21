import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentModelGateway } from "../src/main/agent/gateway/types";
import { DurableConversationHistoryStore } from "../src/main/agent/persistence/conversation-history-store";
import { DurableRunStore } from "../src/main/agent/persistence/durable-run-store";
import type { StopBlock } from "../src/main/agent/runtime/hooks/hook-blocks";
import { clearHooks, registerHook } from "../src/main/agent/runtime/hooks/hook-registry";
import type { ToolDefinition } from "../src/main/agent/tools/tool-definition";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";
import { createFakeCommandProposalTool } from "./fake-command-proposal-tool";

function textGateway(text: string): AgentModelGateway {
  return {
    async queryModel() {
      return { provider: "anthropic", model: "test", content: [{ type: "text", text }] };
    },
    async *queryModelStream() {
      yield { type: "complete" as const, content: [{ type: "text" as const, text }] };
    },
  };
}

function failingGateway(message: string): AgentModelGateway {
  return {
    async queryModel() {
      throw new Error(message);
    },
    async *queryModelStream() {
      throw new Error(message);
    },
  };
}

describe("AgentRuntime terminal boundaries", () => {
  afterEach(() => clearHooks());

  it("returns an already committed result when the Stop hook throws", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runtime-stop-hook-"));
    registerHook("Stop", () => {
      throw new Error("stop audit unavailable");
    });

    const result = await createPptRuntime(new ToolRegistry(), textGateway("completed")).run({
      threadId: "stop-hook-thread",
      request: "finish",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
    });

    expect(result).toEqual({ type: "message", content: "completed" });
    const checkpoint = await new DurableRunStore(workspaceRoot).load("stop-hook-thread");
    expect(checkpoint).toMatchObject({ status: "completed", phase: "finished" });
  });

  it("records a UserPromptSubmit short circuit as visible assistant History", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runtime-prompt-stop-history-"));
    registerHook("UserPromptSubmit", () => ({
      type: "stop",
      reason: "Request stopped before model execution.",
    }));

    const result = await createPptRuntime(new ToolRegistry(), textGateway("unused")).run({
      threadId: "prompt-stop-history-thread",
      request: "stop this request",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
    });

    expect(result).toEqual({
      type: "message",
      content: "Request stopped before model execution.",
    });
    expect(
      await new DurableConversationHistoryStore(workspaceRoot).load("prompt-stop-history-thread"),
    ).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "stop this request" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Request stopped before model execution." }],
      },
    ]);
  });

  it("records a PreToolUse hook stop without persisting an unresolved tool_use", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runtime-tool-stop-history-"));
    const schema = z.object({ value: z.number() });
    const tool: ToolDefinition<typeof schema, { ok: true }> = {
      name: "StoppedTool",
      description: "Stopped before execution.",
      category: "core",
      loadPolicy: "core",
      inputSchema: schema,
      outputSchema: z.object({ ok: z.literal(true) }),
      risk: "low",
      async execute() {
        throw new Error("StoppedTool must not execute.");
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    registerHook("PreToolUse", () => ({
      type: "stop",
      reason: "Tool stopped by policy hook.",
    }));
    const gateway: AgentModelGateway = {
      async queryModel() {
        return {
          provider: "anthropic",
          model: "test",
          content: [
            {
              type: "tool_use",
              id: "stopped-tool-use",
              name: "StoppedTool",
              input: { value: 1 },
            },
          ],
        };
      },
      async *queryModelStream() {
        yield {
          type: "complete" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "stopped-tool-use",
              name: "StoppedTool",
              input: { value: 1 },
            },
          ],
        };
      },
    };

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "tool-stop-history-thread",
      request: "call the stopped tool",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
    });

    expect(result).toEqual({ type: "message", content: "Tool stopped by policy hook." });
    const history = await new DurableConversationHistoryStore(workspaceRoot).load(
      "tool-stop-history-thread",
    );
    expect(history?.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Tool stopped by policy hook." }],
    });
    expect(
      history?.flatMap((message) => message.content).some((block) => block.type === "tool_use"),
    ).toBe(false);
  });

  it("records the visible step-limit result after the committed tool batch", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runtime-step-limit-history-"));
    const schema = z.object({});
    const tool: ToolDefinition<typeof schema, { ok: true }> = {
      name: "OneStepTool",
      description: "Completes one tool batch.",
      category: "core",
      loadPolicy: "core",
      inputSchema: schema,
      outputSchema: z.object({ ok: z.literal(true) }),
      risk: "low",
      async execute() {
        return { ok: true };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const gateway: AgentModelGateway = {
      async queryModel() {
        return {
          provider: "anthropic",
          model: "test",
          content: [
            {
              type: "tool_use",
              id: "one-step-tool-use",
              name: "OneStepTool",
              input: {},
            },
          ],
        };
      },
      async *queryModelStream() {
        yield {
          type: "complete" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "one-step-tool-use",
              name: "OneStepTool",
              input: {},
            },
          ],
        };
      },
    };

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "step-limit-history-thread",
      request: "use one step",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
      maxSteps: 1,
    });
    if (result.type !== "message") throw new Error("Expected a visible step-limit message.");

    const history = await new DurableConversationHistoryStore(workspaceRoot).load(
      "step-limit-history-thread",
    );
    expect(history?.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: result.content }],
    });
    expect(history?.flatMap((message) => message.content)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_use", id: "one-step-tool-use" }),
        expect.objectContaining({ type: "tool_result", toolUseId: "one-step-tool-use" }),
      ]),
    );
  });

  it("persists a paired result for a terminal command_proposal call", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runtime-terminal-tool-history-"));
    const registry = new ToolRegistry();
    registry.register(createFakeCommandProposalTool());
    const gateway: AgentModelGateway = {
      async queryModel() {
        return {
          provider: "anthropic",
          model: "test",
          content: [
            {
              type: "tool_use",
              id: "terminal-submit",
              name: "FakeSubmitCommands",
              input: {
                summary: "Update title",
                risk: "low",
                commands: [
                  {
                    id: "title-command",
                    type: "set-presentation-title",
                    title: "Updated title",
                  },
                ],
              },
            },
          ],
        };
      },
      async *queryModelStream() {
        yield {
          type: "complete" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "terminal-submit",
              name: "FakeSubmitCommands",
              input: {
                summary: "Update title",
                risk: "low",
                commands: [
                  {
                    id: "title-command",
                    type: "set-presentation-title",
                    title: "Updated title",
                  },
                ],
              },
            },
          ],
        };
      },
    };

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "terminal-tool-history-thread",
      request: "update title",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
    });

    expect(result.type).toBe("command_proposal");
    const history = await new DurableConversationHistoryStore(workspaceRoot).load(
      "terminal-tool-history-thread",
    );
    expect(history?.flatMap((message) => message.content)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_use", id: "terminal-submit" }),
        expect.objectContaining({ type: "tool_result", toolUseId: "terminal-submit" }),
      ]),
    );
    const checkpoint = await new DurableRunStore(workspaceRoot).load(
      "terminal-tool-history-thread",
    );
    expect(checkpoint).toMatchObject({
      status: "completed",
      committedState: {
        turnCount: 1,
        transition: { reason: "completed" },
      },
    });
    expect(checkpoint?.version === 2 ? checkpoint.inflight : undefined).toBeUndefined();
  });

  it("persists failed and emits a failed Stop reason without replacing the primary error", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runtime-failed-"));
    const stops: StopBlock[] = [];
    registerHook("Stop", (block) => {
      stops.push(block as StopBlock);
      return null;
    });

    await expect(
      createPptRuntime(new ToolRegistry(), failingGateway("primary model failure")).run({
        threadId: "failed-thread",
        request: "fail",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        workspaceRoot,
      }),
    ).rejects.toThrow("primary model failure");

    const checkpoint = await new DurableRunStore(workspaceRoot).load("failed-thread");
    expect(checkpoint).toMatchObject({
      status: "failed",
      phase: "finished",
      error: expect.stringContaining("primary model failure"),
    });
    expect(stops.at(-1)?.reason).toBe("failed");
  });

  it("persists interrupted and emits aborted when the external signal is cancelled", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runtime-aborted-"));
    const controller = new AbortController();
    controller.abort("cancelled by test");
    const stops: StopBlock[] = [];
    registerHook("Stop", (block) => {
      stops.push(block as StopBlock);
      return null;
    });

    await expect(
      createPptRuntime(new ToolRegistry(), textGateway("unused")).run({
        threadId: "aborted-thread",
        request: "abort",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        workspaceRoot,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Run aborted by user");

    const checkpoint = await new DurableRunStore(workspaceRoot).load("aborted-thread");
    expect(checkpoint).toMatchObject({ status: "interrupted", phase: "finished" });
    expect(stops.at(-1)?.reason).toBe("aborted");
  });

  it("classifies a downstream AbortError as interrupted even before the signal flips", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runtime-downstream-abort-"));
    const stops: StopBlock[] = [];
    registerHook("Stop", (block) => {
      stops.push(block as StopBlock);
      return null;
    });
    const abortError = Object.assign(new Error("provider cancelled"), { name: "AbortError" });
    const gateway: AgentModelGateway = {
      async queryModel() {
        throw abortError;
      },
      async *queryModelStream() {
        throw abortError;
      },
    };

    await expect(
      createPptRuntime(new ToolRegistry(), gateway).run({
        threadId: "downstream-abort-thread",
        request: "abort",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        workspaceRoot,
      }),
    ).rejects.toBe(abortError);

    const checkpoint = await new DurableRunStore(workspaceRoot).load("downstream-abort-thread");
    expect(checkpoint).toMatchObject({ status: "interrupted", phase: "finished" });
    expect(stops.at(-1)?.reason).toBe("aborted");
  });

  it("does not let a late background settlement overwrite a failed terminal checkpoint", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runtime-late-background-"));
    const progress: Array<{ type: string; [key: string]: unknown }> = [];
    let resolvePreview!: () => void;
    const previewDone = new Promise<void>((resolve) => {
      resolvePreview = resolve;
    });
    const schema = z.object({ slideId: z.string(), run_in_background: z.boolean().optional() });
    const previewTool: ToolDefinition<typeof schema, { ok: true }> = {
      name: "PreviewSlide",
      description: "Ignores cancellation to exercise late settlement",
      category: "core",
      loadPolicy: "core",
      inputSchema: schema,
      behavior: {
        background: {
          isRequested: (args) => args.run_in_background === true,
          describe: (args) => `PreviewSlide: ${args.slideId}`,
        },
      },
      risk: "low",
      execute: async () => {
        await previewDone;
        return { ok: true };
      },
    };
    const registry = new ToolRegistry();
    registry.register(previewTool);
    let modelStep = 0;
    const gateway: AgentModelGateway = {
      async queryModel() {
        modelStep += 1;
        if (modelStep === 1) {
          return {
            provider: "anthropic",
            model: "test",
            content: [
              {
                type: "tool_use" as const,
                id: "late-preview",
                name: "PreviewSlide",
                input: { slideId: "slide-1", run_in_background: true },
              },
            ],
          };
        }
        throw new Error("model failed while preview was running");
      },
      async *queryModelStream() {
        throw new Error("streaming not expected");
      },
    };

    await expect(
      createPptRuntime(registry, gateway).run({
        threadId: "late-background-thread",
        runId: "late-background-run",
        request: "preview",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        workspaceRoot,
        onProgress: (event) => progress.push(event),
      }),
    ).rejects.toThrow("model failed while preview was running");

    resolvePreview();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      progress
        .filter((event) => event.type === "tool-state" && event.toolCallId === "late-preview")
        .map((event) => event.status),
    ).toEqual(["running", "denied"]);
    const checkpoint = await new DurableRunStore(workspaceRoot).load("late-background-thread");
    expect(checkpoint).toMatchObject({ status: "failed", phase: "finished" });
  });

  it("removes abort forwarding when a durable lease cannot be acquired", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runtime-lease-busy-"));
    const store = new DurableRunStore(workspaceRoot);
    const opened = await store.openLease({
      threadId: "busy-thread",
      runId: "existing-run",
      resume: false,
    });
    expect(opened.type).toBe("opened");
    if (opened.type !== "opened") return;

    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    await expect(
      createPptRuntime(new ToolRegistry(), textGateway("unused")).run({
        threadId: "busy-thread",
        runId: "new-run",
        request: "blocked",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        workspaceRoot,
        signal: controller.signal,
      }),
    ).rejects.toThrow("already owned");

    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    await store.closeLease(opened.lease);
  });

  it("closes a newly acquired lease when the post-lease History read fails", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runtime-history-read-failed-"));
    const historyLoad = vi
      .spyOn(DurableConversationHistoryStore.prototype, "load")
      .mockRejectedValueOnce(new Error("History storage unavailable"));
    try {
      await expect(
        createPptRuntime(new ToolRegistry(), textGateway("unused")).run({
          threadId: "history-read-failed-thread",
          runId: "failed-history-reader",
          request: "read previous History",
          presentationSnapshot: createStarterPresentation(),
          selectedElementIds: [],
          workspaceRoot,
        }),
      ).rejects.toThrow("History storage unavailable");
    } finally {
      historyLoad.mockRestore();
    }

    const reopened = await new DurableRunStore(workspaceRoot).openLease({
      threadId: "history-read-failed-thread",
      runId: "replacement-history-reader",
      resume: false,
    });
    expect(reopened.type).toBe("opened");
    if (reopened.type === "opened") {
      await new DurableRunStore(workspaceRoot).closeLease(reopened.lease);
    }
  });
});
