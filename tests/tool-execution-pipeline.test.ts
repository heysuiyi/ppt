import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  AgentModelContentBlock,
  AgentModelGateway,
  AgentModelRequest,
} from "../src/main/agent/gateway/types";
import type { PostToolUseBlock } from "../src/main/agent/runtime/hooks/hook-blocks";
import { clearHooks, registerHook } from "../src/main/agent/runtime/hooks/hook-registry";
import type { PreToolUseBlock } from "../src/main/agent/runtime/tools/permission-check";
import { ToolExecutionEngine } from "../src/main/agent/runtime/tools/tool-execution-engine";
import { executeExtraToolTool } from "../src/main/agent/tools/core/execute-extra-tool";
import { searchExtraToolsTool } from "../src/main/agent/tools/core/search-extra-tools";
import { WorkspaceFileError } from "../src/main/agent/tools/files/workspace-file-service";
import type { ToolContext, ToolDefinition } from "../src/main/agent/tools/tool-definition";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

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

function toolCall(
  id: string,
  name: string,
  input: Record<string, unknown>,
): AgentModelContentBlock {
  return { type: "tool_use", id, name, input };
}

function createContext(registry: ToolRegistry): ToolContext {
  return {
    presentation: createStarterPresentation(),
    selectedElementIds: [],
    discoverySession: { discoveredToolNames: new Set(["DeferredPipelineTarget"]) },
    registry,
    messageHistory: [],
  };
}

