import type { AgentPlugin, PluginContext } from "@agent-ppt/harness/extensions/plugin-contract";
import type {
  ModelClientFactory,
  ModelToolCallContent,
} from "@agent-ppt/harness/model/model-contract";
import type {
  InteractionRequest,
  InteractionResponse,
  RunIdentity,
  VersionedData,
} from "@agent-ppt/harness/protocol-values";
import type {
  ImmediateToolDefinition,
  ToolAuthorizationDecision,
  ToolExecutionContext,
  ToolSuspension,
} from "@agent-ppt/harness/tools/tool-contract";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { installPlugins } from "../packages/harness/dist/agent/extensions/plugin-manager.js";
import { PromptRegistry } from "../packages/harness/dist/agent/extensions/prompt-registry.js";
import { ModelRegistry } from "../packages/harness/dist/agent/model/model-registry.js";
import { ResourceScope } from "../packages/harness/dist/agent/scope/resource-scope.js";
import { ToolPipeline } from "../packages/harness/dist/agent/tools/tool-pipeline.js";
import { ToolRegistry } from "../packages/harness/dist/agent/tools/tool-registry.js";

const identity: RunIdentity = {
  agentId: "agent",
  threadId: "thread",
  queryId: "query",
  runId: "run",
};
const context: ToolExecutionContext = {
  identity,
  callId: "call",
  signal: new AbortController().signal,
};
const call: ModelToolCallContent = {
  type: "tool-call",
  callId: "call",
  name: "write",
  input: { value: "saved" },
};
const approval: InteractionRequest = {
  id: "approve",
  owner: "host",
  payload: { type: "approval", version: 1, data: { action: "write" } },
};
type Value = { value: string };

function tool(
  overrides: Partial<ImmediateToolDefinition<Value, Value>> = {},
): ImmediateToolDefinition<Value, Value> {
  return {
    name: "write",
    version: "1",
    owner: "test",
    description: "Write a value",
    mode: "immediate",
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ value: z.string() }),
    async execute(input) {
      return { status: "succeeded", output: input, effects: "applied" };
    },
    toModelContent(result) {
      return [{ type: "text", text: JSON.stringify(result) }];
    },
    ...overrides,
  };
}

async function waiting(pipeline: ToolPipeline): Promise<ToolSuspension> {
  const result = await pipeline.execute(call, context);
  expect(result.status).toBe("waiting");
  if (result.status !== "waiting") throw new Error("Expected a suspended tool");
  return result;
}

function registries() {
  return { models: new ModelRegistry(), tools: new ToolRegistry(), prompts: new PromptRegistry() };
}

