import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentRunInput } from "../src/agent/agent-contract";
import type { AgentCreationOptions, AgentServices } from "../src/agent/agent-factory";
import { createAgentApplication } from "../src/agent/application/agent-application";
import { createDefaultAgentFactory } from "../src/agent/application/default-agent-factory";
import type {
  ModelBinding,
  ModelClient,
  ModelRequest,
  ModelResponse,
} from "../src/agent/model/model-contract";
import { sameValue, snapshot } from "../src/agent/protocol-utils";
import { RuntimeEventStream } from "../src/agent/runtime/event-stream";
import type { CheckpointKey, CheckpointLease } from "../src/agent/session/checkpoint-contract";
import type { AgentCheckpoint, SessionHistory } from "../src/agent/session/session-contract";

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
    const agent = await createDefaultAgentFactory(services).create(
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
    const agent = await createDefaultAgentFactory(f.services).create(creation());
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
    const agent = await createDefaultAgentFactory(f.services).create(creation());
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
    const agent = await createDefaultAgentFactory(f.services).create(
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
    const agent = await createDefaultAgentFactory(f.services).create(creation());
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
