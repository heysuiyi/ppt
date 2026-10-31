import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentServices } from "../src/agent/agent-factory";
import type { AgentPlugin, PluginContext } from "../src/agent/extensions/plugin-contract";
import type {
  ModelBinding,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelSelection,
} from "../src/agent/model/model-contract";
import { AgentError, asProtocolError } from "../src/agent/protocol-errors";
import { sameValue, snapshot } from "../src/agent/protocol-values";
import type { CheckpointKey, CheckpointStore } from "../src/agent/session/checkpoint-contract";
import type { ToolAuthorizationPolicy } from "../src/agent/tools/tool-contract";
import {
  createSessionHost,
  type SessionBindingPort,
  type SessionHost,
  type SessionHostOptions,
} from "../src/agent-host/session-host";
import { createSqliteAgentStores } from "../src/main/agent-host/sqlite-agent-stores";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function answer(text: string): ModelResponse {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    finishReason: "stop",
  };
}

function creditCall(): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: [
        { type: "tool-call", callId: "credit-1", name: "ledger.credit", input: { amount: 7 } },
      ],
    },
    finishReason: "tool-calls",
  };
}

function activation(queryId = "query", runId = "run") {
  return {
    queryId,
    runId,
    input: [{ role: "user" as const, content: [{ type: "text" as const, text: "Credit seven." }] }],
  };
}

function checkpointKey(queryId = "query"): CheckpointKey {
  return { agentId: "custom-agent", threadId: "fixed-thread", queryId };
}

/** 确定性绑定端口实际比较固定配置，不使用空 ensure 绕过创建约束。 */
class ComparingSessionBinding implements SessionBindingPort {
  readonly entered = Promise.withResolvers<void>();
  readonly dispose = vi.fn(async () => {});
  beforeEnsure?: () => Promise<void>;
  stored: unknown;

  constructor(private readonly configuration: () => unknown) {}

  async ensure(): Promise<void> {
    const expected = snapshot(this.configuration());
    this.entered.resolve();
    await this.beforeEnsure?.();
    if (this.stored === undefined) this.stored = expected;
    else if (!sameValue(this.stored, expected))
      throw new AgentError("FIXTURE_BINDING_MISMATCH", "Session binding differs.");
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "general-agent-session-host-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const stores = createSqliteAgentStores(join(directory, "sessions.sqlite"));
  cleanup.push(() => stores.dispose());
  const borrowedDisposed = vi.fn(async () => {});
  const modelBindingDisposed = vi.fn(async () => {});
  const generate = vi.fn(
    async (_request: ModelRequest, _signal: AbortSignal): Promise<ModelResponse> =>
      answer("plain completion"),
  );
  const bind = vi.fn(
    async (selection: ModelSelection, _signal: AbortSignal): Promise<ModelBinding> => {
      const client: ModelClient = {
        selection: snapshot(selection),
        capabilities: { streaming: false, toolCalls: true, images: false, reasoning: false },
        generate,
        async *stream(request, signal) {
          yield { type: "completed", response: await generate(request, signal) };
        },
      };
      return { client, dispose: modelBindingDisposed };
    },
  );
  const authorizeTool = vi.fn<ToolAuthorizationPolicy>(() => ({ type: "allow" }));
  const models = { create: bind, dispose: borrowedDisposed };
  const history = { ...stores.history, dispose: borrowedDisposed };
  const checkpoints = { ...stores.checkpoints, dispose: borrowedDisposed };
  const services: Mutable<AgentServices> = { models, history, checkpoints, authorizeTool };
  const agent = {
    agentId: "custom-agent",
    definition: {
      id: "custom-definition",
      version: "3",
      instructions: "Use only chosen capabilities.",
    },
    model: { providerId: "deterministic", modelId: "selected-model", reasoningEffort: "balanced" },
    maxSteps: 3,
    plugins: [] as AgentPlugin[],
    signal: undefined as AbortSignal | undefined,
  };
  const binding = new ComparingSessionBinding(() => ({
    threadId: options.threadId,
    agentId: options.agent.agentId,
    definition: options.agent.definition,
    model: options.agent.model,
    maxSteps: options.agent.maxSteps,
    plugins: options.agent.plugins.map(({ id, version }) => ({ id, version })),
  }));
  const options: Mutable<SessionHostOptions> = {
    services,
    agent,
    threadId: "fixed-thread",
    binding,
  };
  return {
    options,
    agent,
    services,
    stores,
    history,
    checkpoints,
    models,
    binding,
    generate,
    bind,
    authorizeTool,
    borrowedDisposed,
    modelBindingDisposed,
  };
}

async function ownHost(options: SessionHostOptions): Promise<SessionHost> {
  const host = await createSessionHost(options);
  cleanup.push(() => host.close());
  return host;
}

function ledger() {
  const state = { balance: 0 };
  const disposed = vi.fn(async () => {});
  const setup = vi.fn(({ tools, scope }: PluginContext) => {
    scope.own({ dispose: disposed });
    tools.register({
      name: "ledger.credit",
      owner: "test-ledger",
      version: "1",
      description: "Credit a deterministic account",
      mode: "immediate",
      inputSchema: z.object({ amount: z.number().int().positive() }),
      outputSchema: z.object({ balance: z.number().int() }),
      async execute({ amount }) {
        state.balance += amount;
        return { status: "succeeded", output: { balance: state.balance }, effects: "applied" };
      },
      toModelContent(result) {
        return [
          {
            type: "text",
            text:
              result.status === "succeeded"
                ? `balance:${result.output.balance}`
                : result.error.code,
          },
        ];
      },
    });
  });
  const plugin: AgentPlugin = { id: "test-ledger", version: "1", setup };
  return { state, setup, plugin, disposed };
}

function approvalPolicy(): ToolAuthorizationPolicy {
  return (call, context) => ({
    type: "approval",
    interaction: {
      id: `approve:${context.identity.queryId}:${call.callId}`,
      owner: "host-policy",
      payload: { type: "test.ledger-approval", version: 1, data: { amount: call.input.amount } },
    },
  });
}

function consumeCredit(request: ModelRequest): ModelResponse {
  const result = request.messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content)
    .at(-1);
  if (!result) return creditCall();
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  return answer(`Observed ${text}`);
}

