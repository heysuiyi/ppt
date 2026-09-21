import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  AgentModelGateway,
  AgentModelRequest,
  AgentModelResponse,
  AgentModelToolUseBlock,
} from "../src/main/agent/gateway/types";
import {
  BackgroundTaskManager,
  formatBackgroundNotifications,
} from "../src/main/agent/runtime/background/background-task-manager";
import { executeExtraToolTool } from "../src/main/agent/tools/core/execute-extra-tool";
import { searchExtraToolsTool } from "../src/main/agent/tools/core/search-extra-tools";
import type { ToolDefinition } from "../src/main/agent/tools/tool-definition";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { toToolSchema } from "../src/main/agent/tools/tool-schema";
import { previewSlideTool } from "../src/main/plugins/ppt/tools/preview-slide";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const textContent = (text: string) => [{ type: "text" as const, text }];

function createNativeGateway(
  handler: (
    request: AgentModelRequest,
    index: number,
  ) => AgentModelResponse | Promise<AgentModelResponse>,
): AgentModelGateway & { requests: AgentModelRequest[] } {
  let index = 0;
  const requests: AgentModelRequest[] = [];
  return {
    requests,
    async queryModel(request): Promise<AgentModelResponse> {
      requests.push(request);
      const response = await handler(request, index);
      index += 1;
      return response;
    },
    async *queryModelStream(request) {
      requests.push(request);
      const response = await handler(request, index);
      index += 1;
      yield { type: "complete" as const, content: response.content };
    },
  };
}

function modelToolCall(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): AgentModelToolUseBlock {
  return { type: "tool_use", id, name, input: args };
}

describe("background task manager", () => {
  it("does not start a prepared task until launch is explicitly called", async () => {
    const manager = new BackgroundTaskManager({ runId: "run-two-phase" });
    let executions = 0;
    const scheduled = manager.prepare({
      toolName: "PreviewSlide",
      label: "PreviewSlide: prepared",
      run: async () => {
        executions += 1;
        return { ok: true };
      },
    });

    expect(executions).toBe(0);
    expect(manager.snapshot()).toMatchObject([{ bgId: scheduled.bgId, status: "scheduled" }]);

    scheduled.launch();
    const notifications = await manager.drain();
    expect(executions).toBe(1);
    expect(notifications).toMatchObject([{ bgId: scheduled.bgId, status: "completed" }]);
  });

  it("collects completed and failed task notifications", async () => {
    const manager = new BackgroundTaskManager();
    manager.start({
      toolName: "PreviewSlide",
      label: "PreviewSlide: success",
      run: async () => ({ ok: true }),
    });
    manager.start({
      toolName: "PreviewSlide",
      label: "PreviewSlide: failure",
      run: async () => {
        throw new Error("boom");
      },
    });

    const notifications = await manager.drain();

    expect(notifications).toHaveLength(2);
    expect(notifications.map((item) => item.status).sort()).toEqual(["completed", "failed"]);
    expect(formatBackgroundNotifications(notifications)).toContain("<task_notification>");
    expect(manager.hasRunning()).toBe(false);
    expect(manager.collect()).toEqual([]);
  });

  it("persists terminal and consumed state with run-scoped ids", async () => {
    const manager = new BackgroundTaskManager({ runId: "run-a" });
    const bgId = manager.start({
      toolName: "PreviewSlide",
      toolUseId: "tool-use-a",
      label: "PreviewSlide: durable",
      run: async () => ({ ok: true }),
    });

    expect(bgId).toBe("run-a:bg_0001");
    const notifications = await manager.drain();
    expect(notifications).toMatchObject([{ bgId, status: "completed" }]);
    expect(manager.snapshot()).toMatchObject([
      {
        bgId,
        runId: "run-a",
        toolUseId: "tool-use-a",
        status: "consumed",
      },
    ]);

    const restored = new BackgroundTaskManager({
      runId: "run-b",
      recovered: manager.snapshot(),
    });
    expect(restored.hasPendingNotifications()).toBe(false);
    expect(restored.collect()).toEqual([]);
  });

  it("turns only genuinely running recovered tasks into one failure notification", () => {
    const restored = new BackgroundTaskManager({
      runId: "new-run",
      recovered: [
        {
          bgId: "old-run:bg_0001",
          runId: "old-run",
          toolUseId: "old-tool-use",
          toolName: "PreviewSlide",
          label: "old preview",
          status: "running",
          startedAt: 1,
        },
      ],
    });

    expect(restored.collect()).toMatchObject([
      {
        bgId: "old-run:bg_0001",
        status: "failed",
        isError: true,
      },
    ]);
    expect(restored.collect()).toEqual([]);
  });

  it("marks recovered scheduled tasks as safe to retry", () => {
    const restored = new BackgroundTaskManager({
      runId: "new-run",
      recovered: [
        {
          bgId: "old-run:bg_0002",
          runId: "old-run",
          toolUseId: "old-tool-use",
          toolName: "PreviewSlide",
          label: "old scheduled preview",
          status: "scheduled",
          startedAt: 1,
        },
      ],
    });

    expect(restored.collect()).toMatchObject([
      {
        bgId: "old-run:bg_0002",
        status: "failed",
        isError: true,
        content: expect.stringContaining("safe to schedule it again"),
      },
    ]);
  });
});