describe("general agent resource and registration ownership", () => {
  it("aborts before reverse disposal, aggregates failures, and shares concurrent disposal", async () => {
    const scope = new ResourceScope();
    const order: string[] = [];
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    scope.own({
      async dispose() {
        order.push("first");
        throw new Error("first failed");
      },
    });
    scope.own({
      async dispose() {
        expect(scope.signal.aborted).toBe(true);
        order.push("second");
        await gate;
        throw new Error("second failed");
      },
    });
    const first = scope.dispose();
    const second = scope.dispose();
    expect(second).toBe(first);
    expect(scope.signal.aborted).toBe(true);
    expect(() =>
      scope.own({
        async dispose() {
          order.push("unexpected");
        },
      }),
    ).toThrow();
    const outcome = first.catch((error: unknown) => error);
    release();
    const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected aggregate failure");
    expect(error.errors.map((entry: Error) => entry.message)).toEqual([
      "second failed",
      "first failed",
    ]);
    expect(order).toEqual(["second", "first"]);
    expect(scope.dispose()).toBe(first);
  });

  it("detaches a disposed child and removes parent abort listeners", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const scope = new ResourceScope(controller.signal);
    const child = scope.child();
    const disposeChild = vi.spyOn(child, "dispose");
    await child.dispose();
    await scope.dispose();
    expect(disposeChild).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects duplicates, seals registries, and makes old registration disposers harmless", async () => {
    const { models, tools, prompts } = registries();
    const factory: ModelClientFactory = {
      async create() {
        throw new Error("Not selected in registration test");
      },
    };
    const modelHandle = models.register("provider", factory);
    const toolHandle = tools.register(tool());
    const promptHandle = prompts.register({ id: "prompt", render: () => "old" });
    expect(() => models.register("provider", factory)).toThrow();
    expect(() => tools.register(tool())).toThrow();
    expect(() => prompts.register({ id: "prompt", render: () => "duplicate" })).toThrow();
    await Promise.all([modelHandle.dispose(), toolHandle.dispose(), promptHandle.dispose()]);
    models.register("provider", factory);
    tools.register(tool({ version: "2" }));
    prompts.register({ id: "prompt", render: () => "new" });
    prompts.register({ id: "tail", render: async () => "tail" });
    await Promise.all([modelHandle.dispose(), toolHandle.dispose(), promptHandle.dispose()]);
    expect(tools.getVersion("write")).toBe("2");
    expect(await prompts.render({ identity, signal: context.signal })).toBe("new\n\ntail");
    await expect(
      models.create({ providerId: "provider", modelId: "model" }, context.signal),
    ).rejects.toThrow("Not selected");
    models.seal();
    tools.seal();
    prompts.seal();
    expect(() => models.register("other", factory)).toThrow();
    expect(() => tools.register(tool({ name: "other" }))).toThrow();
    expect(() => prompts.register({ id: "other", render: () => "other" })).toThrow();
  });

  it("clears routing without disposing borrowed factories or issued model bindings", async () => {
    let bindingDisposals = 0;
    const factoryDisposal = vi.fn();
    const factory = {
      dispose: factoryDisposal,
      async create() {
        return {
          client: {
            selection: { providerId: "provider", modelId: "model" },
            capabilities: { streaming: false, toolCalls: false, images: false, reasoning: false },
            async generate() {
              return {
                message: { role: "assistant" as const, content: [] },
                finishReason: "stop" as const,
              };
            },
            async *stream() {
              yield { type: "completed" as const, response: await this.generate() };
            },
          },
          async dispose() {
            bindingDisposals++;
          },
        };
      },
    };
    const models = new ModelRegistry(factory);
    const binding = await models.create(
      { providerId: "provider", modelId: "model" },
      context.signal,
    );
    await models.dispose();
    expect(factoryDisposal).not.toHaveBeenCalled();
    expect(bindingDisposals).toBe(0);
    await binding.dispose();
    expect(bindingDisposals).toBe(1);
    await expect(
      models.create({ providerId: "provider", modelId: "model" }, context.signal),
    ).rejects.toThrow();
  });

  it("detects duplicate plugin IDs before setup and rolls back all plugin scopes in reverse", async () => {
    const { models, tools, prompts } = registries();
    const parent = new ResourceScope();
    const order: string[] = [];
    let retained: PluginContext | undefined;
    const first: AgentPlugin = {
      id: "first",
      version: "1",
      setup(ctx) {
        retained = ctx;
        ctx.models.register("plugin-provider", {
          async create() {
            throw new Error("Plugin factory must not survive rollback");
          },
        });
        ctx.tools.register(tool());
        ctx.prompts.register({ id: "first", render: () => "first" });
        ctx.scope.own({
          async dispose() {
            order.push("first");
          },
        });
      },
    };
    await expect(installPlugins([first, first], parent, models, tools, prompts)).rejects.toThrow();
    expect(retained).toBeUndefined();
    await expect(
      installPlugins(
        [
          first,
          {
            id: "second",
            version: "1",
            setup(ctx) {
              ctx.prompts.register({ id: "second", render: () => "second" });
              ctx.scope.own({
                async dispose() {
                  order.push("second");
                },
              });
              throw new Error("setup failed");
            },
          },
        ],
        parent,
        models,
        tools,
        prompts,
      ),
    ).rejects.toThrow("setup failed");
    expect(order).toEqual(["second", "first"]);
    expect(tools.getSchemas()).toEqual([]);
    expect(await prompts.render({ identity, signal: context.signal })).toBe("");
    await expect(
      models.create({ providerId: "plugin-provider", modelId: "model" }, context.signal),
    ).rejects.toMatchObject({ code: "model_provider_unavailable" });
    const failedContext = retained;
    if (!failedContext) throw new Error("Expected retained plugin context");
    expect(() => failedContext.tools.register(tool())).toThrow();
    expect(tools.getSchemas()).toEqual([]);
    // 失败安装不会关闭父作用域，也不影响独立 Agent 的私有注册表。
    const isolated = registries();
    const otherParent = new ResourceScope();
    await installPlugins([first], otherParent, isolated.models, isolated.tools, isolated.prompts);
    expect(isolated.tools.getVersion("write")).toBe("1");
    expect(tools.getVersion("write")).toBeUndefined();
    await parent.dispose();
    expect(isolated.tools.getVersion("write")).toBe("1");
    await otherParent.dispose();
    expect(isolated.tools.getVersion("write")).toBeUndefined();
  });
});

