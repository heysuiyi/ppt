import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunHandle, AgentRunInput } from "@agent-harness/core/agent-contract";
import type { AgentCreationOptions, AgentServices } from "@agent-harness/core/agent-factory";
import { createAgentApplication } from "@agent-harness/core/application/agent-application";
import type {
  AgentPlugin,
  PluginContext,
  PluginScope,
} from "@agent-harness/core/extensions/plugin-contract";
import type {
  ModelBinding,
  ModelCallContext,
  ModelClient,
  ModelContent,
  ModelRequest,
  ModelResponse,
} from "@agent-harness/core/model/model-contract";
import { sameValue, snapshot } from "@agent-harness/core/protocol-values";
import type {
  CheckpointKey,
  CheckpointLease,
} from "@agent-harness/core/session/checkpoint-contract";
import type { AgentCheckpoint, SessionHistory } from "@agent-harness/core/session/session-contract";
import type { RuntimeEvent } from "@agent-harness/core/session/session-events";
import type { ToolExecutionContext, ToolResult } from "@agent-harness/core/tools/tool-contract";
import { describe, expect, it, type Mock, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { createSqliteAgentStores } from "../cli/host/sqlite-agent-stores.js";

const response: ModelResponse = {
  message: { role: "assistant", content: [{ type: "text", text: "saved answer" }] },
  finishReason: "stop",
};

function creation(overrides: Partial<AgentCreationOptions> = {}): AgentCreationOptions {
  return {
    agentId: "agent",
    definition: { id: "definition", version: "1", instructions: "Be helpful." },
    model: { providerId: "test", modelId: "model" },
    maxSteps: 4,
    plugins: [],
    ...overrides,
  };
}

function activation(runId = "run"): AgentRunInput {
  return {
    threadId: "thread",
    queryId: `query-${runId}`,
    runId,
    input: [{ role: "user", content: [{ type: "text", text: "original" }] }],
  };
}

/** 测试端口实现保留真实 CAS、租约和追加回执，而不是绕过执行循环。 */
function fixture() {
  const histories = new Map<string, SessionHistory>();
  const receipts = new Map<string, { messages: unknown; revision: number }>();
  const rows = new Map<
    string,
    {
      key: CheckpointKey;
      checkpoint: AgentCheckpoint | null;
      revision: number;
      generation: number;
      lease: CheckpointLease | null;
    }
  >();
  const hooks: { beforeRelease?: () => Promise<void> } = {};
  const bindingDisposed = vi.fn(async () => {});
  const borrowedDisposed = vi.fn(async () => {});
  const generate = vi.fn(
    async (_request: ModelRequest, _signal: AbortSignal): Promise<ModelResponse> =>
      snapshot(response),
  );
  const client: ModelClient = {
    selection: creation().model,
    capabilities: { streaming: false, toolCalls: true, images: true, reasoning: false },
    generate,
    async *stream(request, signal) {
      yield { type: "completed", response: await generate(request, signal) };
    },
  };
  const binding: ModelBinding = { client, dispose: bindingDisposed };
  const bind = vi.fn(async (_selection: unknown, _signal: AbortSignal) => binding);
  const history = {
    dispose: borrowedDisposed,
    async read(threadId: string): Promise<SessionHistory> {
      return snapshot(histories.get(threadId) ?? { threadId, revision: 0, messages: [] });
    },
    async append(
      threadId: string,
      expectedRevision: number,
      messages: SessionHistory["messages"],
      batchId: string,
    ) {
      const receiptKey = JSON.stringify([threadId, batchId]);
      const receipt = receipts.get(receiptKey);
      if (receipt) {
        if (!sameValue(receipt.messages, messages)) throw new Error("Batch content changed");
        return { status: "appended" as const, revision: receipt.revision };
      }
      const current = histories.get(threadId) ?? { threadId, revision: 0, messages: [] };
      if (current.revision !== expectedRevision)
        return { status: "conflict" as const, currentRevision: current.revision };
      const revision = current.revision + 1;
      histories.set(
        threadId,
        snapshot({ threadId, revision, messages: [...current.messages, ...messages] }),
      );
      receipts.set(receiptKey, { messages: snapshot(messages), revision });
      return { status: "appended" as const, revision };
    },
  };
  const checkpoints: AgentServices["checkpoints"] & { dispose: typeof borrowedDisposed } = {
    dispose: borrowedDisposed,
    async findUnfinished(agentId, threadId) {
      for (const { checkpoint } of rows.values()) {
        if (
          checkpoint &&
          checkpoint.agentId === agentId &&
          checkpoint.threadId === threadId &&
          (checkpoint.status === "running" ||
            checkpoint.status === "waiting" ||
            checkpoint.status === "interrupted")
        )
          return snapshot(checkpoint);
      }
      return null;
    },
    async acquire(key, ownerId, options) {
      const name = JSON.stringify(key);
      let row = rows.get(name);
      if (options?.replace && !sameValue(options.replace, row?.lease)) return { status: "stale" };
      if (!options?.replace && row?.lease) return { status: "busy", lease: snapshot(row.lease) };
      // 准入先检查目标租约，再检查同线程其他查询；拒绝不能创建空行或消耗代际。
      for (const other of rows.values()) {
        if (
          other.key.agentId === key.agentId &&
          other.key.threadId === key.threadId &&
          other.key.queryId !== key.queryId &&
          (other.lease ||
            other.checkpoint?.status === "running" ||
            other.checkpoint?.status === "waiting" ||
            other.checkpoint?.status === "interrupted")
        )
          return { status: "thread-pending", queryId: other.key.queryId };
      }
      if (!row) {
        row = { key: snapshot(key), checkpoint: null, revision: 0, generation: 0, lease: null };
        rows.set(name, row);
      }
      const lease = { key: snapshot(key), ownerId, generation: ++row.generation };
      row.lease = lease;
      return {
        status: "acquired",
        lease: snapshot(lease),
        currentRevision: row.revision,
        checkpoint: snapshot(row.checkpoint),
      };
    },
    async save(lease, expectedRevision, checkpoint) {
      const row = rows.get(JSON.stringify(lease.key));
      if (!row || !sameValue(row.lease, lease)) return { status: "stale" };
      if (row.revision !== expectedRevision)
        return { status: "conflict", currentRevision: row.revision };
      row.checkpoint = snapshot(checkpoint);
      return { status: "saved", revision: ++row.revision };
    },
    async release(lease) {
      await hooks.beforeRelease?.();
      const row = rows.get(JSON.stringify(lease.key));
      if (row && sameValue(row.lease, lease)) row.lease = null;
    },
  };
  const services: AgentServices = {
    models: { create: bind, dispose: borrowedDisposed } as AgentServices["models"] & {
      dispose: typeof borrowedDisposed;
    },
    authorizeTool: () => ({ type: "allow" }),
    checkpoints,
    history,
  };
  return {
    services,
    history,
    rows,
    hooks,
    binding,
    bind,
    generate,
    bindingDisposed,
    borrowedDisposed,
  };
}

function checkpointKey(queryId: string): CheckpointKey {
  return { agentId: "agent", threadId: "thread", queryId };
}

describe.each([false, true])("model completion observations (streaming: %s)", (streaming) => {
  it("reports per-request duration and authoritative usage without private response data", async () => {
    const f = fixture();
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const finish = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const contexts: ModelCallContext[] = [];
    const enteredAt: number[] = [];
    const privateValue = "PRIVATE_RESPONSE_METRICS_SENTINEL";
    const responses: ModelResponse[] = [
      {
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", text: privateValue },
            { type: "tool-call", callId: "metrics-call", name: "metrics.echo", input: {} },
          ],
          replayState: {
            providerId: "test",
            modelId: "model",
            format: "private",
            version: 1,
            data: privateValue,
          },
        },
        finishReason: "tool-calls",
        usage: Object.assign({ inputTokens: 23, outputTokens: 7 }, { privateValue }),
      },
      { ...response, usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    const generate: ModelClient["generate"] = async (_request, signal, context) => {
      if (!context) throw new Error("Expected a model request identity.");
      const index = contexts.length;
      contexts.push(context);
      enteredAt.push(performance.now());
      entered[index].resolve();
      await finish[index].promise;
      signal.throwIfAborted();
      return responses[index];
    };
    f.bind.mockResolvedValue({
      ...f.binding,
      client: {
        ...f.binding.client,
        capabilities: { ...f.binding.client.capabilities, streaming },
        generate,
        async *stream(request, signal, context) {
          yield { type: "completed", response: await generate(request, signal, context) };
        },
      },
    });
    const app = createAgentApplication(f.services);
    onTestFinished(async () => {
      for (const gate of finish) gate.resolve();
      await app.close();
    });
    const agent = await app.agents.create(
      creation({
        plugins: [
          {
            id: "metrics",
            version: "1",
            setup({ tools }) {
              tools.register({
                name: "metrics.echo",
                owner: "metrics",
                version: "1",
                description: "Return an observation test result",
                mode: "immediate",
                inputSchema: z.object({}),
                outputSchema: z.object({}),
                execute: async () => ({ status: "succeeded", output: {}, effects: "none" }),
                toModelContent: () => [{ type: "text", text: "done" }],
              });
            },
          },
        ],
      }),
    );
    const run = await agent.run(activation());
    const minimumDurations: number[] = [];
    for (let index = 0; index < entered.length; index += 1) {
      await entered[index].promise;
      minimumDurations.push(performance.now() - enteredAt[index]);
      finish[index].resolve();
    }
    expect((await run.completed).status).toBe("completed");
    const events: RuntimeEvent[] = [];
    for await (const event of run.events) events.push(event);
    const completed = events.filter((event) => event.type === "model.completed");
    expect(completed).toHaveLength(2);
    expect(contexts[0].requestId).not.toBe(contexts[1].requestId);
    for (const [index, event] of completed.entries()) {
      expect(event).toEqual({
        identity: run.identity,
        kind: "fact",
        type: "model.completed",
        requestId: contexts[index].requestId,
        step: index + 1,
        durationMs: expect.any(Number),
        usage: {
          inputTokens: responses[index].usage?.inputTokens,
          outputTokens: responses[index].usage?.outputTokens,
        },
      });
      expect(Number.isFinite(event.durationMs)).toBe(true);
      expect(event.durationMs).toBeGreaterThanOrEqual(minimumDurations[index]);
      const position = events.indexOf(event);
      expect(position).toBeGreaterThan(
        events.findIndex(
          (candidate) => candidate.type === "step.started" && candidate.step === event.step,
        ),
      );
      expect(position).toBeLessThan(
        events.findIndex(
          (candidate) => candidate.type === "step.committed" && candidate.step === event.step,
        ),
      );
    }
    expect(JSON.stringify(completed)).not.toContain(privateValue);
  });

  it.each([
    { label: "missing", usage: undefined },
    { label: "negative input", usage: { inputTokens: -1, outputTokens: 2 } },
    { label: "negative output", usage: { inputTokens: 1, outputTokens: -2 } },
    { label: "fractional", usage: { inputTokens: 1, outputTokens: 0.5 } },
    {
      label: "unsafe integer",
      usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 2 },
    },
  ])("omits $label usage without changing model success", async ({ usage }) => {
    const f = fixture();
    f.generate.mockResolvedValue(usage ? { ...response, usage } : response);
    f.bind.mockResolvedValue({
      ...f.binding,
      client: {
        ...f.binding.client,
        capabilities: { ...f.binding.client.capabilities, streaming },
      },
    });
    const app = createAgentApplication(f.services);
    onTestFinished(() => app.close());
    const agent = await app.agents.create(creation());
    const run = await agent.run(activation());
    expect((await run.completed).status).toBe("completed");
    const completed = [];
    for await (const event of run.events) {
      if (event.type === "model.completed") completed.push(event);
    }
    expect(completed).toHaveLength(1);
    expect(completed[0]).not.toHaveProperty("usage");
    expect((await f.history.read("thread")).messages.at(-1)).toEqual(response.message);
  });

  it.each([
    {
      label: "truncated",
      result: { ...response, finishReason: "length" as const },
      code: "MODEL_TRUNCATED",
    },
    {
      label: "stopped",
      result: { ...response, finishReason: "other" as const },
      code: "MODEL_STOPPED",
    },
    {
      label: "invalid tool finish",
      result: { ...response, finishReason: "tool-calls" as const },
      code: "INVALID_MODEL_RESPONSE",
    },
    {
      label: "NaN usage",
      result: { ...response, usage: { inputTokens: Number.NaN, outputTokens: 1 } },
      code: "INVALID_PROTOCOL_VALUE",
    },
    {
      label: "infinite usage",
      result: { ...response, usage: { inputTokens: 1, outputTokens: Number.POSITIVE_INFINITY } },
      code: "INVALID_PROTOCOL_VALUE",
    },
    { label: "provider failure", result: null, code: "EXECUTION_FAILED" },
  ])("does not report completion for $label", async ({ result, code }) => {
    const f = fixture();
    if (result) f.generate.mockResolvedValue(result);
    else f.generate.mockRejectedValue(new Error("private provider failure"));
    f.bind.mockResolvedValue({
      ...f.binding,
      client: {
        ...f.binding.client,
        capabilities: { ...f.binding.client.capabilities, streaming },
      },
    });
    const app = createAgentApplication(f.services);
    onTestFinished(() => app.close());
    const agent = await app.agents.create(creation());
    const run = await agent.run(activation());
    expect(await run.completed).toMatchObject({ status: "failed", error: { code } });
    const types: string[] = [];
    for await (const event of run.events) types.push(event.type);
    expect(types).not.toContain("model.completed");
    expect((await f.history.read("thread")).messages).toEqual(activation().input);
  });
});

