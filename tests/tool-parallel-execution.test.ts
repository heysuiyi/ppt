import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  AgentModelContentBlock,
  AgentModelGateway,
  AgentModelRequest,
} from "../src/main/agent/gateway/types";
import { DurableRunStore } from "../src/main/agent/persistence/durable-run-store";
import { clearHooks, registerHook } from "../src/main/agent/runtime/hooks/hook-registry";
import { readFileTool, writeFileTool } from "../src/main/agent/tools/core/workspace-files";
import type { ToolDefinition } from "../src/main/agent/tools/tool-definition";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

const temporaryRoots: string[] = [];

afterEach(async () => {
  clearHooks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function gatewayFor(turns: AgentModelContentBlock[][]): AgentModelGateway & {
  requests: AgentModelRequest[];
} {
  const requests: AgentModelRequest[] = [];
  let index = 0;
  return {
    requests,
    async queryModel(request) {
      requests.push(request);
      const content = turns[index++];
      if (!content) throw new Error("Unexpected gateway call");
      return { provider: "openai", model: "test", content };
    },
    async *queryModelStream(request) {
      const response = await this.queryModel(request);
      yield { type: "complete" as const, content: response.content };
    },
  };
}

const delaySchema = z.object({
  order: z.number().int(),
  resource: z.string().optional(),
  delayMs: z.number().int().nonnegative(),
  fail: z.boolean().optional(),
});

function parallelTool(
  onState: (delta: number, order: number) => void,
): ToolDefinition<typeof delaySchema, { order: number }> {
  return {
    name: "ParallelProbe",
    description: "Test-only explicitly parallel tool.",
    category: "core",
    loadPolicy: "core",
    inputSchema: delaySchema,
    outputSchema: z.object({ order: z.number().int() }),
    behavior: {
      concurrency: {
        mode: "parallel",
        resourceKeys: (args) => (args.resource ? [`probe:${args.resource}`] : []),
      },
    },
    risk: "low",
    async execute(args) {
      onState(1, args.order);
      try {
        await new Promise((resolve) => setTimeout(resolve, args.delayMs));
        if (args.fail) throw new Error(`failed-${args.order}`);
        return { order: args.order };
      } finally {
        onState(-1, args.order);
      }
    },
  };
}

function calls(count: number): AgentModelContentBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "tool_use" as const,
    id: `parallel-${index + 1}`,
    name: "ParallelProbe",
    input: {
      order: index + 1,
      delayMs: count - index,
      ...(index === 2 ? { fail: true } : {}),
    },
  }));
}