describe("AgentRuntime background tool path", () => {
  it("exposes run_in_background on slow core/deferred execution schemas", () => {
    const executeSpec = toToolSchema(executeExtraToolTool);
    expect(executeSpec.inputSchema.properties as Record<string, unknown>).toHaveProperty(
      "run_in_background",
    );

    const previewSpec = toToolSchema(previewSlideTool);
    expect(previewSpec.inputSchema.properties as Record<string, unknown>).toHaveProperty(
      "run_in_background",
    );
  });

  it("backgrounds ExecuteExtraTool when it runs a slow deferred tool", async () => {
    const exportWork = deferred<{ success: boolean; filePath: string }>();
    const events: string[] = [];
    let exportResolved = false;

    const exportSchema = z.object({
      format: z.enum(["pptx", "html", "pdf"]).default("pptx"),
      run_in_background: z.boolean().optional(),
    });
    const mockExportTool: ToolDefinition<
      typeof exportSchema,
      { success: boolean; filePath: string }
    > = {
      name: "ExportPptx",
      description: "Mock slow export",
      category: "deferred",
      loadPolicy: "deferred",
      inputSchema: exportSchema,
      behavior: {
        background: {
          isRequested: (args) => args.run_in_background === true,
          describe: (args) => `ExportPptx: ${args.format}`,
        },
      },
      risk: "medium",
      execute: async () => {
        events.push("export-start");
        const result = await exportWork.promise;
        exportResolved = true;
        events.push("export-finish");
        return result;
      },
    };

    const gateway = createNativeGateway((_request, index) => {
      if (index === 0) {
        return {
          provider: "anthropic",
          model: "test-model",
          content: [modelToolCall("call-search", "SearchExtraTools", { query: "ExportPptx" })],
        };
      }
      if (index === 1) {
        return {
          provider: "anthropic",
          model: "test-model",
          content: [
            modelToolCall("call-export", "ExecuteExtraTool", {
              toolName: "ExportPptx",
              toolArgs: { format: "pptx", run_in_background: true },
            }),
          ],
        };
      }
      if (index === 2) {
        events.push("third-model-call");
        expect(exportResolved).toBe(false);
        setTimeout(() => exportWork.resolve({ success: true, filePath: "deck.pptx" }), 0);
        return {
          provider: "anthropic",
          model: "test-model",
          content: textContent("Trying to finish before export result."),
        };
      }
      return {
        provider: "anthropic",
        model: "test-model",
        content: textContent("Finished after export notification."),
      };
    });

    const registry = new ToolRegistry();
    registry.register(searchExtraToolsTool);
    registry.register(executeExtraToolTool);
    registry.register(mockExportTool);
    const runtime = createPptRuntime(registry, gateway);

    const result = await runtime.run({
      threadId: "background-export-thread",
      request: "Export deck",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      requestToolApproval: async () => true,
    });

    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.content).toContain("Finished after export");
    }
    expect(events).toEqual(["export-start", "third-model-call", "export-finish"]);
    expect(gateway.requests).toHaveLength(4);

    const thirdMessages = gateway.requests[2]!.messages!;
    const exportPlaceholder = thirdMessages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.toolUseId === "call-export");
    expect(exportPlaceholder).toMatchObject({ type: "tool_result", toolUseId: "call-export" });

    const fourthMessages = gateway.requests[3]!.messages!;
    const notificationTurn = fourthMessages.find(
      (message) =>
        message.role === "user" &&
        message.content.some(
          (block) => block.type === "text" && block.text.includes("<task_notification>"),
        ),
    );
    const notificationText =
      notificationTurn?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n") ?? "";
    expect(notificationText).toContain("<tool>ExportPptx</tool>");
    expect(notificationText).toContain("ExportPptx: pptx");
    expect(notificationText).toContain("deck.pptx");
  });

  it("includes settled background results in the step-limit result", async () => {
    const previewSchema = z.object({
      slideId: z.string(),
      run_in_background: z.boolean().optional(),
    });
    const mockPreview: ToolDefinition<typeof previewSchema, { summary: string }> = {
      name: "PreviewSlide",
      description: "Mock background preview",
      category: "core",
      loadPolicy: "core",
      inputSchema: previewSchema,
      behavior: {
        background: {
          isRequested: (args) => args.run_in_background === true,
          describe: (args) => `PreviewSlide: ${args.slideId}`,
        },
      },
      risk: "low",
      execute: async () => ({ summary: "preview ready" }),
    };
    const registry = new ToolRegistry();
    registry.register(mockPreview);
    const gateway = createNativeGateway(() => ({
      provider: "anthropic",
      model: "test-model",
      content: [
        modelToolCall("preview-call", "PreviewSlide", {
          slideId: "slide-1",
          run_in_background: true,
        }),
      ],
    }));

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "background-step-limit",
      runId: "background-step-limit-run",
      request: "preview once",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      maxSteps: 1,
    });

    expect(result.type).toBe("message");
    if (result.type === "message") {
      expect(result.content).toContain("<task_notification>");
      expect(result.content).toContain("preview ready");
      expect(result.content).toContain("background-step-limit-run:bg_0001");
    }
  });
});