describe("model stream completion boundary", () => {
  it.each([
    { suffix: "late delta", code: "INVALID_MODEL_STREAM" },
    { suffix: "duplicate completion", code: "INVALID_MODEL_STREAM" },
    { suffix: "late failure", code: "EXECUTION_FAILED" },
  ])("does not report a response followed by $suffix as complete", async ({ suffix, code }) => {
    const f = fixture();
    f.bind.mockResolvedValue({
      ...f.binding,
      client: {
        ...f.binding.client,
        capabilities: { ...f.binding.client.capabilities, streaming: true },
        async *stream() {
          yield {
            type: "completed",
            response: { ...response, usage: { inputTokens: 3, outputTokens: 1 } },
          };
          if (suffix === "late delta") {
            yield { type: "content-delta", index: 0, delta: { type: "text", text: "late" } };
          } else if (suffix === "duplicate completion") {
            yield { type: "completed", response };
          } else {
            throw new Error("private late provider failure");
          }
        },
      },
    });
    const app = createAgentApplication(f.services);
    onTestFinished(() => app.close());
    const agent = await app.agents.create(creation());
    const run = await agent.run(activation());
    expect(await run.completed).toMatchObject({ status: "failed", error: { code } });
    const types: string[] = [];
    for await (const event of run.events) types.push(event.type);
    expect(types).not.toContain("model.completed");
    expect((await f.history.read("thread")).messages).toEqual(activation().input);
  });
});