describe("unified tool execution pipeline", () => {
  beforeEach(() => clearHooks());
  afterEach(() => {
    clearHooks();
    vi.restoreAllMocks();
  });

  it("routes a deferred target through target approval, hooks, validation and model mapping", async () => {
    const targetSchema = z.object({ value: z.number() });
    const preHooks: PreToolUseBlock[] = [];
    const postHooks: PostToolUseBlock[] = [];
    const approvals: Array<{ toolName: string; reason: string }> = [];
    let executions = 0;
    let mappings = 0;
    const target: ToolDefinition<typeof targetSchema, { normalized: string }> = {
      name: "DeferredPipelineTarget",
      description: "Deferred target used to verify the unified pipeline.",
      category: "deferred",
      loadPolicy: "deferred",
      inputSchema: targetSchema,
      outputSchema: z.object({ normalized: z.string() }),
      risk: "medium",
      async execute(args) {
        executions += 1;
        return { normalized: `value=${args.value}` };
      },
      async mapResultToModelContent(result) {
        mappings += 1;
        return `mapped:${result.normalized}`;
      },
    };
    const registry = new ToolRegistry();
    registry.register(searchExtraToolsTool);
    registry.register(executeExtraToolTool);
    registry.register(target);
    registerHook("PreToolUse", (block) => {
      if ((block as PreToolUseBlock).toolName === target.name) {
        preHooks.push(block as PreToolUseBlock);
      }
      return null;
    });
    registerHook("PostToolUse", (block) => {
      if ((block as PostToolUseBlock).toolName === target.name) {
        postHooks.push(block as PostToolUseBlock);
      }
      return null;
    });
    const dispatcherExecute = vi.spyOn(executeExtraToolTool, "execute");
    const gateway = gatewayFor([
      [toolCall("search", "SearchExtraTools", { query: target.name })],
      [
        toolCall("execute", "ExecuteExtraTool", {
          toolName: target.name,
          toolArgs: { value: 7 },
        }),
      ],
      [{ type: "text", text: "done" }],
    ]);

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "unified-deferred-pipeline",
      request: "run deferred target",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      requestToolApproval: async (request) => {
        approvals.push({ toolName: request.toolName, reason: request.reason });
        return true;
      },
    });

    expect(result).toEqual({ type: "message", content: "done" });
    expect(dispatcherExecute).not.toHaveBeenCalled();
    expect(executions).toBe(1);
    expect(mappings).toBe(1);
    expect(approvals).toEqual([
      {
        toolName: target.name,
        reason: `Tool ${target.name} declares medium risk.`,
      },
    ]);
    expect(preHooks).toEqual([
      expect.objectContaining({ toolName: target.name, args: { value: 7 }, risk: "medium" }),
    ]);
    expect(postHooks).toEqual([
      expect.objectContaining({
        toolName: target.name,
        args: { value: 7 },
        executionStatus: "returned",
        sideEffects: "committed_or_unknown",
        result: { normalized: "value=7" },
      }),
    ]);
    const modelResult = gateway.requests[2]!.messages!.flatMap((message) => message.content).find(
      (block) => block.type === "tool_result" && block.toolUseId === "execute",
    );
    expect(modelResult).toMatchObject({
      type: "tool_result",
      toolUseId: "execute",
      content: [{ type: "text", text: "mapped:value=7" }],
    });
  });

  it("does not let clearHooks remove target-risk approval enforcement", async () => {
    const targetSchema = z.object({});
    let executions = 0;
    const target: ToolDefinition<typeof targetSchema, { ok: true }> = {
      name: "DeferredPipelineTarget",
      description: "Medium-risk deferred target.",
      category: "deferred",
      loadPolicy: "deferred",
      inputSchema: targetSchema,
      outputSchema: z.object({ ok: z.literal(true) }),
      risk: "medium",
      async execute() {
        executions += 1;
        return { ok: true };
      },
    };
    const registry = new ToolRegistry();
    registry.register(searchExtraToolsTool);
    registry.register(executeExtraToolTool);
    registry.register(target);
    clearHooks();
    const approvals: string[] = [];
    const gateway = gatewayFor([
      [toolCall("search", "SearchExtraTools", { query: target.name })],
      [
        toolCall("execute", "ExecuteExtraTool", {
          toolName: target.name,
          toolArgs: {},
        }),
      ],
      [{ type: "text", text: "permission handled" }],
    ]);

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "permission-survives-clear-hooks",
      request: "run deferred target",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      requestToolApproval: async (request) => {
        approvals.push(request.toolName);
        return false;
      },
    });

    expect(result).toEqual({ type: "message", content: "permission handled" });
    expect(approvals).toEqual([target.name]);
    expect(executions).toBe(0);
    const denied = gateway.requests[2]!.messages!.flatMap((message) => message.content).find(
      (block) => block.type === "tool_result" && block.toolUseId === "execute",
    );
    expect(denied).toMatchObject({ type: "tool_result", isError: true });
  });

  it("validates deferred output before mapping and never executes it in the dispatcher definition", async () => {
    const targetSchema = z.object({});
    let executions = 0;
    const mapResultToModelContent = vi.fn(async () => "must not map invalid output");
    const target: ToolDefinition<typeof targetSchema, { ok: true }> = {
      name: "DeferredPipelineTarget",
      description: "Returns an invalid result.",
      category: "deferred",
      loadPolicy: "deferred",
      inputSchema: targetSchema,
      outputSchema: z.object({ ok: z.literal(true) }),
      risk: "low",
      async execute() {
        executions += 1;
        return { ok: false } as unknown as { ok: true };
      },
      mapResultToModelContent,
    };
    const registry = new ToolRegistry();
    registry.register(searchExtraToolsTool);
    registry.register(executeExtraToolTool);
    registry.register(target);
    const context = createContext(registry);

    const routed = await executeExtraToolTool.execute(
      {
        toolName: target.name,
        toolArgs: {},
      },
      context,
    );
    expect(routed).toMatchObject({ toolName: target.name, delegated: true });
    expect(executions).toBe(0);

    const gateway = gatewayFor([
      [toolCall("search", "SearchExtraTools", { query: target.name })],
      [
        toolCall("execute", "ExecuteExtraTool", {
          toolName: target.name,
          toolArgs: {},
        }),
      ],
      [{ type: "text", text: "invalid output handled" }],
    ]);
    await createPptRuntime(registry, gateway).run({
      threadId: "deferred-output-validation",
      request: "run deferred target",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    expect(executions).toBe(1);
    expect(mapResultToModelContent).not.toHaveBeenCalled();
    const invalid = gateway.requests[2]!.messages!.flatMap((message) => message.content).find(
      (block) => block.type === "tool_result" && block.toolUseId === "execute",
    );
    expect(invalid).toMatchObject({ type: "tool_result", isError: true });
    expect(JSON.stringify(invalid)).toContain("returned invalid output");
  });

  it("maps rejected workspace mutations to sideEffects=none and preserves the error code", async () => {
    const schema = z.object({});
    const tool: ToolDefinition<typeof schema, unknown> = {
      name: "RejectedWorkspaceMutation",
      description: "Reject a stale workspace mutation.",
      category: "core",
      loadPolicy: "core",
      inputSchema: schema,
      risk: "low",
      async execute() {
        throw new WorkspaceFileError("READ_REQUIRED", "Read notes.md before editing it.");
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const postBlocks: PostToolUseBlock[] = [];

    const outcome = await new ToolExecutionEngine().execute({
      tool,
      args: {},
      context: createContext(registry),
      toolCall: {
        type: "tool_use",
        id: "workspace-rejected",
        name: tool.name,
        input: {},
      },
      threadId: "workspace-error-mapping",
      async runPostToolUseHook(block) {
        postBlocks.push(block);
        return [];
      },
    });

    expect(outcome).toMatchObject({
      executionStatus: "threw",
      sideEffects: "none",
      errorCode: "READ_REQUIRED",
      modelResult: {
        type: "tool_result",
        toolUseId: "workspace-rejected",
        isError: true,
      },
    });
    expect(JSON.stringify(outcome.modelResult)).toContain("[READ_REQUIRED]");
    expect(postBlocks).toEqual([
      expect.objectContaining({
        sideEffects: "none",
        errorCode: "READ_REQUIRED",
      }),
    ]);
  });
});
