import type { AgentRunInput } from "@agent-harness/core/agent-contract";
import type { AgentCreationOptions, AgentServices } from "@agent-harness/core/agent-factory";
import { createAgentApplication } from "@agent-harness/core/application/agent-application";
import type {
  AgentPlugin,
  PluginContext,
  PluginScope,
} from "@agent-harness/core/extensions/plugin-contract";
import type {
  ModelBinding,
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
import type { ToolResult } from "@agent-harness/core/tools/tool-contract";
import { describe, expect, it, type Mock, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { RuntimeEventStream } from "../packages/harness/dist/agent/runtime/event-stream.js";

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
      if (!row) {
        row = { checkpoint: null, revision: 0, generation: 0, lease: null };
        rows.set(name, row);
      }
      if (options?.replace && !sameValue(options.replace, row.lease)) return { status: "stale" };
      if (!options?.replace && row.lease) return { status: "busy", lease: snapshot(row.lease) };
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
  it("settles waiting, detaches its signal, and admits a separately resumed activation", async () => {
    const f = fixture();
    const interaction = {
      id: "approve",
      owner: "host",
      payload: { type: "approval", version: 1, data: { action: "read" } },
    };
    const execute = vi.fn(async () => ({
      status: "succeeded" as const,
      output: { done: true },
      effects: "none" as const,
    }));
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
    onTestFinished(() => app.close());
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
    expect((await waiting.completed).status).toBe("waiting");
    expect(execute).not.toHaveBeenCalled();
    expect(f.bindingDisposed).not.toHaveBeenCalled();
    expect(f.rows.get(JSON.stringify(checkpointKey("query-run")))?.lease).toBeNull();
    signal.abort("old activation is no longer observed");
    const pending = agent.resume({
      threadId: "thread",
      queryId: "query-run",
      runId: "resumed",
      response: { interactionId: "approve", type: "answer", value: true },
    });
    await expect(agent.run(activation("concurrent"))).rejects.toMatchObject({ code: "agent-busy" });
    const resumed = await pending;
    expect(resumed.identity.runId).toBe("resumed");
    expect((await resumed.completed).status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.generate.mock.calls.at(-1)?.[1].aborted).toBe(false);
    await agent.dispose();
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

  it("event unsubscription does not cancel work and completion waits for lease cleanup", async () => {
    const f = fixture();
    const releasing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.hooks.beforeRelease = async () => {
      releasing.resolve();
      await release.promise;
    };
    const app = createAgentApplication(f.services);
    onTestFinished(() => app.close());
    const agent = await app.agents.create(creation());
    const handle = await agent.run(activation());
    const observer = handle.events[Symbol.asyncIterator]();
    await observer.return?.();
    let settled = false;
    void handle.completed.then(() => {
      settled = true;
    });
    await releasing.promise;
    expect(settled).toBe(false);
    expect(f.generate.mock.calls[0][1].aborted).toBe(false);
    expect((await f.history.read("thread")).messages.at(-1)).toEqual(response.message);
    release.resolve();
    expect((await handle.completed).status).toBe("completed");
    expect(f.rows.get(JSON.stringify(checkpointKey("query-run")))?.lease).toBeNull();
    await agent.dispose();
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

describe("runtime observation channel", () => {
  it("keeps buffered facts until observed, closes pending reads, and rejects a second consumer", async () => {
    const events = new RuntimeEventStream();
    const identity = { agentId: "agent", threadId: "thread", queryId: "query", runId: "run" };
    const event = { kind: "fact" as const, type: "run.started" as const, identity };
    events.emit(event);
    const iterator = events[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: event });
    const pending = iterator.next();
    events.close();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(() => events[Symbol.asyncIterator]()).toThrow("只允许一个消费者");
  });
});