describe("general agent creation ownership", () => {
  it("detaches creation cancellation after publication and never closes borrowed ports", async () => {
    const f = fixture();
    const creationSignal = new AbortController();
    const pluginDisposed = vi.fn(async () => {});
    let pluginSignal: AbortSignal | undefined;
    const app = createAgentApplication(f.services);
    const agent = await app.agents.create(
      creation({
        signal: creationSignal.signal,
        plugins: [
          {
            id: "plugin",
            version: "1",
            setup({ scope }) {
              pluginSignal = scope.signal;
              scope.own({ dispose: pluginDisposed });
            },
          },
        ],
      }),
    );
    expect(f.generate).not.toHaveBeenCalled();
    creationSignal.abort("caller no longer needs creation");
    expect(pluginSignal?.aborted).toBe(false);
    const handle = await agent.run(activation());
    expect((await handle.completed).status).toBe("completed");
    expect((await f.history.read("thread")).messages.at(-1)).toEqual(response.message);
    await app.close();
    expect(pluginSignal?.aborted).toBe(true);
    expect(pluginDisposed).toHaveBeenCalledTimes(1);
    expect(f.bindingDisposed).toHaveBeenCalledTimes(1);
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
  });

  it("reserves pending IDs synchronously and frees failed or individually disposed entries", async () => {
    const f = fixture();
    const app = createAgentApplication(f.services);
    const gate = Promise.withResolvers<void>();
    const rolledBack = vi.fn(async () => {});
    const pending = app.agents.create(
      creation({
        plugins: [
          {
            id: "broken",
            version: "1",
            async setup({ scope }) {
              scope.own({ dispose: rolledBack });
              await gate.promise;
              throw new Error("setup failed");
            },
          },
        ],
      }),
    );
    await expect(app.agents.create(creation())).rejects.toMatchObject({ code: "duplicate-agent" });
    const failed = expect(pending).rejects.toThrow("setup failed");
    gate.resolve();
    await failed;
    expect(rolledBack).toHaveBeenCalledTimes(1);
    const first = await app.agents.create(creation());
    const other = await app.agents.create(creation({ agentId: "other" }));
    await first.dispose();
    const replacement = await app.agents.create(creation());
    await expect(app.agents.create(creation({ agentId: "other" }))).rejects.toMatchObject({
      code: "duplicate-agent",
    });
    await Promise.all([replacement.dispose(), other.dispose()]);
    await app.dispose();
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
  });

  it("close aborts and drains unpublished late model bindings before resolving", async () => {
    const f = fixture();
    const bindingReady = Promise.withResolvers<void>();
    const releaseBinding = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    f.bind.mockImplementation(async (_selection, creationSignal) => {
      signal = creationSignal;
      bindingReady.resolve();
      await releaseBinding.promise;
      return f.binding;
    });
    const app = createAgentApplication(f.services);
    const pending = app.agents.create(creation());
    const rejection = expect(pending).rejects.toThrow();
    await bindingReady.promise;
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseBinding.resolve();
    await rejection;
    await closing;
    expect(f.bindingDisposed).toHaveBeenCalledTimes(1);
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    await expect(app.agents.create(creation())).rejects.toMatchObject({
      code: "application-closed",
    });
  });

  it("drains a create even when plugin setup synchronously reenters close", async () => {
    const f = fixture();
    const app = createAgentApplication(f.services);
    const setupDone = Promise.withResolvers<void>();
    const disposed = vi.fn(async () => {});
    let closing: Promise<void> | undefined;
    const creating = app.agents.create(
      creation({
        plugins: [
          {
            id: "reentrant",
            version: "1",
            async setup({ scope }) {
              scope.own({ dispose: disposed });
              closing = app.close();
              expect(scope.signal.aborted).toBe(true);
              await setupDone.promise;
            },
          },
        ],
      }),
    );
    const rejected = expect(creating).rejects.toThrow();
    if (!closing) throw new Error("Plugin setup did not initiate close");
    expect(app.close()).toBe(closing);
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    setupDone.resolve();
    await rejected;
    await closing;
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
  });

  it("keeps each installation's resource ownership and cancellation independent", async () => {
    const f = fixture();
    const app = createAgentApplication(f.services);
    onTestFinished(() => app.close());
    const scopes: PluginScope[] = [];
    const disposed: number[] = [];
    const plugin: AgentPlugin = {
      id: "shared-definition",
      version: "1",
      setup({ scope }) {
        const installation = scopes.length;
        scopes.push(scope);
        scope.own({
          async dispose() {
            disposed.push(installation);
          },
        });
      },
    };
    const first = await app.agents.create(creation({ agentId: "first", plugins: [plugin] }));
    const second = await app.agents.create(creation({ agentId: "second", plugins: [plugin] }));
    await first.dispose();
    expect(scopes[0].signal.aborted).toBe(true);
    expect(scopes[1].signal.aborted).toBe(false);
    expect(disposed).toEqual([0]);
    const lateResource = { dispose: vi.fn(async () => {}) };
    expect(() => scopes[0].own(lateResource)).toThrow();
    expect(lateResource.dispose).not.toHaveBeenCalled();
    expect((await (await second.run(activation())).completed).status).toBe("completed");
    await app.close();
    expect(scopes[1].signal.aborted).toBe(true);
    expect(disposed).toEqual([0, 1]);
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
  });
});