async function inspectCheckpoint(f: { readonly checkpoints: CheckpointStore }, queryId = "query") {
  const acquired = await f.checkpoints.acquire(checkpointKey(queryId), "inspector");
  if (acquired.status !== "acquired") throw new Error("Expected a released writer lease.");
  await f.checkpoints.release(acquired.lease);
  return acquired.checkpoint;
}

describe("generic session host configuration and authority", () => {
  it("runs custom no-plugin dialogue and cannot execute an uninstalled capability", async () => {
    const f = fixture();
    const host = await ownHost(f.options);
    const plainInput = { ...activation("plain", "plain-run"), threadId: "foreign-thread" };
    const plain = await host.run(plainInput);
    expect(await plain.completed).toMatchObject({
      status: "completed",
      identity: { threadId: "fixed-thread", queryId: "plain", runId: "plain-run" },
      output: [answer("plain completion").message],
    });
    expect(f.bind.mock.calls[0][0]).toEqual(f.agent.model);
    expect(f.generate.mock.calls[0][0].tools ?? []).toEqual([]);
    expect(f.generate.mock.calls[0][0].messages).toContainEqual({
      role: "system",
      content: [{ type: "text", text: f.agent.definition.instructions }],
    });
    expect((await f.history.read("foreign-thread")).messages).toEqual([]);
    expect(await inspectCheckpoint(f, "plain")).toMatchObject({
      definition: { id: "custom-definition", version: "3" },
      model: f.agent.model,
      maxSteps: 3,
      plugins: [],
      status: "completed",
    });

    f.generate.mockImplementation(async (request) => consumeCredit(request));
    const missing = await host.run(activation("missing", "missing-run"));
    expect((await missing.completed).status).toBe("completed");
    expect((await f.history.read("fixed-thread")).messages).toEqual(
      expect.arrayContaining([
        {
          role: "tool",
          content: [
            expect.objectContaining({ type: "tool-result", callId: "credit-1", isError: true }),
          ],
        },
      ]),
    );
    expect(f.authorizeTool).not.toHaveBeenCalled();
    expect(f.generate.mock.calls.every(([request]) => !request.tools?.length)).toBe(true);
  });

  it.each(["", "   ", null])("rejects invalid fixed thread %j before binding", async (threadId) => {
    const f = fixture();
    await expect(
      createSessionHost({
        ...f.options,
        threadId,
      } as unknown as SessionHostOptions),
    ).rejects.toMatchObject({ code: "HOST_OPTIONS_INVALID" });
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.binding.stored).toBeUndefined();
  });

  it.each(["binding", "authorizeTool", "models", "history", "checkpoints"] as const)(
    "rejects missing %s before plugin or model acquisition",
    async (missing) => {
      const f = fixture();
      const capability = ledger();
      if (missing !== "authorizeTool") f.agent.plugins.push(capability.plugin);
      const options =
        missing === "binding"
          ? { ...f.options, binding: undefined }
          : { ...f.options, services: { ...f.services, [missing]: undefined } };
      await expect(
        createSessionHost(options as unknown as SessionHostOptions),
      ).rejects.toMatchObject({
        code: "HOST_OPTIONS_INVALID",
      });
      expect(capability.setup).not.toHaveBeenCalled();
      expect(f.bind).not.toHaveBeenCalled();
      expect(f.borrowedDisposed).not.toHaveBeenCalled();
    },
  );

  it("keeps binding unpublished and snapshots all configuration before its await", async () => {
    const f = fixture();
    const capability = ledger();
    const unexpected = ledger();
    unexpected.plugin = { ...unexpected.plugin, id: "unexpected-ledger" };
    f.agent.plugins.push(capability.plugin);
    f.agent.maxSteps = 2;
    f.services.authorizeTool = approvalPolicy();
    f.generate.mockImplementation(async (request) => consumeCredit(request));
    const gate = Promise.withResolvers<void>();
    f.binding.beforeEnsure = () => gate.promise;
    let published = false;
    const pending = createSessionHost(f.options).then((host) => {
      published = true;
      cleanup.push(() => host.close());
      return host;
    });
    await f.binding.entered.promise;
    expect(published).toBe(false);
    expect(capability.setup).not.toHaveBeenCalled();
    expect(f.bind).not.toHaveBeenCalled();

    f.agent.definition.id = "drifted-definition";
    f.agent.definition.instructions = "Drifted instructions";
    f.agent.model.modelId = "drifted-model";
    f.agent.model.reasoningEffort = "different";
    f.agent.agentId = "drifted-agent";
    f.agent.maxSteps = 1;
    f.agent.signal = AbortSignal.abort("wrong creation signal");
    f.agent.plugins.splice(0, 1, unexpected.plugin);
    f.options.threadId = "drifted-thread";
    f.options.agent = { ...f.agent, plugins: [] };
    f.options.binding = {
      async ensure() {
        throw new Error("Wrong binding");
      },
    };
    f.services.models = {
      async create() {
        throw new Error("Wrong model factory");
      },
    };
    f.services.history = {
      async read() {
        throw new Error("Wrong history");
      },
      async append() {
        throw new Error("Wrong history");
      },
    };
    f.services.checkpoints = {
      async findUnfinished() {
        throw new Error("Wrong checkpoints");
      },
      async acquire() {
        throw new Error("Wrong checkpoints");
      },
      async save() {
        throw new Error("Wrong checkpoints");
      },
      async release() {
        throw new Error("Wrong checkpoints");
      },
    };
    f.services.authorizeTool = () => ({ type: "allow" });
    f.options.services = { ...f.services };
    gate.resolve();
    const host = await pending;
    const waiting = await (await host.run(activation())).completed;
    expect(waiting.status).toBe("waiting");
    expect(capability.state.balance).toBe(0);
    expect(unexpected.setup).not.toHaveBeenCalled();
    expect(f.bind.mock.calls[0][0]).toEqual({
      providerId: "deterministic",
      modelId: "selected-model",
      reasoningEffort: "balanced",
    });
    expect(f.generate.mock.calls[0][0].messages).toContainEqual({
      role: "system",
      content: [{ type: "text", text: "Use only chosen capabilities." }],
    });
    expect(await inspectCheckpoint(f)).toMatchObject({
      agentId: "custom-agent",
      threadId: "fixed-thread",
      maxSteps: 2,
      definition: { id: "custom-definition", version: "3" },
      plugins: [{ id: "test-ledger", version: "1" }],
    });
    if (waiting.status !== "waiting") throw new Error("Expected host approval.");
    const resumed = await host.resume({
      queryId: "query",
      runId: "approved",
      response: { type: "answer", interactionId: waiting.interaction.id, value: true },
    });
    expect((await resumed.completed).status).toBe("completed");
    expect(capability.state.balance).toBe(7);
  });

  it("rejects a binding mismatch without acquiring resources and leaves borrowed stores usable", async () => {
    const f = fixture();
    const capability = ledger();
    f.agent.plugins.push(capability.plugin);
    const gate = Promise.withResolvers<void>();
    f.binding.beforeEnsure = () => gate.promise;
    f.binding.stored = { incompatible: true };
    const pending = createSessionHost(f.options);
    const rejected = expect(pending).rejects.toMatchObject({ code: "FIXTURE_BINDING_MISMATCH" });
    await f.binding.entered.promise;
    expect(capability.setup).not.toHaveBeenCalled();
    expect(f.bind).not.toHaveBeenCalled();
    gate.resolve();
    await rejected;
    expect(capability.setup).not.toHaveBeenCalled();
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.binding.dispose).not.toHaveBeenCalled();
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    expect((await f.history.read("fixed-thread")).revision).toBe(0);
    expect(await f.checkpoints.findUnfinished("custom-agent", "fixed-thread")).toBeNull();
  });
});

