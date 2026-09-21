import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentModelGateway } from "../src/main/agent/gateway/types";
import {
  isRuntimeCancellation,
  rethrowIfRuntimeCancellation,
} from "../src/main/agent/runtime/lifecycle/runtime-cancellation";
import { ToolApprovalBroker } from "../src/main/agent/runtime/tools/tool-approval-broker";
import type { ToolDefinition } from "../src/main/agent/tools/tool-definition";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

describe("runtime cancellation classification", () => {
  it("prioritizes an aborted signal over an ordinary downstream error", () => {
    const controller = new AbortController();
    controller.abort("cancelled by user");
    expect(isRuntimeCancellation(new Error("tool failed"), controller.signal)).toBe(true);
  });

  it("recognizes standard abort-shaped errors without an attached signal", () => {
    expect(isRuntimeCancellation(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(
      true,
    );
    expect(isRuntimeCancellation(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }))).toBe(
      true,
    );
    expect(
      isRuntimeCancellation(
        new Error("wrapped", {
          cause: Object.assign(new Error("provider stopped"), { name: "APIUserAbortError" }),
        }),
      ),
    ).toBe(true);
  });

  it("does not reclassify an ordinary tool failure", () => {
    const error = new Error("ordinary failure");
    expect(isRuntimeCancellation(error)).toBe(false);
    expect(() => rethrowIfRuntimeCancellation(error)).not.toThrow();
  });

  it("does not execute later tools after cancellation during a multi-tool batch", async () => {
    const controller = new AbortController();
    const executions: number[] = [];
    const progress: Array<{ type: string; [key: string]: unknown }> = [];
    const schema = z.object({ order: z.number() });
    const tool: ToolDefinition<typeof schema, { ok: true }> = {
      name: "CancelableBatchTool",
      description: "Cancels the run when the first batch item executes.",
      category: "core",
      loadPolicy: "core",
      inputSchema: schema,
      outputSchema: z.object({ ok: z.literal(true) }),
      risk: "low",
      async execute(args) {
        executions.push(args.order);
        if (args.order === 1) controller.abort();
        return { ok: true };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const content = [
      {
        type: "tool_use" as const,
        id: "cancel-first",
        name: tool.name,
        input: { order: 1 },
      },
      {
        type: "tool_use" as const,
        id: "must-not-run",
        name: tool.name,
        input: { order: 2 },
      },
    ];
    const gateway: AgentModelGateway = {
      async queryModel() {
        return { provider: "anthropic", model: "test", content };
      },
      async *queryModelStream() {
        yield { type: "complete" as const, content };
      },
    };

    await expect(
      createPptRuntime(registry, gateway).run({
        threadId: "cancel-multi-tool-batch",
        request: "run both tools",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        signal: controller.signal,
        onProgress: (event) => progress.push(event),
      }),
    ).rejects.toThrow("Run aborted by user");
    expect(executions).toEqual([1]);
    const statusesFor = (toolCallId: string) =>
      progress
        .filter((event) => event.type === "tool-state" && event.toolCallId === toolCallId)
        .map((event) => event.status);
    expect(statusesFor("cancel-first")).toEqual(["running", "denied"]);
    expect(statusesFor("cancel-first")).not.toContain("completed");
    expect(statusesFor("must-not-run")).toEqual([]);
  });

  it("propagates the run signal so an approval wait ends on cancellation", async () => {
    const controller = new AbortController();
    const broker = new ToolApprovalBroker();
    let executions = 0;
    const schema = z.object({});
    const tool: ToolDefinition<typeof schema, { ok: true }> = {
      name: "ApprovalCancellationTool",
      description: "Requires approval before execution.",
      category: "core",
      loadPolicy: "core",
      inputSchema: schema,
      outputSchema: z.object({ ok: z.literal(true) }),
      risk: "medium",
      permission: {
        profile: "approval-cancellation-test",
        description: "Test approval cancellation.",
        scopes: ["main"],
        effects: ["workspace.write"],
        sandbox: "none",
        approval: "always",
      },
      async execute() {
        executions += 1;
        return { ok: true };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const content = [
      {
        type: "tool_use" as const,
        id: "approval-wait",
        name: tool.name,
        input: {},
      },
    ];
    const gateway: AgentModelGateway = {
      async queryModel() {
        return { provider: "anthropic", model: "test", content };
      },
      async *queryModelStream() {
        yield { type: "complete" as const, content };
      },
    };
    const runId = "cancel-approval-run";

    await expect(
      createPptRuntime(registry, gateway).run({
        threadId: "cancel-approval-thread",
        runId,
        request: "run the protected tool",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        signal: controller.signal,
        requestToolApproval: broker.createHandler(runId, () => controller.abort()),
      }),
    ).rejects.toThrow("Run aborted by user");
    expect(executions).toBe(0);
    broker.finishForRun(runId);
  });
});