describe("general agent installation atomicity", () => {
  const model = { providerId: "rollback-model", modelId: "model" };
  interface InstallationBinding {
    readonly binding: ModelBinding;
    readonly generate: Mock<ModelClient["generate"]>;
    readonly dispose: Mock<() => Promise<void>>;
    readonly released: boolean;
  }

  function installationFixture() {
    const f = fixture();
    const bindings: InstallationBinding[] = [];
    function newBinding() {
      let released = false;
      const dispose = vi.fn(async () => {
        released = true;
      });
      const generate = vi.fn(
        async (request: ModelRequest, _signal: AbortSignal): Promise<ModelResponse> => {
          const latestInput = request.messages.findLastIndex((message) => message.role === "user");
          const result = request.messages
            .slice(latestInput + 1)
            .flatMap<ModelContent>((message) => message.content)
            .findLast((content) => content.type === "tool-result");
          if (result?.type === "tool-result") {
            if (result.isError) throw new Error("Expected the installed tool to succeed");
            return {
              message: {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: result.content
                      .map((content) => (content.type === "text" ? content.text : ""))
                      .join(""),
                  },
                ],
              },
              finishReason: "stop",
            };
          }
          return {
            message: {
              role: "assistant",
              content: [
                { type: "tool-call", callId: "installed-call", name: "rollback.read", input: {} },
              ],
            },
            finishReason: "tool-calls",
          };
        },
      );
      const client: ModelClient = {
        selection: model,
        capabilities: f.binding.client.capabilities,
        generate,
        async *stream(request, signal) {
          yield { type: "completed", response: await generate(request, signal) };
        },
      };
      const binding: ModelBinding = { client, dispose };
      return {
        binding,
        generate,
        dispose,
        get released() {
          return released;
        },
      };
    }
    f.bind.mockImplementation(async () => {
      const record = newBinding();
      bindings.push(record);
      return record.binding;
    });
    return { ...f, bindings };
  }

  function capability(owner: string, services: AgentServices) {
    const execute = vi.fn(async () => ({
      status: "succeeded" as const,
      output: { owner },
      effects: "none" as const,
    }));
    const tool = {
      name: "rollback.read",
      version: "1",
      owner,
      description: "Read this installation's value",
      mode: "immediate" as const,
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ owner: z.string() }).strict(),
      execute,
      toModelContent: (result: ToolResult<{ owner: string }>) => [
        {
          type: "text" as const,
          text:
            result.status === "succeeded" ? `installed:${result.output.owner}` : result.error.code,
        },
      ],
    };
    const plugin: AgentPlugin = {
      id: owner,
      version: "1",
      setup({ models, tools, prompts }) {
        models.register(model.providerId, services.models);
        tools.register(tool);
        prompts.register({ id: "rollback-prompt", render: () => `prompt:${owner}` });
      },
    };
    return { plugin, tool, execute };
  }

  function resource(name: string, order: string[], cleanupError?: Error) {
    let released = false;
    const dispose = vi.fn(async () => {
      order.push(name);
      if (cleanupError) throw cleanupError;
      released = true;
    });
    return {
      dispose,
      get released() {
        return released;
      },
    };
  }

  function containsError(error: unknown, expected: Error): boolean {
    return (
      error === expected ||
      (error instanceof AggregateError &&
        error.errors.some((nested: unknown) => containsError(nested, expected)))
    );
  }

  it.each(["providerId", "tool name", "prompt id"] as const)(
    "rolls back a cross-plugin %s conflict and reuses the failed ID in the same application",
    async (conflict) => {
      const f = installationFixture();
      const app = createAgentApplication(f.services);
      onTestFinished(() => app.close());
      const order: string[] = [];
      const first = resource("first", order);
      const second = resource("second", order);
      const installed = capability("first-plugin", f.services);
      const conflicting = capability("second-plugin", f.services);
      let secondSetupEntered = false;
      await expect(
        app.agents.create(
          creation({
            model,
            plugins: [
              {
                ...installed.plugin,
                setup(context) {
                  context.scope.own(first);
                  return installed.plugin.setup(context);
                },
              },
              {
                ...conflicting.plugin,
                setup({ scope, models, tools, prompts }) {
                  secondSetupEntered = true;
                  scope.own(second);
                  if (conflict === "providerId")
                    models.register(model.providerId, f.services.models);
                  else if (conflict === "tool name") tools.register(conflicting.tool);
                  else prompts.register({ id: "rollback-prompt", render: () => "conflict" });
                },
              },
            ],
          }),
        ),
      ).rejects.toThrow();
      expect(secondSetupEntered).toBe(true);
      expect(order).toEqual(["second", "first"]);
      for (const owned of [first, second]) {
        expect(owned.dispose).toHaveBeenCalledTimes(1);
        expect(owned.released).toBe(true);
      }
      expect(f.bind).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
      expect(installed.execute).not.toHaveBeenCalled();
      expect(conflicting.execute).not.toHaveBeenCalled();
      expect(f.borrowedDisposed).not.toHaveBeenCalled();
      const replacement = capability("replacement", f.services);
      const agent = await app.agents.create(creation({ model, plugins: [replacement.plugin] }));
      expect(f.bindings[0].generate).not.toHaveBeenCalled();
      const handle = await agent.run(activation());
      expect((await handle.completed).status).toBe("completed");
      expect(replacement.execute).toHaveBeenCalledTimes(1);
      const committedHistory = await f.history.read("thread");
      expect(committedHistory.messages.at(-1)).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "installed:replacement" }],
      });
      await app.close();
      expect(f.bindings[0].dispose).toHaveBeenCalledTimes(1);
      expect(f.bindings[0].released).toBe(true);
      for (const owned of [first, second]) expect(owned.dispose).toHaveBeenCalledTimes(1);
      expect(f.borrowedDisposed).not.toHaveBeenCalled();
      expect(await f.history.read("thread")).toEqual(committedHistory);
    },
  );

  it("rolls back later setup in reverse order without poisoning retained contexts or healthy installations", async () => {
    const f = installationFixture();
    const app = createAgentApplication(f.services);
    onTestFinished(() => app.close());
    const healthy = capability("healthy", f.services);
    const healthyResource = resource("healthy", []);
    const healthyAgent = await app.agents.create(
      creation({
        agentId: "healthy",
        model,
        plugins: [
          {
            ...healthy.plugin,
            setup(context) {
              context.scope.own(healthyResource);
              return healthy.plugin.setup(context);
            },
          },
        ],
      }),
    );
    const healthyBinding = f.bindings[0];
    const healthyActivation = (runId: string) => ({
      ...activation(runId),
      threadId: "healthy-thread",
    });
    expect((await (await healthyAgent.run(healthyActivation("before"))).completed).status).toBe(
      "completed",
    );
    const healthyCalls = healthyBinding.generate.mock.calls.length;
    const order: string[] = [];
    const first = resource("first", order);
    const second = resource("second", order);
    const third = resource("third", order);
    const failed = capability("failed-first", f.services);
    const later = capability("failed-later", f.services);
    const setupError = new Error("named setup failure");
    let retained: PluginContext | undefined;
    const creating = app.agents.create(
      creation({
        model,
        plugins: [
          {
            ...failed.plugin,
            setup(context) {
              context.scope.own(first);
              return failed.plugin.setup(context);
            },
          },
          {
            ...later.plugin,
            setup(context) {
              retained = context;
              context.scope.own(second);
              context.models.register("later-model", f.services.models);
              context.tools.register({ ...later.tool, name: "later.read" });
              context.prompts.register({ id: "later-prompt", render: () => "later" });
              context.scope.own(third);
              throw setupError;
            },
          },
        ],
      }),
    );
    const error = await creating.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(containsError(error, setupError)).toBe(true);
    expect(order).toEqual(["third", "second", "first"]);
    for (const owned of [first, second, third]) {
      expect(owned.dispose).toHaveBeenCalledTimes(1);
      expect(owned.released).toBe(true);
    }
    if (!retained) throw new Error("The later setup did not retain its public context");
    const closedContext = retained;
    expect(closedContext.scope.signal.aborted).toBe(true);
    expect(() => closedContext.models.register("late-model", f.services.models)).toThrow();
    expect(() => closedContext.tools.register({ ...later.tool, name: "late.read" })).toThrow();
    expect(() =>
      closedContext.prompts.register({ id: "late-prompt", render: () => "late" }),
    ).toThrow();
    expect(f.bind).toHaveBeenCalledTimes(1);
    expect(healthyBinding.generate).toHaveBeenCalledTimes(healthyCalls);
    expect(failed.execute).not.toHaveBeenCalled();
    expect(later.execute).not.toHaveBeenCalled();
    expect(healthyBinding.released).toBe(false);
    expect(healthyResource.dispose).not.toHaveBeenCalled();
    expect(healthyResource.released).toBe(false);
    const replacement = capability("replacement", f.services);
    const replacementAgent = await app.agents.create(
      creation({ model, plugins: [replacement.plugin] }),
    );
    const replacementBinding = f.bindings[1];
    expect(replacementBinding.binding).not.toBe(healthyBinding.binding);
    expect(replacementBinding.generate).not.toHaveBeenCalled();
    expect((await (await replacementAgent.run(activation("replacement"))).completed).status).toBe(
      "completed",
    );
    expect((await f.history.read("thread")).messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "installed:replacement" }],
    });
    await replacementAgent.dispose();
    expect(replacementBinding.dispose).toHaveBeenCalledTimes(1);
    expect(replacementBinding.released).toBe(true);
    expect(healthyBinding.dispose).not.toHaveBeenCalled();
    expect(healthyBinding.released).toBe(false);
    expect((await (await healthyAgent.run(healthyActivation("after"))).completed).status).toBe(
      "completed",
    );
    expect(healthy.execute).toHaveBeenCalledTimes(2);
    expect(replacement.execute).toHaveBeenCalledTimes(1);
    expect((await f.history.read("healthy-thread")).messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "installed:healthy" }],
    });
    await app.close();
    expect(healthyBinding.dispose).toHaveBeenCalledTimes(1);
    expect(healthyBinding.released).toBe(true);
    expect(healthyResource.dispose).toHaveBeenCalledTimes(1);
    expect(healthyResource.released).toBe(true);
    expect(replacementBinding.dispose).toHaveBeenCalledTimes(1);
    for (const owned of [first, second, third]) expect(owned.dispose).toHaveBeenCalledTimes(1);
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
  });

  it("retains rollback failure after external creation cancellation and keeps the application usable", async () => {
    const f = installationFixture();
    const app = createAgentApplication(f.services);
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanupError = new Error("external cancellation cleanup failed");
    const order: string[] = [];
    const first = resource("first", order);
    const broken = resource("broken", order, cleanupError);
    const last = resource("last", order);
    const installed = capability("cancelled-installation", f.services);
    let setupSignal: AbortSignal | undefined;
    let setupExited = false;
    let committedHistory: SessionHistory | undefined;
    const creating = app.agents.create(
      creation({
        model,
        signal: controller.signal,
        plugins: [
          {
            ...installed.plugin,
            async setup(context) {
              setupSignal = context.scope.signal;
              context.scope.own(first);
              await installed.plugin.setup(context);
              context.scope.own(broken);
              context.scope.own(last);
              entered.resolve();
              await release.promise;
              setupExited = true;
            },
          },
        ],
      }),
    );
    const observed = creating.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      controller.abort(new Error("creation cancelled"));
      expect(setupSignal?.aborted).toBe(true);
      expect(setupExited).toBe(false);
      release.resolve();
      expect(containsError(await observed, cleanupError)).toBe(true);
      expect(setupExited).toBe(true);
      expect(order).toEqual(["last", "broken", "first"]);
      for (const owned of [first, broken, last]) expect(owned.dispose).toHaveBeenCalledTimes(1);
      expect(first.released).toBe(true);
      expect(last.released).toBe(true);
      expect(broken.released).toBe(false);
      expect(f.bind).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
      expect(installed.execute).not.toHaveBeenCalled();
      expect(f.borrowedDisposed).not.toHaveBeenCalled();
      const replacement = capability("after-cancellation", f.services);
      const agent = await app.agents.create(creation({ model, plugins: [replacement.plugin] }));
      expect((await (await agent.run(activation())).completed).status).toBe("completed");
      expect(replacement.execute).toHaveBeenCalledTimes(1);
      committedHistory = await f.history.read("thread");
      expect(committedHistory.messages.at(-1)).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "installed:after-cancellation" }],
      });
    } finally {
      release.resolve();
      await observed;
      await app.close();
    }
    for (const owned of [first, broken, last]) expect(owned.dispose).toHaveBeenCalledTimes(1);
    expect(broken.released).toBe(false);
    expect(f.bindings[0].dispose).toHaveBeenCalledTimes(1);
    expect(f.bindings[0].released).toBe(true);
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    expect(await f.history.read("thread")).toEqual(committedHistory);
  });

  it.each(["succeeds", "fails"] as const)(
    "late binding cleanup %s is drained and preserves creation and close errors",
    async (outcome) => {
      const f = fixture();
      const bindingEntered = Promise.withResolvers<void>();
      const bindingReady = Promise.withResolvers<void>();
      const disposalEntered = Promise.withResolvers<void>();
      const disposalReady = Promise.withResolvers<void>();
      const cleanupError = new Error("late binding cleanup failed");
      const order: string[] = [];
      const first = resource("first", order);
      const last = resource("last", order);
      let bindingReleased = false;
      let bindingSignal: AbortSignal | undefined;
      f.bind.mockImplementation(async (_selection, signal) => {
        bindingSignal = signal;
        bindingEntered.resolve();
        await bindingReady.promise;
        return f.binding;
      });
      f.bindingDisposed.mockImplementation(async () => {
        disposalEntered.resolve();
        await disposalReady.promise;
        if (outcome === "fails") throw cleanupError;
        bindingReleased = true;
      });
      const app = createAgentApplication(f.services);
      let creationSettled = false;
      const creating = app.agents.create(
        creation({
          plugins: [
            {
              id: "late-binding-owner",
              version: "1",
              setup({ scope }) {
                scope.own(first);
                scope.own(last);
              },
            },
          ],
        }),
      );
      const creationObserved = creating.then(
        () => {
          creationSettled = true;
          return undefined;
        },
        (error: unknown) => {
          creationSettled = true;
          return error;
        },
      );
      let closing: Promise<void> | undefined;
      let closeObserved: Promise<unknown> | undefined;
      try {
        await bindingEntered.promise;
        let closeSettled = false;
        closing = app.close();
        closeObserved = closing.then(
          () => {
            closeSettled = true;
            return undefined;
          },
          (error: unknown) => {
            closeSettled = true;
            return error;
          },
        );
        expect(bindingSignal?.aborted).toBe(true);
        bindingReady.resolve();
        await disposalEntered.promise;
        expect(creationSettled).toBe(false);
        expect(closeSettled).toBe(false);
        expect(bindingReleased).toBe(false);
        expect(f.bindingDisposed).toHaveBeenCalledTimes(1);
        expect(f.generate).not.toHaveBeenCalled();
        await expect(app.agents.create(creation({ agentId: "after-close" }))).rejects.toMatchObject(
          {
            code: "application-closed",
          },
        );
        expect(closeSettled).toBe(false);
        disposalReady.resolve();
        const [creationError, closeError] = await Promise.all([creationObserved, closeObserved]);
        expect(creationError).toBeDefined();
        if (outcome === "fails") {
          expect(containsError(creationError, cleanupError)).toBe(true);
          expect(containsError(closeError, cleanupError)).toBe(true);
        } else {
          expect(closeError).toBeUndefined();
        }
        expect(creationSettled).toBe(true);
        expect(closeSettled).toBe(true);
        expect(app.close()).toBe(closing);
        expect(bindingReleased).toBe(outcome === "succeeds");
        expect(order).toEqual(["last", "first"]);
        for (const owned of [first, last]) {
          expect(owned.dispose).toHaveBeenCalledTimes(1);
          expect(owned.released).toBe(true);
        }
        expect(f.bind).toHaveBeenCalledTimes(1);
        expect(f.bindingDisposed).toHaveBeenCalledTimes(1);
        expect(f.generate).not.toHaveBeenCalled();
        expect(f.borrowedDisposed).not.toHaveBeenCalled();
        expect(await f.history.read("borrowed-after-late-binding")).toEqual({
          threadId: "borrowed-after-late-binding",
          revision: 0,
          messages: [],
        });
        const acquired = await f.services.checkpoints.acquire(
          { agentId: "borrowed", threadId: "borrowed-after-late-binding", queryId: "query" },
          "host",
        );
        expect(acquired.status).toBe("acquired");
        if (acquired.status === "acquired") await f.services.checkpoints.release(acquired.lease);
      } finally {
        bindingReady.resolve();
        disposalReady.resolve();
        await creationObserved;
        if (closeObserved) await closeObserved;
        else await app.close().catch(() => {});
      }
    },
  );

  it("preserves handoff cancellation and late binding cleanup failure before scope ownership", async () => {
    const f = fixture();
    const controller = new AbortController();
    const bindingEntered = Promise.withResolvers<void>();
    const bindingReady = Promise.withResolvers<ModelBinding>();
    const disposalEntered = Promise.withResolvers<void>();
    const disposalReady = Promise.withResolvers<void>();
    const cancellationError = new Error("cancel binding handoff");
    const cleanupError = new Error("handoff binding cleanup failed");
    const order: string[] = [];
    const owned = resource("plugin", order);
    let bindingSignal: AbortSignal | undefined;
    f.bind.mockImplementation((_selection, signal) => {
      bindingSignal = signal;
      bindingEntered.resolve();
      return bindingReady.promise;
    });
    f.bindingDisposed.mockImplementation(async () => {
      disposalEntered.resolve();
      await disposalReady.promise;
      throw cleanupError;
    });
    const app = createAgentApplication(f.services);
    const creating = app.agents.create(
      creation({
        signal: controller.signal,
        plugins: [
          {
            id: "handoff-owner",
            version: "1",
            setup({ scope }) {
              scope.own(owned);
            },
          },
        ],
      }),
    );
    let creationSettled = false;
    const creationObserved = creating.then(
      () => {
        creationSettled = true;
        return undefined;
      },
      (error: unknown) => {
        creationSettled = true;
        return error;
      },
    );
    let handoffCancellation: Promise<void> | undefined;
    let closeObserved: Promise<unknown> | undefined;
    try {
      await bindingEntered.promise;
      // 注册表的 await 已先订阅；此反应在它返回后、默认工厂取得绑定前取消。
      handoffCancellation = bindingReady.promise.then(() => controller.abort(cancellationError));
      bindingReady.resolve(f.binding);
      await disposalEntered.promise;
      await handoffCancellation;
      expect(bindingSignal?.aborted).toBe(true);
      expect(f.bindingDisposed).toHaveBeenCalledTimes(1);
      expect(creationSettled).toBe(false);
      let closeSettled = false;
      const closing = app.close();
      closeObserved = closing.then(
        () => {
          closeSettled = true;
          return undefined;
        },
        (error: unknown) => {
          closeSettled = true;
          return error;
        },
      );
      await expect(app.agents.create(creation({ agentId: "after-handoff" }))).rejects.toMatchObject(
        {
          code: "application-closed",
        },
      );
      expect(closeSettled).toBe(false);
      disposalReady.resolve();
      const [creationError, closeError] = await Promise.all([creationObserved, closeObserved]);
      for (const error of [creationError, closeError]) {
        expect(containsError(error, cancellationError)).toBe(true);
        expect(containsError(error, cleanupError)).toBe(true);
      }
      expect(app.close()).toBe(closing);
      expect(order).toEqual(["plugin"]);
      expect(owned.dispose).toHaveBeenCalledTimes(1);
      expect(owned.released).toBe(true);
      expect(f.bindingDisposed).toHaveBeenCalledTimes(1);
      expect(f.generate).not.toHaveBeenCalled();
      expect(f.borrowedDisposed).not.toHaveBeenCalled();
    } finally {
      bindingReady.resolve(f.binding);
      disposalReady.resolve();
      await handoffCancellation;
      await creationObserved;
      if (closeObserved) await closeObserved;
      else await app.close().catch(() => {});
    }
  });

  it("drains unpublished setup on close and reports rollback failure from both creation and close", async () => {
    const f = installationFixture();
    const app = createAgentApplication(f.services);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanupError = new Error("application close cleanup failed");
    const order: string[] = [];
    const first = resource("first", order);
    const broken = resource("broken", order, cleanupError);
    const last = resource("last", order);
    const installed = capability("closing-installation", f.services);
    let setupSignal: AbortSignal | undefined;
    let setupExited = false;
    const creating = app.agents.create(
      creation({
        model,
        plugins: [
          {
            ...installed.plugin,
            async setup(context) {
              setupSignal = context.scope.signal;
              context.scope.own(first);
              await installed.plugin.setup(context);
              context.scope.own(broken);
              context.scope.own(last);
              entered.resolve();
              await release.promise;
              setupExited = true;
            },
          },
        ],
      }),
    );
    const creationObserved = creating.then(
      () => undefined,
      (error: unknown) => error,
    );
    let closing: Promise<void> | undefined;
    let closeObserved: Promise<unknown> | undefined;
    try {
      await entered.promise;
      let closeSettled = false;
      closing = app.close();
      closeObserved = closing.then(
        () => {
          closeSettled = true;
          return undefined;
        },
        (error: unknown) => {
          closeSettled = true;
          return error;
        },
      );
      expect(app.close()).toBe(closing);
      expect(setupSignal?.aborted).toBe(true);
      await expect(app.agents.create(creation({ agentId: "new" }))).rejects.toMatchObject({
        code: "application-closed",
      });
      expect(setupExited).toBe(false);
      expect(closeSettled).toBe(false);
      release.resolve();
      const [creationError, closeError] = await Promise.all([creationObserved, closeObserved]);
      expect(containsError(creationError, cleanupError)).toBe(true);
      expect(containsError(closeError, cleanupError)).toBe(true);
      expect(setupExited).toBe(true);
      expect(closeSettled).toBe(true);
      expect(app.close()).toBe(closing);
      expect(order).toEqual(["last", "broken", "first"]);
      for (const owned of [first, broken, last]) expect(owned.dispose).toHaveBeenCalledTimes(1);
      expect(first.released).toBe(true);
      expect(last.released).toBe(true);
      expect(broken.released).toBe(false);
      expect(f.bind).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
      expect(installed.execute).not.toHaveBeenCalled();
      expect(f.borrowedDisposed).not.toHaveBeenCalled();
      expect(await f.history.read("borrowed-after-close")).toEqual({
        threadId: "borrowed-after-close",
        revision: 0,
        messages: [],
      });
      const acquired = await f.services.checkpoints.acquire(
        { agentId: "borrowed", threadId: "borrowed-after-close", queryId: "query" },
        "host",
      );
      expect(acquired.status).toBe("acquired");
      if (acquired.status === "acquired") await f.services.checkpoints.release(acquired.lease);
    } finally {
      release.resolve();
      await creationObserved;
      if (closeObserved) await closeObserved;
      else await app.close().catch(() => {});
    }
  });
});