describe("generic session host approval and recovery", () => {
  it("persists waiting, closes without cancellation, and consumes only the matching answer in a new Run", async () => {
    const f = fixture();
    const capability = ledger();
    f.agent.plugins.push(capability.plugin);
    f.services.authorizeTool = approvalPolicy();
    f.generate.mockImplementation(async (request) => consumeCredit(request));
    const first = await ownHost(f.options);
    const runtimeInput = { ...activation(), threadId: "foreign-thread" };
    const waiting = await (await first.run(runtimeInput)).completed;
    if (waiting.status !== "waiting") throw new Error("Expected host approval.");
    expect(capability.state.balance).toBe(0);
    expect((await inspectCheckpoint(f))?.status).toBe("waiting");
    await first.close();
    expect((await inspectCheckpoint(f))?.status).toBe("waiting");
    expect(f.borrowedDisposed).not.toHaveBeenCalled();

    const resumedHost = await ownHost(f.options);
    const reused = await resumedHost.resume({ queryId: "query", runId: "run" });
    await expect(reused.completed).rejects.toMatchObject({ code: "RUN_ID_REUSED" });
    const stale = await resumedHost.resume({
      queryId: "query",
      runId: "wrong-answer",
      response: { type: "answer", interactionId: "not-pending", value: true },
    });
    await expect(stale.completed).rejects.toMatchObject({ code: "STALE_INTERACTION" });
    expect(capability.state.balance).toBe(0);
    const runtimeResume = {
      queryId: "query",
      runId: "approved",
      threadId: "foreign-thread",
      response: { type: "answer" as const, interactionId: waiting.interaction.id, value: true },
    };
    const resumed = await resumedHost.resume(runtimeResume);
    expect(await resumed.completed).toMatchObject({
      status: "completed",
      identity: { queryId: "query", runId: "approved", threadId: "fixed-thread" },
      output: expect.arrayContaining([answer("Observed balance:7").message]),
    });
    expect(capability.state.balance).toBe(7);
    expect((await f.history.read("foreign-thread")).messages).toEqual([]);
    expect((await inspectCheckpoint(f))?.status).toBe("completed");
    const duplicate = await resumedHost.resume({
      queryId: "query",
      runId: "duplicate",
      response: { type: "answer", interactionId: waiting.interaction.id, value: true },
    });
    await expect(duplicate.completed).rejects.toMatchObject({ code: "QUERY_TERMINAL" });
    expect(capability.state.balance).toBe(7);
  });

  it.each(["deny", "reject", "cancel"] as const)(
    "does not credit the ledger after %s",
    async (decision) => {
      const f = fixture();
      const capability = ledger();
      f.agent.plugins.push(capability.plugin);
      f.services.authorizeTool =
        decision === "deny"
          ? () => ({ type: "deny", reason: "Ledger access denied." })
          : approvalPolicy();
      f.generate.mockImplementation(async (request) => consumeCredit(request));
      const host = await ownHost(f.options);
      let result = await (await host.run(activation())).completed;
      if (decision !== "deny") {
        if (result.status !== "waiting") throw new Error("Expected host approval.");
        result = await (
          await host.resume({
            queryId: "query",
            runId: "declined",
            response: { type: decision, interactionId: result.interaction.id },
          })
        ).completed;
      }
      expect(result.status).toBe(decision === "cancel" ? "cancelled" : "completed");
      expect(capability.state.balance).toBe(0);
      const history = await f.history.read("fixed-thread");
      expect(JSON.stringify(history.messages)).not.toContain("balance:7");
    },
  );

  it("does not forward a runtime takeover or alternate thread to steal an active writer", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.generate.mockImplementation(async (_request, signal) => {
      entered.resolve();
      await release.promise;
      signal.throwIfAborted();
      return answer("writer completed");
    });
    const first = await ownHost(f.options);
    const active = await first.run(activation());
    await entered.promise;
    const observed = await f.checkpoints.acquire(checkpointKey(), "observer");
    if (observed.status !== "busy") throw new Error("Expected an active writer.");
    const second = await ownHost(f.options);
    cleanup.push(() => release.resolve());
    const runtimeResume = {
      queryId: "query",
      runId: "intruder",
      threadId: "foreign-thread",
      takeover: observed.lease,
    };
    const attempted = await second.resume(runtimeResume);
    await expect(attempted.completed).rejects.toMatchObject({ code: "WRITER_BUSY" });
    expect(await f.checkpoints.acquire(checkpointKey(), "observer-again")).toEqual(observed);
    release.resolve();
    expect((await active.completed).status).toBe("completed");
    expect((await inspectCheckpoint(f))?.lastRunId).toBe("run");
    expect((await f.history.read("foreign-thread")).messages).toEqual([]);
  });
});

