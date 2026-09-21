import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentGatewayError } from "../src/main/agent/gateway";
import type {
  AgentModelContentBlock,
  AgentModelGateway,
  AgentModelRequest,
  AgentModelResponse,
} from "../src/main/agent/gateway/types";
import { clearHooks, registerHook } from "../src/main/agent/runtime/hooks/hook-registry";
import type { AgentRuntimeStreamEvent } from "../src/main/agent/runtime/runtime-types";
import type { ToolDefinition } from "../src/main/agent/tools/tool-definition";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { toToolSchema } from "../src/main/agent/tools/tool-schema";
import { listSlidesTool } from "../src/main/plugins/ppt/tools/list-slides";
import { readPresentationSnapshotTool } from "../src/main/plugins/ppt/tools/read-presentation-snapshot";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";
import { createFakeCommandProposalTool } from "./fake-command-proposal-tool";

function createGateway(
  turns: AgentModelContentBlock[][],
): AgentModelGateway & { requests: AgentModelRequest[] } {
  let index = 0;
  const requests: AgentModelRequest[] = [];
  return {
    requests,
    async queryModel(request): Promise<AgentModelResponse> {
      requests.push(request);
      const content = turns[index++];
      if (!content) throw new Error("Unexpected gateway call");
      return { provider: "anthropic", model: "test-model", content };
    },
    async *queryModelStream(request) {
      requests.push(request);
      const content = turns[index++];
      if (!content) throw new Error("Unexpected gateway call");
      for (const block of content) {
        if (block.type === "text") yield { type: "text_delta" as const, text: block.text };
      }
      yield { type: "complete" as const, content };
    },
  };
}

const text = (value: string): AgentModelContentBlock[] => [{ type: "text", text: value }];
const fakeSubmit = createFakeCommandProposalTool();