describe("general agent activation lifecycle", () => {
  it("settles waiting and reserves resume/resume before handle delivery and while in flight", async () => {
    const f = fixture();
    const acquire = vi.spyOn(f.services.checkpoints, "acquire");
    const toolEntered = Promise.withResolvers<void>();
    const toolReady = Promise.withResolvers<void>();
    const waitingSaved = Promise.withResolvers<void>();
    const waitingReleaseEntered = Promise.withResolvers<void>();
    const waitingReleaseReady = Promise.withResolvers<void>();
    const save = f.services.checkpoints.save.bind(f.services.checkpoints);
    vi.spyOn(f.services.checkpoints, "save").mockImplementation(async (...args) => {
      const result = await save(...args);
      if (result.status === "saved" && args[2].status === "waiting") waitingSaved.resolve();
      return result;
    });
    let firstRelease = true;
    f.hooks.beforeRelease = async () => {
      if (!firstRelease) return;
      firstRelease = false;
      waitingReleaseEntered.resolve();
      await waitingReleaseReady.promise;
    };
    const interaction = {
      id: "approve",
      owner: "host",
      payload: { type: "approval", version: 1, data: { action: "read" } },
    };
    const execute = vi.fn(async (_input: unknown, context: ToolExecutionContext) => {
      toolEntered.resolve();
      await toolReady.promise;
      context.signal.throwIfAborted();
      return {
        status: "succeeded" as const,
        output: { done: true },
        effects: "none" as const,
      };
    });
    f.generate.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: [{ type: "tool-call", callId: "call", name: "read", input: {} }],
      },
      finishReason: "tool-calls",
    });
    const services: AgentServices = {
      ...f.services,
      authorizeTool: () => ({ type: "approval", interaction }),
    };
    const app = createAgentApplication(services);
    const agent = await app.agents.create(
      creation({
        plugins: [
          {
            id: "reader",
            version: "1",
            setup({ tools }) {
              tools.register({
                name: "read",
                version: "1",
                owner: "reader",
                description: "Read a value",
                mode: "immediate",
                inputSchema: z.object({}),
                outputSchema: z.object({ done: z.boolean() }),
                execute,
                toModelContent: () => [{ type: "text", text: "read complete" }],
              });
            },
          },
        ],
      }),
    );
    const signal = new AbortController();
    const waiting = await agent.run({ ...activation(), signal: signal.signal });
    let pending: Promise<AgentRunHandle> | undefined;
    try {
      let waitingSettled = false;
      void waiting.completed.then(() => {
        waitingSettled = true;
      });
      await Promise.all([waitingSaved.promise, waitingReleaseEntered.promise]);
      expect(waitingSettled).toBe(false);
      expect(f.rows.get(JSON.stringify(checkpointKey("query-run")))?.checkpoint?.status).toBe(
        "waiting",
      );
      const acquisitionsWhileReleasing = acquire.mock.calls.length;
      await expect(agent.run(activation("waiting-release"))).rejects.toMatchObject({
        code: "agent-busy",
      });
      await expect(
        agent.resume({
          threadId: "thread",
          queryId: "query-run",
          runId: "waiting-release",
          response: { interactionId: "approve", type: "answer", value: true },
        }),
      ).rejects.toMatchObject({ code: "agent-busy" });
      expect(acquire).toHaveBeenCalledTimes(acquisitionsWhileReleasing);
      expect(waitingSettled).toBe(false);
      waitingReleaseReady.resolve();
      expect((await waiting.completed).status).toBe("waiting");
      expect(execute).not.toHaveBeenCalled();
      expect(f.bindingDisposed).not.toHaveBeenCalled();
      expect(f.rows.get(JSON.stringify(checkpointKey("query-run")))?.lease).toBeNull();
      const blocked = await agent.run(activation("cannot-bypass-waiting"));
      await expect(blocked.completed).rejects.toMatchObject({ code: "THREAD_PENDING" });
      const acquisitionsBeforeResume = acquire.mock.calls.length;
      pending = agent.resume({
        threadId: "thread",
        queryId: waiting.identity.queryId,
        runId: "resumed",
        response: { interactionId: "approve", type: "answer", value: true },
      });
      const duplicate = agent.resume({
        threadId: "thread",
        queryId: waiting.identity.queryId,
        runId: "duplicate-before-handle",
        response: { interactionId: "approve", type: "answer", value: false },
      });
      expect(acquire).toHaveBeenCalledTimes(acquisitionsBeforeResume);
      await expect(duplicate).rejects.toMatchObject({ code: "agent-busy" });
      await expect(agent.run(activation("concurrent"))).rejects.toMatchObject({
        code: "agent-busy",
      });
      const resumed = await pending;
      await toolEntered.promise;
      signal.abort("old activation is no longer observed");
      waiting.cancel("old handle cannot cancel the active resume");
      expect(execute.mock.calls[0][1].signal.aborted).toBe(false);
      expect(resumed.identity).toEqual({
        ...waiting.identity,
        runId: "resumed",
      });
      expect(acquire).toHaveBeenCalledTimes(acquisitionsBeforeResume + 1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(f.generate).toHaveBeenCalledTimes(1);
      await expect(
        agent.resume({
          threadId: "thread",
          queryId: waiting.identity.queryId,
          runId: "duplicate-in-flight",
          response: { interactionId: "approve", type: "answer", value: false },
        }),
      ).rejects.toMatchObject({ code: "agent-busy" });
      await expect(agent.run(activation("in-flight"))).rejects.toMatchObject({
        code: "agent-busy",
      });
      expect(acquire).toHaveBeenCalledTimes(acquisitionsBeforeResume + 1);
      expect(execute).toHaveBeenCalledTimes(1);
      toolReady.resolve();
      expect((await resumed.completed).status).toBe("completed");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(f.generate).toHaveBeenCalledTimes(2);
      expect(f.generate.mock.calls.at(-1)?.[1].aborted).toBe(false);
      const history = await f.history.read("thread");
      expect(history.messages.filter((message) => message.role === "user")).toHaveLength(1);
      expect(
        history.messages
          .flatMap<ModelContent>((message) => message.content)
          .filter((content) => content.type === "tool-result"),
      ).toHaveLength(1);
      expect(f.rows.get(JSON.stringify(checkpointKey("query-run")))?.checkpoint).toMatchObject({
        queryId: waiting.identity.queryId,
        lastRunId: "resumed",
        status: "completed",
      });
      expect(f.rows.get(JSON.stringify(checkpointKey("query-run")))?.lease).toBeNull();
    } finally {
      waitingReleaseReady.resolve();
      toolReady.resolve();
      await Promise.allSettled([
        waiting.completed,
        ...(pending ? [pending.then((handle) => handle.completed)] : []),
      ]);
      await app.close();
    }
  });

  it("reserves run/resume before returning a handle and snapshots mutable caller input", async () => {
    const f = fixture();
    const modelEntered = Promise.withResolvers<void>();
    const modelReady = Promise.withResolvers<ModelResponse>();
    f.generate.mockImplementation(async () => {
      modelEntered.resolve();
      return modelReady.promise;
    });
    const app = createAgentApplication(f.services);
    onTestFinished(() => app.close());
    const agent = await app.agents.create(creation());
    const content = { type: "text" as const, text: "original" };
    const pending = agent.run({ ...activation(), input: [{ role: "user", content: [content] }] });
    content.text = "mutated after run returned";
    await expect(
      agent.resume({ threadId: "thread", queryId: "other", runId: "other" }),
    ).rejects.toMatchObject({ code: "agent-busy" });
    await expect(agent.run(activation("concurrent"))).rejects.toMatchObject({ code: "agent-busy" });
    const handle = await pending;
    await modelEntered.promise;
    expect(f.generate.mock.calls[0][0].messages).toContainEqual({
      role: "user",
      content: [{ type: "text", text: "original" }],
    });
    modelReady.resolve(snapshot(response));
    expect((await handle.completed).status).toBe("completed");
    const next = await agent.run(activation("next"));
    expect((await next.completed).status).toBe("completed");
    await agent.dispose();
  });

  it("event unsubscription does not cancel work and saved terminal cleanup retains run/resume admission", async () => {
    const f = fixture();
    const acquire = vi.spyOn(f.services.checkpoints, "acquire");
    const terminalSaved = Promise.withResolvers<void>();
    const save = f.services.checkpoints.save.bind(f.services.checkpoints);
    vi.spyOn(f.services.checkpoints, "save").mockImplementation(async (...args) => {
      const result = await save(...args);
      if (result.status === "saved" && args[2].status === "completed") terminalSaved.resolve();
      return result;
    });
    const releasing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.hooks.beforeRelease = async () => {
      releasing.resolve();
      await release.promise;
    };
    const app = createAgentApplication(f.services);
    const agent = await app.agents.create(creation());
    const handle = await agent.run(activation());
    let next: AgentRunHandle | undefined;
    try {
      const observer = handle.events[Symbol.asyncIterator]();
      await observer.return?.();
      let settled = false;
      void handle.completed.then(() => {
        settled = true;
      });
      await Promise.all([terminalSaved.promise, releasing.promise]);
      expect(settled).toBe(false);
      expect(f.rows.get(JSON.stringify(checkpointKey("query-run")))?.checkpoint?.status).toBe(
        "completed",
      );
      expect(f.rows.get(JSON.stringify(checkpointKey("query-run")))?.lease).not.toBeNull();
      const acquisitions = acquire.mock.calls.length;
      await expect(agent.run(activation("while-releasing"))).rejects.toMatchObject({
        code: "agent-busy",
      });
      await expect(
        agent.resume({ threadId: "thread", queryId: "query-run", runId: "while-releasing" }),
      ).rejects.toMatchObject({ code: "agent-busy" });
      expect(acquire).toHaveBeenCalledTimes(acquisitions);
      expect(settled).toBe(false);
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect(f.generate.mock.calls[0][1].aborted).toBe(false);
      expect((await f.history.read("thread")).messages.at(-1)).toEqual(response.message);
      release.resolve();
      expect((await handle.completed).status).toBe("completed");
      expect(f.rows.get(JSON.stringify(checkpointKey("query-run")))?.lease).toBeNull();
      next = await agent.run(activation("after-release"));
      expect((await next.completed).status).toBe("completed");
      expect(acquire).toHaveBeenCalledTimes(acquisitions + 1);
      expect(f.generate).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await Promise.allSettled([handle.completed, ...(next ? [next.completed] : [])]);
      await app.close();
    }
  });

  it("dispose interrupts rather than user-cancels, draining execution before owned resources", async () => {
    const f = fixture();
    const modelEntered = Promise.withResolvers<void>();
    const modelStopped = Promise.withResolvers<void>();
    let modelSignal: AbortSignal | undefined;
    f.generate.mockImplementation(async (_request, signal) => {
      modelSignal = signal;
      modelEntered.resolve();
      await modelStopped.promise;
      signal.throwIfAborted();
      return snapshot(response);
    });
    const pluginDisposed = vi.fn(async () => {});
    const app = createAgentApplication(f.services);
    onTestFinished(() => app.close());
    const agent = await app.agents.create(
      creation({
        plugins: [
          {
            id: "plugin",
            version: "1",
            setup({ scope }) {
              scope.own({ dispose: pluginDisposed });
            },
          },
        ],
      }),
    );
    const handle = await agent.run(activation());
    await modelEntered.promise;
    const disposal = agent.dispose();
    expect(agent.dispose()).toBe(disposal);
    expect(modelSignal?.aborted).toBe(true);
    expect(f.bindingDisposed).not.toHaveBeenCalled();
    expect(pluginDisposed).not.toHaveBeenCalled();
    await expect(agent.run(activation("after-close"))).rejects.toMatchObject({
      code: "agent-closed",
    });
    modelStopped.resolve();
    expect((await handle.completed).status).toBe("interrupted");
    await disposal;
    expect(f.rows.get(JSON.stringify(checkpointKey("query-run")))?.checkpoint?.status).toBe(
      "interrupted",
    );
    expect(f.bindingDisposed).toHaveBeenCalledTimes(1);
    expect(pluginDisposed).toHaveBeenCalledTimes(1);
  });

  it("handle cancellation is user cancellation and does not dispose the Agent binding", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    f.generate.mockImplementation(async (_request, signal) => {
      const aborted = Promise.withResolvers<ModelResponse>();
      signal.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
      entered.resolve();
      return aborted.promise;
    });
    const app = createAgentApplication(f.services);
    onTestFinished(() => app.close());
    const agent = await app.agents.create(creation());
    const handle = await agent.run(activation());
    await entered.promise;
    handle.cancel("stop");
    expect((await handle.completed).status).toBe("cancelled");
    expect(f.bindingDisposed).not.toHaveBeenCalled();
    await agent.dispose();
    expect(f.bindingDisposed).toHaveBeenCalledTimes(1);
  });
});