describe("generic session host ownership and cancellation", () => {
  it("reclaims installed plugins when the model factory fails and preserves the original error", async () => {
    const f = fixture();
    const capability = ledger();
    f.agent.plugins.push(capability.plugin);
    const failure = new Error("model binding failed");
    f.bind.mockRejectedValue(failure);
    await expect(createSessionHost(f.options)).rejects.toBe(failure);
    expect(capability.disposed).toHaveBeenCalledTimes(1);
    expect(f.modelBindingDisposed).not.toHaveBeenCalled();
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    expect(f.binding.dispose).not.toHaveBeenCalled();
    expect((await f.history.read("fixed-thread")).revision).toBe(0);
  });

  it("forwards user cancellation without closing the host or its borrowed services", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    f.generate.mockImplementation(async (_request, signal) => {
      const stopped = Promise.withResolvers<ModelResponse>();
      signal.addEventListener("abort", () => stopped.reject(signal.reason), { once: true });
      entered.resolve();
      return stopped.promise;
    });
    const host = await ownHost(f.options);
    const controller = new AbortController();
    const active = await host.run({ ...activation(), signal: controller.signal });
    await entered.promise;
    controller.abort("user cancelled");
    expect((await active.completed).status).toBe("cancelled");
    expect((await inspectCheckpoint(f))?.status).toBe("cancelled");
    expect(f.modelBindingDisposed).not.toHaveBeenCalled();
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    f.generate.mockResolvedValue(answer("still available"));
    const next = await host.run(activation("next", "next-run"));
    expect((await next.completed).status).toBe("completed");
  });

  it.each(["before", "during"] as const)(
    "honors creation cancellation %s ensure without installing capabilities",
    async (when) => {
      const f = fixture();
      const capability = ledger();
      f.agent.plugins.push(capability.plugin);
      const controller = new AbortController();
      f.agent.signal = controller.signal;
      const gate = Promise.withResolvers<void>();
      f.binding.beforeEnsure = () => gate.promise;
      if (when === "before")
        controller.abort(new AgentError("TEST_CANCELLED", "Cancelled creation."));
      const pending = createSessionHost(f.options);
      const rejected = expect(pending).rejects.toMatchObject({ code: "TEST_CANCELLED" });
      if (when === "during") {
        await f.binding.entered.promise;
        controller.abort(new AgentError("TEST_CANCELLED", "Cancelled creation."));
      }
      gate.resolve();
      await rejected;
      expect(capability.setup).not.toHaveBeenCalled();
      expect(f.bind).not.toHaveBeenCalled();
      expect(f.binding.dispose).not.toHaveBeenCalled();
      expect(f.borrowedDisposed).not.toHaveBeenCalled();
    },
  );

  it("reclaims a late model binding and installed plugin when creation is cancelled", async () => {
    const f = fixture();
    const capability = ledger();
    f.agent.plugins.push(capability.plugin);
    const controller = new AbortController();
    f.agent.signal = controller.signal;
    const modelEntered = Promise.withResolvers<void>();
    const modelReady = Promise.withResolvers<void>();
    const originalBind = f.bind.getMockImplementation()!;
    f.bind.mockImplementation(async (selection, signal) => {
      const binding = await originalBind(selection, signal);
      modelEntered.resolve();
      await modelReady.promise;
      return binding;
    });
    const pending = createSessionHost(f.options);
    const rejected = expect(pending).rejects.toBeDefined();
    await modelEntered.promise;
    controller.abort("cancel creation");
    modelReady.resolve();
    await rejected;
    expect(capability.disposed).toHaveBeenCalledTimes(1);
    expect(f.modelBindingDisposed).toHaveBeenCalledTimes(1);
    expect(f.binding.dispose).not.toHaveBeenCalled();
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    expect((await f.history.read("fixed-thread")).revision).toBe(0);
  });

  it("preserves setup and rollback failures without exposing private exception data in protocol projection", async () => {
    const f = fixture();
    const setupError = new Error("private provider credential");
    const cleanupError = new Error("private disposal detail");
    const disposed = vi.fn(async () => {
      throw cleanupError;
    });
    f.agent.plugins.push({
      id: "broken",
      version: "1",
      setup({ scope }) {
        scope.own({ dispose: disposed });
        throw setupError;
      },
    });
    const failure = await createSessionHost(f.options).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const retainedErrors = (error: unknown): unknown[] =>
      error instanceof AggregateError ? error.errors.flatMap(retainedErrors) : [error];
    expect(retainedErrors(failure)).toContain(setupError);
    expect(retainedErrors(failure)).toContain(cleanupError);
    expect(asProtocolError(failure)).toEqual({
      code: "EXECUTION_FAILED",
      message: "Agent execution failed",
    });
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    expect(f.binding.dispose).not.toHaveBeenCalled();
    expect((await f.history.read("fixed-thread")).revision).toBe(0);
  });

  it("closes idempotently, synchronously refuses activation, and drains work before owned resources", async () => {
    const f = fixture();
    const capability = ledger();
    f.agent.plugins.push(capability.plugin);
    const entered = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    f.generate.mockImplementation(async (_request, signal) => {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      entered.resolve();
      await stopped.promise;
      signal.throwIfAborted();
      return answer("not committed");
    });
    const host = await ownHost(f.options);
    cleanup.push(() => stopped.resolve());
    const active = await host.run(activation());
    await entered.promise;
    const closing = host.close();
    expect(host.close()).toBe(closing);
    expect(host.dispose()).toBe(closing);
    await expect(host.run(activation("after-close", "after-close"))).rejects.toMatchObject({
      code: "HOST_CLOSED",
    });
    await expect(host.resume({ queryId: "query", runId: "after-close" })).rejects.toMatchObject({
      code: "HOST_CLOSED",
    });
    await aborted.promise;
    expect(f.modelBindingDisposed).not.toHaveBeenCalled();
    expect(capability.disposed).not.toHaveBeenCalled();
    stopped.resolve();
    expect((await active.completed).status).toBe("interrupted");
    await closing;
    expect((await inspectCheckpoint(f))?.status).toBe("interrupted");
    expect(capability.disposed).toHaveBeenCalledTimes(1);
    expect(f.modelBindingDisposed).toHaveBeenCalledTimes(1);
    expect(f.borrowedDisposed).not.toHaveBeenCalled();
    expect(f.binding.dispose).not.toHaveBeenCalled();
    expect((await f.history.read("fixed-thread")).messages).toEqual(activation().input);
  });
});