describe("general agent mandatory tool pipeline", () => {
  it("validates before authorization and cannot bypass denial or alter the pinned input", async () => {
    const tools = new ToolRegistry();
    const execute = vi.fn(tool().execute);
    tools.register(tool({ execute }));
    const authorize = vi.fn(
      (): ToolAuthorizationDecision => ({ type: "deny", reason: "restricted" }),
    );
    const pipeline = new ToolPipeline(tools, authorize);
    expect(await pipeline.execute({ ...call, input: { value: 7 } }, context)).toMatchObject({
      status: "failed",
      effects: "none",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(await pipeline.execute(call, context)).toMatchObject({
      status: "failed",
      effects: "none",
      error: { code: "tool_denied" },
    });
    expect(execute).not.toHaveBeenCalled();
    const allowing = new ToolPipeline(tools, (authorizedCall) => {
      Object.assign(authorizedCall.input, { value: "tampered" });
      return { type: "allow" };
    });
    expect(await allowing.execute(call, context)).toMatchObject({
      status: "succeeded",
      output: { value: "saved" },
    });
    expect(call.input).toEqual({ value: "saved" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses a tool unregistered while asynchronous authorization is pending", async () => {
    const tools = new ToolRegistry();
    const execute = vi.fn(tool().execute);
    const registration = tools.register(tool({ execute }));
    const entered = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<ToolAuthorizationDecision>();
    const pipeline = new ToolPipeline(tools, () => {
      entered.resolve();
      return decision.promise;
    });
    const result = pipeline.execute(call, context);
    await entered.promise;
    await registration.dispose();
    decision.resolve({ type: "allow" });
    expect(await result).toMatchObject({
      status: "failed",
      effects: "none",
      error: { code: "tool_stale" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves applied effects on output validation, projection and cancellation failures", async () => {
    const cases: ImmediateToolDefinition<Value, Value>[] = [
      tool({ outputSchema: z.object({ value: z.string().min(100) }) }),
      tool({
        toModelContent() {
          throw new Error("projection failed");
        },
      }),
      tool({
        toPresentation() {
          throw new Error("presentation failed");
        },
      }),
    ];
    for (const definition of cases) {
      const tools = new ToolRegistry();
      tools.register(definition);
      expect(
        await new ToolPipeline(tools, () => ({ type: "allow" })).execute(call, context),
      ).toMatchObject({ status: "failed", effects: "applied" });
    }
    const controller = new AbortController();
    const tools = new ToolRegistry();
    tools.register(
      tool({
        async execute(input) {
          controller.abort();
          return { status: "succeeded", output: input, effects: "applied" };
        },
      }),
    );
    expect(
      await new ToolPipeline(tools, () => ({ type: "allow" })).execute(call, {
        ...context,
        signal: controller.signal,
      }),
    ).toMatchObject({ status: "failed", effects: "applied" });
  });

  it("reports a thrown tool body as uncertain and never retries it", async () => {
    const tools = new ToolRegistry();
    const execute = vi.fn(async () => {
      throw new Error("Connection lost after write");
    });
    tools.register(tool({ execute }));
    expect(
      await new ToolPipeline(tools, () => ({ type: "allow" })).execute(call, context),
    ).toMatchObject({ status: "unknown", effects: "unknown" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rechecks current policy and exact call identity before accepting an approval", async () => {
    const tools = new ToolRegistry();
    const execute = vi.fn(tool().execute);
    tools.register(tool({ execute }));
    let decision: ToolAuthorizationDecision = { type: "approval", interaction: approval };
    const pipeline = new ToolPipeline(tools, () => decision);
    const suspended = await waiting(pipeline);
    expect(execute).not.toHaveBeenCalled();
    const yes = { type: "answer" as const, interactionId: approval.id, value: true };
    expect(
      await pipeline.resume(
        { ...call, input: { value: "changed" } },
        suspended.continuation,
        yes,
        context,
      ),
    ).toMatchObject({ status: "failed", effects: "none", error: { code: "tool_call_mismatch" } });
    expect(
      await pipeline.resume(
        call,
        suspended.continuation,
        { ...yes, interactionId: "other" },
        context,
      ),
    ).toMatchObject({ status: "failed", error: { code: "tool_response_mismatch" } });
    expect(
      await pipeline.resume(call, suspended.continuation, yes, {
        ...context,
        identity: { ...identity, queryId: "foreign" },
      }),
    ).toMatchObject({ status: "failed", error: { code: "tool_call_mismatch" } });
    expect(
      await pipeline.resume(call, suspended.continuation, { ...yes, value: false }, context),
    ).toMatchObject({ status: "failed", error: { code: "tool_approval_rejected" } });
    decision = { type: "deny", reason: "Permission revoked" };
    expect(await pipeline.resume(call, suspended.continuation, yes, context)).toMatchObject({
      status: "failed",
      error: { code: "tool_denied" },
    });
    expect(execute).not.toHaveBeenCalled();
    decision = { type: "approval", interaction: approval };
    const resumedContext = { ...context, identity: { ...identity, runId: "resumed-run" } };
    const results = await Promise.all([
      pipeline.resume(call, suspended.continuation, yes, resumedContext),
      pipeline.resume(call, suspended.continuation, yes, resumedContext),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["failed", "succeeded"]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects stale tool versions without entering a replacement tool body", async () => {
    const tools = new ToolRegistry();
    const registration = tools.register(tool());
    const pipeline = new ToolPipeline(tools, () => ({ type: "approval", interaction: approval }));
    const suspended = await waiting(pipeline);
    await registration.dispose();
    const execute = vi.fn(tool().execute);
    tools.register(tool({ version: "2", execute }));
    expect(
      await pipeline.resume(
        call,
        suspended.continuation,
        { type: "answer", interactionId: approval.id, value: true },
        context,
      ),
    ).toMatchObject({ status: "failed", effects: "none", error: { code: "tool_stale" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("resumes a normal resumable tool, including a newly required approval, without re-execution", async () => {
    const tools = new ToolRegistry();
    const nested = { type: "plugin.wait", version: 1, data: { receipt: "written" } };
    const userInteraction = { ...approval, id: "user-answer", owner: "plugin" };
    const execute = vi.fn(
      async (): Promise<ToolSuspension> => ({
        status: "waiting",
        interaction: userInteraction,
        continuation: nested,
        effects: "applied",
      }),
    );
    const resume = vi.fn(async (continuation: VersionedData, response: InteractionResponse) => {
      expect(continuation).toEqual(nested);
      expect(response).toEqual({
        type: "answer",
        interactionId: userInteraction.id,
        value: "continue",
      });
      return {
        status: "succeeded" as const,
        output: { value: "resumed" },
        effects: "applied" as const,
      };
    });
    tools.register({ ...tool(), mode: "resumable", execute, resume });
    let decision: ToolAuthorizationDecision = { type: "allow" };
    const pipeline = new ToolPipeline(tools, () => decision);
    const suspended = await waiting(pipeline);
    decision = { type: "deny", reason: "Permission revoked after effects" };
    expect(
      await pipeline.resume(
        call,
        suspended.continuation,
        { type: "answer", interactionId: userInteraction.id, value: "continue" },
        context,
      ),
    ).toMatchObject({ status: "failed", effects: "applied", error: { code: "tool_denied" } });
    expect(resume).not.toHaveBeenCalled();
    decision = { type: "approval", interaction: approval };
    const approvalWait = await pipeline.resume(
      call,
      suspended.continuation,
      { type: "answer", interactionId: userInteraction.id, value: "continue" },
      context,
    );
    expect(approvalWait).toMatchObject({
      status: "waiting",
      effects: "applied",
      interaction: approval,
    });
    expect(resume).not.toHaveBeenCalled();
    if (approvalWait.status !== "waiting") throw new Error("Expected approval");
    expect(
      await pipeline.resume(
        call,
        approvalWait.continuation,
        { type: "answer", interactionId: approval.id, value: true },
        context,
      ),
    ).toMatchObject({ status: "succeeded", effects: "applied", output: { value: "resumed" } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