describe("parallel tool waves", () => {
  it("runs at most four calls concurrently and commits results in provider order", async () => {
    let active = 0;
    let peak = 0;
    const registry = new ToolRegistry();
    registry.register(
      parallelTool((delta) => {
        active += delta;
        peak = Math.max(peak, active);
      }),
    );
    const gateway = gatewayFor([calls(6), [{ type: "text", text: "done" }]]);

    await createPptRuntime(registry, gateway).run({
      threadId: "parallel-limit",
      request: "run probes",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    expect(peak).toBe(4);
    const results = gateway.requests[1]!.messages!.filter((message) => message.role === "user")
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result");
    expect(results.map((result) => result.toolUseId)).toEqual([
      "parallel-1",
      "parallel-2",
      "parallel-3",
      "parallel-4",
      "parallel-5",
      "parallel-6",
    ]);
    expect(results.find((result) => result.toolUseId === "parallel-3")).toMatchObject({
      isError: true,
    });
    expect(results.filter((result) => result.isError)).toHaveLength(1);
  });

  it("treats a repeated resource key as an ordered wave boundary", async () => {
    const events: string[] = [];
    const registry = new ToolRegistry();
    registry.register(
      parallelTool((delta, order) => {
        events.push(`${delta > 0 ? "start" : "end"}-${order}`);
      }),
    );
    const gateway = gatewayFor([
      [
        {
          type: "tool_use",
          id: "a",
          name: "ParallelProbe",
          input: { order: 1, resource: "same", delayMs: 10 },
        },
        {
          type: "tool_use",
          id: "b",
          name: "ParallelProbe",
          input: { order: 2, resource: "same", delayMs: 1 },
        },
        {
          type: "tool_use",
          id: "c",
          name: "ParallelProbe",
          input: { order: 3, resource: "other", delayMs: 1 },
        },
      ],
      [{ type: "text", text: "done" }],
    ]);

    await createPptRuntime(registry, gateway).run({
      threadId: "parallel-resource",
      request: "run probes",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    expect(events.indexOf("end-1")).toBeLessThan(events.indexOf("start-2"));
    expect(events.indexOf("start-3")).toBeLessThan(events.indexOf("end-2"));
  });

  it("runs PostToolUse hooks in provider order even when tools finish out of order", async () => {
    const hookOrder: number[] = [];
    registerHook("PostToolUse", (block) => {
      const args = (block as { args: { order: number } }).args;
      hookOrder.push(args.order);
      return null;
    });
    const registry = new ToolRegistry();
    registry.register(parallelTool(() => undefined));
    const gateway = gatewayFor([
      [
        { type: "tool_use", id: "slow", name: "ParallelProbe", input: { order: 1, delayMs: 12 } },
        { type: "tool_use", id: "medium", name: "ParallelProbe", input: { order: 2, delayMs: 6 } },
        { type: "tool_use", id: "fast", name: "ParallelProbe", input: { order: 3, delayMs: 1 } },
      ],
      [{ type: "text", text: "done" }],
    ]);

    await createPptRuntime(registry, gateway).run({
      threadId: "parallel-hook-order",
      request: "run probes",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    expect(hookOrder).toEqual([1, 2, 3]);
  });

  it("checkpoints every active call in a wave before executing it", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "parallel-checkpoint-"));
    temporaryRoots.push(workspaceRoot);
    let started = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new ToolRegistry();
    registry.register({
      ...parallelTool(() => undefined),
      async execute(args) {
        started += 1;
        if (started === 2) markStarted();
        await gate;
        return { order: args.order };
      },
    });
    const gateway = gatewayFor([calls(2), [{ type: "text", text: "done" }]]);
    const running = createPptRuntime(registry, gateway).run({
      threadId: "parallel-checkpoint",
      runId: "parallel-checkpoint-run",
      request: "run probes",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
    });

    await allStarted;
    const checkpoint = await new DurableRunStore(workspaceRoot).load("parallel-checkpoint");
    expect(checkpoint).toMatchObject({
      version: 2,
      inflight: {
        phase: "tool_running",
        activeToolUses: [{ id: "parallel-1" }, { id: "parallel-2" }],
      },
    });
    release();
    await running;
  });

  it("cancels the active wave without starting later waves", async () => {
    const controller = new AbortController();
    const executions: number[] = [];
    const progress: Array<{ type: string; [key: string]: unknown }> = [];
    const registry = new ToolRegistry();
    registry.register({
      ...parallelTool(() => undefined),
      async execute(args) {
        executions.push(args.order);
        if (args.order === 1) controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { order: args.order };
      },
    });
    const gateway = gatewayFor([calls(6)]);

    await expect(
      createPptRuntime(registry, gateway).run({
        threadId: "parallel-cancellation",
        request: "run probes",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        signal: controller.signal,
        onProgress: (event) => progress.push(event),
      }),
    ).rejects.toThrow("Run aborted by user");

    expect(executions).toEqual([1, 2, 3, 4]);
    for (let index = 1; index <= 4; index += 1) {
      expect(
        progress
          .filter(
            (event) => event.type === "tool-state" && event.toolCallId === `parallel-${index}`,
          )
          .map((event) => event.status),
      ).toEqual(["running", "denied"]);
    }
    expect(progress.some((event) => event.toolCallId === "parallel-5")).toBe(false);
  });

  it("writes distinct workspace paths from one parallel batch", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "parallel-file-write-"));
    temporaryRoots.push(workspaceRoot);
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    const gateway = gatewayFor([
      [
        {
          type: "tool_use",
          id: "write-a",
          name: "WriteFile",
          input: { path: "notes/a.txt", content: "A" },
        },
        {
          type: "tool_use",
          id: "write-b",
          name: "WriteFile",
          input: { path: "notes/b.txt", content: "B" },
        },
      ],
      [{ type: "text", text: "done" }],
    ]);

    await createPptRuntime(registry, gateway).run({
      threadId: "parallel-file-write",
      request: "write files",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
    });

    await expect(readFile(join(workspaceRoot, "notes/a.txt"), "utf8")).resolves.toBe("A");
    await expect(readFile(join(workspaceRoot, "notes/b.txt"), "utf8")).resolves.toBe("B");
    const resultIds = gateway.requests[1]!.messages!.flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result")
      .map((block) => block.toolUseId);
    expect(resultIds).toEqual(["write-a", "write-b"]);
  });

  it("keeps parallel ReadFile results paired with their path and toolUseId", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "parallel-file-read-"));
    temporaryRoots.push(workspaceRoot);
    await Promise.all([
      writeFile(join(workspaceRoot, "a.txt"), "alpha", "utf8"),
      writeFile(join(workspaceRoot, "b.txt"), "beta", "utf8"),
    ]);
    const registry = new ToolRegistry();
    registry.register(readFileTool);
    const gateway = gatewayFor([
      [
        { type: "tool_use", id: "read-a", name: "ReadFile", input: { path: "a.txt" } },
        { type: "tool_use", id: "read-b", name: "ReadFile", input: { path: "b.txt" } },
      ],
      [{ type: "text", text: "done" }],
    ]);

    await createPptRuntime(registry, gateway).run({
      threadId: "parallel-file-read",
      request: "read files",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
    });

    const results = gateway.requests[1]!.messages!.flatMap((message) => message.content).filter(
      (block) => block.type === "tool_result",
    );
    const resultText = (index: number) =>
      results[index]!.content.filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
    expect(results.map((result) => result.toolUseId)).toEqual(["read-a", "read-b"]);
    expect(resultText(0)).toContain('"path":"a.txt"');
    expect(resultText(0)).toContain("alpha");
    expect(resultText(1)).toContain('"path":"b.txt"');
    expect(resultText(1)).toContain("beta");
    expect(results.map((_, index) => resultText(index)).join("\n")).not.toContain("transcript");
  });
});