describe("native ContentBlock runtime path", () => {
  it("converts a zod tool schema to a JSON Schema tool spec", () => {
    const spec = toToolSchema(fakeSubmit);
    expect(spec.name).toBe("FakeSubmitCommands");
    expect(spec.inputSchema.type).toBe("object");
    expect(spec.inputSchema.properties as Record<string, unknown>).toHaveProperty("commands");
  });

  it("drives the tool loop exclusively from tool_use blocks", async () => {
    const registry = new ToolRegistry();
    registry.register(readPresentationSnapshotTool);
    registry.register(fakeSubmit);
    const gateway = createGateway([
      [{ type: "tool_use", id: "call-1", name: "ReadPresentationSnapshot", input: {} }],
      [
        {
          type: "tool_use",
          id: "call-2",
          name: "FakeSubmitCommands",
          input: {
            summary: "Set title",
            commands: [{ id: "cmd-1", type: "set-presentation-title", title: "Native title" }],
            risk: "low",
          },
        },
      ],
    ]);

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "native-thread",
      request: "Create a title",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    expect(result.type).toBe("command_proposal");
    if (result.type === "command_proposal") {
      expect(result.commands[0]?.type).toBe("set-presentation-title");
    }
    expect(gateway.requests).toHaveLength(2);
    const secondMessages = gateway.requests[1]!.messages!;
    const resultBlock = secondMessages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");
    expect(resultBlock).toMatchObject({ type: "tool_result", toolUseId: "call-1" });
  });

  it("returns plain text blocks as the local message result", async () => {
    const registry = new ToolRegistry();
    registry.register(fakeSubmit);
    const gateway = createGateway([text("已完成，无需修改幻灯片。")]);
    const result = await createPptRuntime(registry, gateway).run({
      threadId: "native-message-thread",
      request: "解释一下当前进度",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });
    expect(result).toEqual({ type: "message", content: "已完成，无需修改幻灯片。" });
  });

  it("streams direct Markdown text without exposing any envelope", async () => {
    const registry = new ToolRegistry();
    registry.register(fakeSubmit);
    const gateway = createGateway([text("我是你的 PPT 智能助手。\n\n说说你的需求，我马上开干。")]);
    let streamed = "";
    const result = await createPptRuntime(registry, gateway).run({
      threadId: "native-stream-thread",
      request: "你是谁？",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      onStreamEvent: (event) => {
        if (event.type === "delta") streamed += event.text;
      },
    });
    expect(result.type).toBe("message");
    expect(streamed).toBe("我是你的 PPT 智能助手。\n\n说说你的需求，我马上开干。");
  });

  it("resets a failed streamed attempt before committing the retry", async () => {
    vi.useFakeTimers();
    try {
      let invocation = 0;
      const gateway: AgentModelGateway = {
        async queryModel() {
          throw new Error("Unexpected non-streaming call");
        },
        async *queryModelStream() {
          invocation += 1;
          if (invocation === 1) {
            yield { type: "text_delta" as const, text: "failed partial" };
            throw new AgentGatewayError(
              "openai rate limit exceeded: rate limited",
              "rate-limit",
              "openai",
              undefined,
              1_000,
            );
          }
          yield { type: "text_delta" as const, text: "successful text" };
          yield {
            type: "complete" as const,
            content: [{ type: "text" as const, text: "successful text" }],
          };
        },
      };
      const events: AgentRuntimeStreamEvent[] = [];

      const runPromise = createPptRuntime(new ToolRegistry(), gateway).run({
        threadId: "stream-attempt-reset",
        request: "retry",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        onStreamEvent: (event) => events.push(event),
      });
      await vi.runAllTimersAsync();
      const result = await runPromise;

      expect(invocation).toBe(2);
      expect(result).toEqual({ type: "message", content: "successful text" });
      expect(events.map((event) => event.type)).toEqual([
        "attempt_started",
        "delta",
        "attempt_reset",
        "attempt_started",
        "delta",
        "attempt_committed",
      ]);
      const attempts = events
        .filter((event) => event.type === "attempt_started")
        .map((event) => event.attemptId);
      expect(new Set(attempts).size).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts direct Markdown on the first turn", async () => {
    const registry = new ToolRegistry();
    registry.register(fakeSubmit);
    const gateway = createGateway([text("**可以。** 先讲概念，再决定是否制作 PPT。")]);
    const result = await createPptRuntime(registry, gateway).run({
      threadId: "native-markdown-thread",
      request: "先不做 PPT，解释一下这个概念",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });
    expect(result).toEqual({
      type: "message",
      content: "**可以。** 先讲概念，再决定是否制作 PPT。",
    });
    expect(gateway.requests).toHaveLength(1);
  });

  it("executes every tool_use in one assistant turn and returns one result batch", async () => {
    const registry = new ToolRegistry();
    registry.register(readPresentationSnapshotTool);
    registry.register(listSlidesTool);
    const gateway = createGateway([
      [
        { type: "tool_use", id: "call-read", name: "ReadPresentationSnapshot", input: {} },
        { type: "tool_use", id: "call-list", name: "ListSlides", input: {} },
      ],
      text("两个只读工具均已执行。"),
    ]);
    const result = await createPptRuntime(registry, gateway).run({
      threadId: "native-batch-thread",
      request: "读取当前演示文稿",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });
    expect(result.type).toBe("message");
    const results = gateway.requests[1]!.messages!.flatMap((message) => message.content).filter(
      (block) => block.type === "tool_result",
    );
    expect(results.map((block) => block.type === "tool_result" && block.toolUseId)).toEqual([
      "call-read",
      "call-list",
    ]);
  });

  it("does not interpret JSON-looking text as the removed envelope protocol", async () => {
    const registry = new ToolRegistry();
    registry.register(listSlidesTool);
    const jsonLookingText = '{"type":"tool.call","data":{"toolName":"ListSlides","args":{}}}';
    const gateway = createGateway([text(jsonLookingText)]);
    const result = await createPptRuntime(registry, gateway).run({
      threadId: "no-envelope-thread",
      request: "show raw text",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });
    expect(result).toEqual({ type: "message", content: jsonLookingText });
    expect(gateway.requests).toHaveLength(1);
  });
});

describe("tool lifecycle commit boundary", () => {
  afterEach(() => clearHooks());

  function lifecycleTool(input: {
    execute: () => Promise<unknown>;
    outputSchema?: z.ZodTypeAny;
    mapResultToModelContent?: () => Promise<string>;
  }): ToolDefinition<any, any> {
    return {
      name: "LifecycleTool",
      description: "Exercises runtime lifecycle boundaries",
      category: "core",
      loadPolicy: "core",
      inputSchema: z.object({}),
      outputSchema: input.outputSchema,
      risk: "low",
      execute: input.execute,
      mapResultToModelContent: input.mapResultToModelContent,
    };
  }

  function lifecycleGateway(): ReturnType<typeof createGateway> {
    return createGateway([
      [{ type: "tool_use", id: "lifecycle-1", name: "LifecycleTool", input: {} }],
      text("runtime continued"),
    ]);
  }

  it("does not emit PostToolUse when a pre-hook fails before execution", async () => {
    let executions = 0;
    let postHooks = 0;
    const registry = new ToolRegistry();
    registry.register(
      lifecycleTool({
        execute: async () => {
          executions += 1;
          return { ok: true };
        },
      }),
    );
    registerHook("PreToolUse", () => {
      throw new Error("pre-hook unavailable");
    });
    registerHook("PostToolUse", () => {
      postHooks += 1;
      return null;
    });
    const gateway = lifecycleGateway();

    await createPptRuntime(registry, gateway).run({
      threadId: "pre-hook-failure",
      request: "run tool",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    expect(executions).toBe(0);
    expect(postHooks).toBe(0);
    const toolResult = gateway.requests[1]!.messages!.flatMap((message) => message.content).find(
      (block) => block.type === "tool_result",
    );
    expect(toolResult).toMatchObject({ isError: true });
  });

  it("keeps a successful tool result when PostToolUse throws", async () => {
    let executions = 0;
    let postHooks = 0;
    const registry = new ToolRegistry();
    registry.register(
      lifecycleTool({
        execute: async () => {
          executions += 1;
          return { ok: true };
        },
      }),
    );
    registerHook("PostToolUse", () => {
      postHooks += 1;
      throw new Error("audit sink unavailable");
    });
    const gateway = lifecycleGateway();

    await createPptRuntime(registry, gateway).run({
      threadId: "post-hook-failure",
      request: "run tool",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    expect(executions).toBe(1);
    expect(postHooks).toBe(1);
    const toolResult = gateway.requests[1]!.messages!.flatMap((message) => message.content).find(
      (block) => block.type === "tool_result",
    );
    expect(toolResult).toMatchObject({ type: "tool_result", toolUseId: "lifecycle-1" });
    expect(toolResult).not.toHaveProperty("isError");
  });

  it("marks invalid output as side-effect-uncertain without retrying execution", async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(
      lifecycleTool({
        execute: async () => {
          executions += 1;
          return { invalid: true };
        },
        outputSchema: z.object({ ok: z.literal(true) }),
      }),
    );
    const gateway = lifecycleGateway();

    await createPptRuntime(registry, gateway).run({
      threadId: "invalid-output",
      request: "run tool",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    expect(executions).toBe(1);
    const toolResult = gateway.requests[1]!.messages!.flatMap((message) => message.content).find(
      (block) => block.type === "tool_result",
    );
    expect(toolResult).toMatchObject({ isError: true });
    expect(JSON.stringify(toolResult)).toContain("side effects may already exist");
  });

  it("does not reclassify execution when model-content mapping fails", async () => {
    const registry = new ToolRegistry();
    registry.register(
      lifecycleTool({
        execute: async () => ({ ok: true }),
        mapResultToModelContent: async () => {
          throw new Error("mapping failed");
        },
      }),
    );
    const gateway = lifecycleGateway();

    await createPptRuntime(registry, gateway).run({
      threadId: "mapping-failure",
      request: "run tool",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    const toolResult = gateway.requests[1]!.messages!.flatMap((message) => message.content).find(
      (block) => block.type === "tool_result",
    );
    expect(toolResult).not.toHaveProperty("isError");
    expect(JSON.stringify(toolResult)).toContain("executed successfully");
  });
});