function controlledObservationModel() {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const state: { signal?: AbortSignal } = {};
  const stream: ModelClient["stream"] = async function* (_request, signal) {
    state.signal = signal;
    entered.resolve();
    yield { type: "content-delta", index: 0, delta: { type: "text", text: "temporary:first" } };
    await finish.promise;
    signal.throwIfAborted();
    yield { type: "content-delta", index: 0, delta: { type: "text", text: "temporary:second" } };
    yield { type: "completed", response: snapshot(response) };
  };
  return { entered, finish, state, stream };
}

function sqliteObservationFixture(stream: ModelClient["stream"]) {
  const f = fixture();
  const directory = mkdtempSync(join(tmpdir(), "general-agent-observation-"));
  const stores = createSqliteAgentStores(join(directory, "sessions.sqlite"));
  const app = createAgentApplication({
    ...f.services,
    history: stores.history,
    checkpoints: stores.checkpoints,
  });
  f.bind.mockResolvedValue({
    ...f.binding,
    client: {
      ...f.binding.client,
      capabilities: { ...f.binding.client.capabilities, streaming: true },
      stream,
    },
  });
  onTestFinished(async () => {
    try {
      await app.close();
    } finally {
      await stores.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return { ...f, app, stores };
}

describe("public runtime observation channel with SQLite", () => {
  it("E1-3 returns after run.started and a delta without cancelling, then ignores the old cancel", async () => {
    const first = controlledObservationModel();
    const second = controlledObservationModel();
    const f = sqliteObservationFixture((request, signal, context) =>
      (context?.identity.runId === "run" ? first : second).stream(request, signal, context),
    );
    const agent = await f.app.agents.create(creation());
    const handle = await agent.run(activation());
    const iterator = handle.events[Symbol.asyncIterator]();
    let next: AgentRunHandle | undefined;
    try {
      const observed: RuntimeEvent[] = [];
      for (;;) {
        const event = await iterator.next();
        if (event.done) throw new Error("Expected a delta before this Run settles.");
        observed.push(event.value);
        expect(event.value.identity).toEqual(handle.identity);
        if (event.value.type === "model.delta") break;
      }
      expect(observed[0].type).toBe("run.started");
      expect(observed.findIndex((event) => event.type === "step.started")).toBeLessThan(
        observed.findIndex((event) => event.type === "model.delta"),
      );
      expect(observed.at(-1)).toMatchObject({
        delta: { type: "text", text: "temporary:first" },
      });
      expect(await iterator.return?.()).toEqual({ done: true, value: undefined });
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
      expect(() => handle.events[Symbol.asyncIterator]()).toThrow(
        expect.objectContaining({ code: "event-stream-consumed" }),
      );
      expect(first.state.signal?.aborted).toBe(false);
      first.finish.resolve();
      expect((await handle.completed).status).toBe("completed");
      const history = await f.stores.history.read("thread");
      expect(history.messages).toEqual([...activation().input, response.message]);
      const acquired = await f.stores.checkpoints.acquire(checkpointKey("query-run"), "inspector");
      if (acquired.status !== "acquired") throw new Error("Expected the abandoned Run released.");
      try {
        expect(acquired.checkpoint).toMatchObject({
          status: "completed",
          lastRunId: "run",
          committed: { messages: history.messages, historyRevision: history.revision },
        });
      } finally {
        await f.stores.checkpoints.release(acquired.lease);
      }
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
      expect(() => handle.events[Symbol.asyncIterator]()).toThrow(
        expect.objectContaining({ code: "event-stream-consumed" }),
      );
      next = await agent.run(activation("next"));
      await second.entered.promise;
      handle.cancel("old abandoned observer must not cancel the new Run");
      expect(second.state.signal?.aborted).toBe(false);
      second.finish.resolve();
      expect((await next.completed).status).toBe("completed");
      expect((await f.stores.history.read("thread")).messages).toEqual([
        ...history.messages,
        ...activation("next").input,
        response.message,
      ]);
      expect(f.generate).not.toHaveBeenCalled();
    } finally {
      first.finish.resolve();
      second.finish.resolve();
      await Promise.allSettled([handle.completed, ...(next ? [next.completed] : [])]);
    }
  });

  it("E1-5 rejects only an empty-queue pending-next collision and never reopens a claimed stream", async () => {
    const model = controlledObservationModel();
    const f = sqliteObservationFixture(model.stream);
    const agent = await f.app.agents.create(creation());
    const handle = await agent.run(activation());
    const iterator = handle.events[Symbol.asyncIterator]();
    try {
      await model.entered.promise;
      expect(() => handle.events[Symbol.asyncIterator]()).toThrow(
        expect.objectContaining({ code: "event-stream-consumed" }),
      );
      // 已有队列时，两个未 await 的 next 各自立即取走一个事件，不是 busy。
      const started = iterator.next();
      const inputCommitted = iterator.next();
      const events: RuntimeEvent[] = [];
      for (const next of [await started, await inputCommitted]) {
        if (next.done) throw new Error("Expected the queued prefix before the model gate.");
        events.push(next.value);
      }
      while (events.at(-1)?.type !== "model.delta") {
        const next = await iterator.next();
        if (next.done) throw new Error("Expected a delta before the model gate.");
        events.push(next.value);
      }
      expect(events[0].type).toBe("run.started");
      expect(events.at(-1)).toMatchObject({
        delta: { type: "text", text: "temporary:first" },
      });
      // 首个 delta 已被取走；模型自己的门闩阻止任何后续事件，队列确定为空。
      const pending = iterator.next();
      let pendingSettled = false;
      void pending.then(() => {
        pendingSettled = true;
      });
      await expect(iterator.next()).rejects.toMatchObject({ code: "event-stream-busy" });
      expect(pendingSettled).toBe(false);
      expect(() => handle.events[Symbol.asyncIterator]()).toThrow(
        expect.objectContaining({ code: "event-stream-consumed" }),
      );
      model.finish.resolve();
      const resumed = await pending;
      expect(resumed.done).toBe(false);
      if (resumed.done) throw new Error("The first pending next must receive the next delta.");
      expect(resumed.value).toMatchObject({
        type: "model.delta",
        delta: { type: "text", text: "temporary:second" },
      });
      events.push(resumed.value);
      expect((await handle.completed).status).toBe("completed");
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        events.push(next.value);
      }
      const committed = events.findIndex(
        (event) => event.type === "step.committed" && event.step === 1,
      );
      expect(committed).toBeGreaterThan(events.indexOf(resumed.value));
      expect(events.findIndex((event) => event.type === "run.completed")).toBeGreaterThan(
        committed,
      );
      for (const event of events) expect(event.identity).toEqual(handle.identity);
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
      expect(() => handle.events[Symbol.asyncIterator]()).toThrow(
        expect.objectContaining({ code: "event-stream-consumed" }),
      );
      expect(await iterator.return?.()).toEqual({ done: true, value: undefined });
      expect(() => handle.events[Symbol.asyncIterator]()).toThrow(
        expect.objectContaining({ code: "event-stream-consumed" }),
      );
      expect((await f.stores.history.read("thread")).messages).toEqual([
        ...activation().input,
        response.message,
      ]);
    } finally {
      model.finish.resolve();
      await Promise.allSettled([handle.completed]);
    }
  });
});
