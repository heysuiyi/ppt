import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentCreationOptions, AgentServices } from "@agent-harness/core/agent-factory";
import { createAgentApplication } from "@agent-harness/core/application/agent-application";
import type { AgentPlugin } from "@agent-harness/core/extensions/plugin-contract";
import type {
  ModelClientFactory,
  ModelRequest,
  ModelResponse,
  ModelSelection,
} from "@agent-harness/core/model/model-contract";
import type { Disposable } from "@agent-harness/core/protocol-values";
import type { CheckpointStore } from "@agent-harness/core/session/checkpoint-contract";
import type { AgentCheckpoint } from "@agent-harness/core/session/session-contract";
import type { RuntimeEvent } from "@agent-harness/core/session/session-events";
import { createSessionHost } from "@agent-harness/core/session-host";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { HostSessionBinding } from "../cli/host/host-session-binding.js";
import {
  createSqliteAgentStores,
  type SqliteAgentStores,
} from "../cli/host/sqlite-agent-stores.js";

const selection = { providerId: "test", modelId: "reasoning-model" };
const input = (queryId: string, runId: string) => ({
  threadId: "thread",
  queryId,
  runId,
  input: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Write the requested document" }],
    },
  ],
});
const options = (plugins: readonly AgentPlugin[], maxSteps = 4) => ({
  agentId: "agent",
  definition: {
    id: "documents",
    version: "1",
    instructions: "Use registered document capabilities.",
  },
  model: selection,
  maxSteps,
  plugins,
});
const answer = (text: string): ModelResponse => ({
  message: { role: "assistant", content: [{ type: "text", text }] },
  finishReason: "stop",
});
const call = (): ModelResponse => ({
  message: {
    role: "assistant",
    content: [
      { type: "reasoning", text: "Write the document" },
      {
        type: "tool-call",
        callId: "write-1",
        name: "documents.write",
        input: { content: "persistent document" },
      },
    ],
    replayState: {
      providerId: "test",
      modelId: "reasoning-model",
      format: "signed",
      version: 1,
      data: { signature: "retained-by-adapter" },
    },
  },
  finishReason: "tool-calls",
});

function models(
  handler: (request: ModelRequest, signal: AbortSignal) => Promise<ModelResponse> | ModelResponse,
): ModelClientFactory {
  return {
    async create(modelSelection) {
      let disposed = false;
      const generate = async (request: ModelRequest, signal: AbortSignal) => {
        if (disposed) throw new Error("Binding disposed before execution drained");
        signal.throwIfAborted();
        return handler(request, signal);
      };
      return {
        client: {
          selection: modelSelection,
          capabilities: { streaming: false, toolCalls: true, images: false, reasoning: true },
          generate,
          async *stream(request, signal) {
            yield { type: "completed" as const, response: await generate(request, signal) };
          },
        },
        async dispose() {
          disposed = true;
        },
      };
    },
  };
}

function writer(
  path: string,
  counters: { execute: number; resume: number },
  suspend = false,
  toolVersion = "1",
): AgentPlugin {
  return {
    id: "documents",
    version: "1",
    setup(context) {
      const common = {
        name: "documents.write",
        owner: "documents",
        version: toolVersion,
        description: "Write a local document",
        inputSchema: z.object({ content: z.string() }),
        outputSchema: z.object({ bytes: z.number() }),
        toModelContent: () => [{ type: "text" as const, text: "Document written" }],
      };
      if (suspend) {
        context.tools.register({
          ...common,
          mode: "resumable",
          async execute(value, execution) {
            counters.execute += 1;
            return {
              status: "waiting",
              effects: "none",
              interaction: {
                id: `${execution.callId}:confirm`,
                owner: "documents",
                payload: { type: "documents.confirm", version: 1, data: { path } },
              },
              continuation: {
                type: "documents.write",
                version: 1,
                data: { content: value.content },
              },
            };
          },
          async resume(continuation, response) {
            counters.resume += 1;
            if (response.type !== "answer" || response.value !== true)
              return {
                status: "failed",
                error: { code: "DECLINED", message: "Write declined" },
                effects: "none",
              };
            const value = z.object({ content: z.string() }).parse(continuation.data);
            await writeFile(path, value.content, "utf8");
            return {
              status: "succeeded",
              output: { bytes: Buffer.byteLength(value.content) },
              effects: "applied",
            };
          },
        });
      } else {
        context.tools.register({
          ...common,
          mode: "immediate",
          async execute(value) {
            counters.execute += 1;
            await writeFile(path, value.content, "utf8");
            return {
              status: "succeeded",
              output: { bytes: Buffer.byteLength(value.content) },
              effects: "applied",
            };
          },
        });
      }
    },
  };
}

async function fixture(
  body: (directory: string, own: <T extends Disposable>(resource: T) => T) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "general-agent-runtime-"));
  const resources: Disposable[] = [];
  const own = <T extends Disposable>(resource: T): T => {
    resources.push(resource);
    return resource;
  };
  try {
    await body(directory, own);
  } finally {
    try {
      for (const resource of resources.reverse()) await resource.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function services(
  stores: SqliteAgentStores,
  model: ModelClientFactory,
  checkpoints = stores.checkpoints,
): AgentServices {
  return {
    models: model,
    history: stores.history,
    checkpoints,
    authorizeTool: () => ({ type: "allow" }),
  };
}

function faultingCheckpoint(
  store: CheckpointStore,
  fail: (checkpoint: Parameters<CheckpointStore["save"]>[2]) => boolean,
): CheckpointStore {
  return {
    findUnfinished: (...args) => store.findUnfinished(...args),
    acquire: (...args) => store.acquire(...args),
    release: (...args) => store.release(...args),
    async save(lease, revision, checkpoint) {
      if (fail(checkpoint)) throw new Error("Injected storage crash window");
      return store.save(lease, revision, checkpoint);
    },
  };
}

function checkpointRow(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT owner_id, generation, revision, payload FROM general_agent_checkpoints WHERE agent_id = ? AND thread_id = ? AND query_id = ?",
      )
      .get("agent", "thread", "query") as {
      owner_id: string | null;
      generation: number;
      revision: number;
      payload: string;
    };
    return { ...row, checkpoint: JSON.parse(row.payload) as AgentCheckpoint };
  } finally {
    database.close();
  }
}

function compatibilityCapabilities(directory: string) {
  const counters = { execute: 0, resume: 0, audit: 0 };
  const nonce = randomUUID();
  const ledger = join(directory, "effects.txt");
  const file = join(directory, "approved.txt");
  const completedRequests: ModelRequest[] = [];
  const audit: AgentPlugin = {
    id: "audit",
    version: "1",
    setup(context) {
      context.tools.register({
        name: "audit.record",
        owner: "audit",
        version: "1",
        description: "Record one durable effect before approval",
        mode: "immediate",
        inputSchema: z.object({}),
        outputSchema: z.object({ nonce: z.string() }),
        toModelContent: (result) => [
          {
            type: "text",
            text: result.status === "succeeded" ? result.output.nonce : result.error.message,
          },
        ],
        async execute() {
          counters.audit += 1;
          await writeFile(ledger, nonce, { encoding: "utf8", flag: "wx" });
          return { status: "succeeded", output: { nonce }, effects: "applied" };
        },
      });
    },
  };
  const plugins = [audit, writer(file, counters, true)];
  const first = call();
  const request: ModelResponse = {
    ...first,
    message: {
      ...first.message,
      content: [
        { type: "tool-call", callId: "audit-1", name: "audit.record", input: {} },
        ...first.message.content,
      ],
    },
  };
  return {
    counters,
    nonce,
    ledger,
    file,
    plugins,
    request,
    async assertEffects(resumed: boolean) {
      expect(await readFile(ledger, "utf8")).toBe(nonce);
      expect(counters).toEqual({ execute: 1, resume: resumed ? 1 : 0, audit: 1 });
      if (resumed) expect(await readFile(file, "utf8")).toBe("persistent document");
      if (resumed) {
        expect(completedRequests).toHaveLength(1);
        expect(completedRequests[0].messages).toContainEqual({
          role: "tool",
          content: [
            {
              type: "tool-result",
              callId: "audit-1",
              content: [{ type: "text", text: nonce }],
              isError: false,
            },
            {
              type: "tool-result",
              callId: "write-1",
              content: [{ type: "text", text: "Document written" }],
              isError: false,
            },
          ],
        });
      } else await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    },
    complete(request: ModelRequest) {
      completedRequests.push(request);
      return answer("Approved durable effects complete");
    },
  };
}

interface CompatibilityChange {
  name: string;
  originalModel?: ModelSelection;
  change?: (original: AgentCreationOptions) => AgentCreationOptions;
  boundModel?: ModelSelection;
}

const compatibilityChanges: readonly CompatibilityChange[] = [
  {
    name: "definition id",
    change: (o) => ({ ...o, definition: { ...o.definition, id: "other" } }),
  },
  {
    name: "definition version",
    change: (o) => ({ ...o, definition: { ...o.definition, version: "2" } }),
  },
  { name: "plugin order", change: (o) => ({ ...o, plugins: [...o.plugins].reverse() }) },
  {
    name: "plugin addition",
    change: (o) => ({ ...o, plugins: [...o.plugins, { id: "extra", version: "1", setup() {} }] }),
  },
  { name: "plugin removal", change: (o) => ({ ...o, plugins: o.plugins.slice(1) }) },
  {
    name: "plugin id",
    change: (o) => ({ ...o, plugins: [{ ...o.plugins[0], id: "other-audit" }, o.plugins[1]] }),
  },
  {
    name: "plugin version",
    change: (o) => ({ ...o, plugins: [{ ...o.plugins[0], version: "2" }, o.plugins[1]] }),
  },
  { name: "actual provider binding", boundModel: { ...selection, providerId: "other" } },
  { name: "actual model binding", boundModel: { ...selection, modelId: "other" } },
  { name: "actual effort addition", boundModel: { ...selection, reasoningEffort: "high" } },
  {
    name: "actual effort removal",
    originalModel: { ...selection, reasoningEffort: "high" },
    boundModel: selection,
  },
  {
    name: "actual effort change",
    originalModel: { ...selection, reasoningEffort: "high" },
    boundModel: { ...selection, reasoningEffort: "low" },
  },
];

describe("SQLite waiting compatibility through public Application", () => {
  it.each(compatibilityChanges)(
    "rejects changed $name before saving or consuming the stored answer",
    async ({ originalModel, change, boundModel }) =>
      fixture(async (directory, own) => {
        const db = join(directory, "state.sqlite");
        const capability = compatibilityCapabilities(directory);
        const original: AgentCreationOptions = {
          ...options(capability.plugins),
          model: originalModel ?? selection,
        };
        let stores = own(createSqliteAgentStores(db));
        const first = own(
          createAgentApplication(
            services(
              stores,
              models(() => capability.request),
            ),
          ),
        );
        const agent = await first.agents.create(original);
        const waiting = await (await agent.run(input("query", "initial"))).completed;
        if (waiting.status !== "waiting") throw new Error("Expected durable approval");
        await first.close();
        await stores.dispose();
        stores = own(createSqliteAgentStores(db));
        const before = checkpointRow(db);
        const history = await stores.history.read("thread");
        expect(before.owner_id).toBeNull();
        expect(before.checkpoint).toMatchObject({
          status: "waiting",
          inflight: { completed: [{ completion: { effects: "applied" } }] },
          pending: { interaction: waiting.interaction, effects: "none" },
        });
        let bindings = 0;
        let modelCalls = 0;
        let saves = 0;
        const baseModels = models(() => {
          modelCalls += 1;
          throw new Error("An incompatible activation must not generate or stream");
        });
        const changed = own(
          createAgentApplication(
            services(
              stores,
              {
                async create(requested, signal) {
                  bindings += 1;
                  const binding = await baseModels.create(requested, signal);
                  return {
                    ...binding,
                    client: { ...binding.client, selection: boundModel ?? requested },
                  };
                },
              },
              {
                ...stores.checkpoints,
                async save(...args) {
                  saves += 1;
                  return stores.checkpoints.save(...args);
                },
              },
            ),
          ),
        );
        const changedAgent = await changed.agents.create(change?.(original) ?? original);
        await expect(
          (
            await changedAgent.resume({
              threadId: "thread",
              queryId: "query",
              runId: "incompatible",
              response: { interactionId: waiting.interaction.id, type: "answer", value: true },
            })
          ).completed,
        ).rejects.toMatchObject({ code: "DEFINITION_CHANGED" });
        expect(bindings).toBe(1);
        expect(modelCalls).toBe(0);
        expect(saves).toBe(0);
        expect(checkpointRow(db)).toEqual({ ...before, generation: before.generation + 1 });
        expect(await stores.history.read("thread")).toEqual(history);
        await capability.assertEffects(false);
        await changed.close();
        await stores.dispose();

        stores = own(createSqliteAgentStores(db));
        const restored = own(
          createAgentApplication(
            services(
              stores,
              models((request) => capability.complete(request)),
            ),
          ),
        );
        const restoredAgent = await restored.agents.create(original);
        const completed = await (
          await restoredAgent.resume({
            threadId: "thread",
            queryId: "query",
            runId: "original-restored",
            response: { interactionId: waiting.interaction.id, type: "answer", value: true },
          })
        ).completed;
        expect(completed).toMatchObject({
          status: "completed",
          identity: { queryId: "query", runId: "original-restored" },
        });
        await capability.assertEffects(true);
        expect(checkpointRow(db)).toMatchObject({
          owner_id: null,
          generation: before.generation + 2,
          checkpoint: {
            status: "completed",
            lastRunId: "original-restored",
            committed: { step: 2 },
          },
        });
        expect((await stores.history.read("thread")).messages).toEqual([
          ...history.messages,
          capability.request.message,
          expect.objectContaining({ role: "tool" }),
          answer("Approved durable effects complete").message,
        ]);
      }),
  );

  it.each([
    { change: "removed", response: "answer" },
    { change: "removed", response: "cancel" },
    { change: "version", response: "answer" },
    { change: "version", response: "cancel" },
    { change: "version", response: "none" },
    { change: "same-version", response: "answer" },
  ] as const)(
    "preserves the waiting tool for $change with $response until a compatible answer",
    async ({ change, response }) =>
      fixture(async (directory, own) => {
        const db = join(directory, "state.sqlite");
        const capability = compatibilityCapabilities(directory);
        const original = options(capability.plugins);
        let stores = own(createSqliteAgentStores(db));
        const first = own(
          createAgentApplication(
            services(
              stores,
              models(() => capability.request),
            ),
          ),
        );
        const waiting = await (
          await (await first.agents.create(original)).run(input("query", "initial"))
        ).completed;
        if (waiting.status !== "waiting") throw new Error("Expected durable approval");
        await first.close();
        await stores.dispose();
        stores = own(createSqliteAgentStores(db));
        const before = checkpointRow(db);
        const history = await stores.history.read("thread");
        let modelCalls = 0;
        const changed = own(
          createAgentApplication(
            services(
              stores,
              models((request) => {
                modelCalls += 1;
                return capability.complete(request);
              }),
            ),
          ),
        );
        const changedWriter =
          change === "removed"
            ? { ...capability.plugins[1], setup() {} }
            : writer(capability.file, capability.counters, true, change === "version" ? "2" : "1");
        const agent = await changed.agents.create({
          ...original,
          plugins: [capability.plugins[0], changedWriter],
        });
        const resumed = await agent.resume({
          threadId: "thread",
          queryId: "query",
          runId: "changed-tool",
          ...(response === "none"
            ? {}
            : {
                response:
                  response === "answer"
                    ? {
                        type: "answer" as const,
                        interactionId: waiting.interaction.id,
                        value: true,
                      }
                    : { type: "cancel" as const, interactionId: waiting.interaction.id },
              }),
        });
        if (change === "same-version") {
          expect((await resumed.completed).status).toBe("completed");
          expect(modelCalls).toBe(1);
          await capability.assertEffects(true);
          expect(checkpointRow(db)).toMatchObject({
            owner_id: null,
            checkpoint: { status: "completed" },
          });
          return;
        }
        if (response === "none") {
          expect(await resumed.completed).toMatchObject({
            status: "waiting",
            interaction: waiting.interaction,
          });
        } else {
          await expect(resumed.completed).rejects.toMatchObject({ code: "TOOL_VERSION_CHANGED" });
        }
        const after = checkpointRow(db);
        expect(after).toMatchObject({
          owner_id: null,
          generation: before.generation + 1,
          checkpoint: {
            status: "waiting",
            lastRunId: "changed-tool",
            pending: before.checkpoint.status === "waiting" ? before.checkpoint.pending : undefined,
            inflight:
              before.checkpoint.status === "waiting" ? before.checkpoint.inflight : undefined,
          },
        });
        expect(after.revision).toBeGreaterThan(before.revision);
        expect(await stores.history.read("thread")).toEqual(history);
        expect(modelCalls).toBe(0);
        await capability.assertEffects(false);
        await changed.close();
        await stores.dispose();

        stores = own(createSqliteAgentStores(db));
        const restored = own(
          createAgentApplication(
            services(
              stores,
              models((request) => capability.complete(request)),
            ),
          ),
        );
        const restoredAgent = await restored.agents.create(original);
        expect(
          (
            await (
              await restoredAgent.resume({
                threadId: "thread",
                queryId: "query",
                runId: "compatible-answer",
                response: { type: "answer", interactionId: waiting.interaction.id, value: true },
              })
            ).completed
          ).status,
        ).toBe("completed");
        await capability.assertEffects(true);
        expect(checkpointRow(db)).toMatchObject({
          owner_id: null,
          generation: before.generation + 2,
          checkpoint: { status: "completed", lastRunId: "compatible-answer" },
        });
      }),
  );
});

describe("SQLite SessionHost binding compatibility before Agent installation", () => {
  const changes: ReadonlyArray<{
    name: string;
    change: (original: HostSessionBinding) => HostSessionBinding;
  }> = [
    { name: "workspace", change: (b) => ({ ...b, workspaceRoot: join(b.workspaceRoot, "other") }) },
    { name: "tool mode", change: (b) => ({ ...b, toolMode: "read-only" }) },
    {
      name: "connection fingerprint",
      change: (b) => ({ ...b, connectionFingerprint: "b".repeat(64) }),
    },
    {
      name: "definition id",
      change: (b) => ({ ...b, definition: { ...b.definition, id: "other" } }),
    },
    {
      name: "definition version",
      change: (b) => ({ ...b, definition: { ...b.definition, version: "2" } }),
    },
    { name: "plugin order", change: (b) => ({ ...b, plugins: [...b.plugins].reverse() }) },
    {
      name: "plugin addition",
      change: (b) => ({ ...b, plugins: [...b.plugins, { id: "extra", version: "1" }] }),
    },
    { name: "plugin removal", change: (b) => ({ ...b, plugins: b.plugins.slice(1) }) },
    {
      name: "plugin id",
      change: (b) => ({ ...b, plugins: [{ ...b.plugins[0], id: "other" }, b.plugins[1]] }),
    },
    {
      name: "plugin version",
      change: (b) => ({ ...b, plugins: [{ ...b.plugins[0], version: "2" }, b.plugins[1]] }),
    },
    { name: "increased maxSteps", change: (b) => ({ ...b, maxSteps: b.maxSteps + 1 }) },
    { name: "decreased maxSteps", change: (b) => ({ ...b, maxSteps: b.maxSteps - 1 }) },
  ];
  it.each(changes)(
    "rejects $name without installing an Agent or replacing any durable state",
    async ({ change }) =>
      fixture(async (directory, own) => {
        const db = join(directory, "state.sqlite");
        const capability = compatibilityCapabilities(directory);
        const original = options(capability.plugins);
        const binding: HostSessionBinding = {
          schemaVersion: 2,
          agentId: original.agentId,
          threadId: "thread",
          workspaceRoot: directory,
          toolMode: "read-write",
          model: original.model,
          connectionFingerprint: "a".repeat(64),
          definition: { id: original.definition.id, version: original.definition.version },
          plugins: original.plugins.map(({ id, version }) => ({ id, version })),
          maxSteps: original.maxSteps,
        };
        let stores = own(createSqliteAgentStores(db));
        const first = own(
          await createSessionHost({
            services: services(
              stores,
              models(() => capability.request),
            ),
            agent: original,
            threadId: "thread",
            binding: { ensure: () => stores.bindings.ensure(binding) },
          }),
        );
        const waiting = await (await first.run(input("query", "initial"))).completed;
        if (waiting.status !== "waiting") throw new Error("Expected durable approval");
        await first.close();
        await stores.dispose();
        stores = own(createSqliteAgentStores(db));
        const before = checkpointRow(db);
        const history = await stores.history.read("thread");
        const candidate = change(binding);
        let setups = 0;
        let bindings = 0;
        const model = models(() => {
          throw new Error("Binding rejection must not generate");
        });
        await expect(
          createSessionHost({
            services: services(stores, {
              async create(...args) {
                bindings += 1;
                return model.create(...args);
              },
            }),
            agent: {
              ...original,
              definition: { ...original.definition, ...candidate.definition },
              model: candidate.model,
              maxSteps: candidate.maxSteps,
              plugins: candidate.plugins.map((spec) => ({
                ...spec,
                setup(context) {
                  setups += 1;
                  return original.plugins.find((plugin) => plugin.id === spec.id)?.setup(context);
                },
              })),
            },
            threadId: "thread",
            binding: { ensure: () => stores.bindings.ensure(candidate) },
          }),
        ).rejects.toMatchObject({ code: "HOST_BINDING_CHANGED" });
        expect(setups).toBe(0);
        expect(bindings).toBe(0);
        expect(await stores.bindings.read("thread")).toEqual(binding);
        expect(checkpointRow(db)).toEqual(before);
        expect(await stores.history.read("thread")).toEqual(history);
        await capability.assertEffects(false);
        await stores.dispose();

        stores = own(createSqliteAgentStores(db));
        const restored = own(
          await createSessionHost({
            services: services(
              stores,
              models((request) => capability.complete(request)),
            ),
            agent: original,
            threadId: "thread",
            binding: { ensure: () => stores.bindings.ensure(binding) },
          }),
        );
        expect(
          (
            await (
              await restored.resume({
                queryId: "query",
                runId: "original-binding",
                response: { type: "answer", interactionId: waiting.interaction.id, value: true },
              })
            ).completed
          ).status,
        ).toBe("completed");
        await capability.assertEffects(true);
        expect(await stores.bindings.read("thread")).toEqual(binding);
        expect(checkpointRow(db)).toMatchObject({
          owner_id: null,
          generation: before.generation + 1,
          checkpoint: { status: "completed", lastRunId: "original-binding" },
        });
      }),
  );
});

describe("general Agent execution and recovery", () => {
  it("runs a real file capability and preserves ordered tool pairs and reasoning replay", async () =>
    fixture(async (directory, own) => {
      const stores = own(createSqliteAgentStores(join(directory, "state.sqlite")));
      const counters = { execute: 0, resume: 0 };
      let requests = 0;
      const factory = own(
        createAgentApplication(
          services(
            stores,
            models((request) => {
              requests += 1;
              if (requests === 1) return call();
              expect(request.messages.at(-1)).toMatchObject({
                role: "tool",
                content: [{ type: "tool-result", callId: "write-1" }],
              });
              expect(
                request.messages.find((message) => message.role === "assistant"),
              ).toMatchObject({
                replayState: { data: { signature: "retained-by-adapter" } },
              });
              return answer("Document ready");
            }),
          ),
        ),
      ).agents;
      const agent = own(
        await factory.create(options([writer(join(directory, "result.txt"), counters)])),
      );
      try {
        const result = await (await agent.run(input("query", "run-1"))).completed;
        expect(result).toMatchObject({
          status: "completed",
          output: [
            { role: "assistant" },
            { role: "assistant", content: [{ type: "text", text: "Document ready" }] },
          ],
        });
        expect(await readFile(join(directory, "result.txt"), "utf8")).toBe("persistent document");
        expect(counters.execute).toBe(1);
        expect(
          (await stores.history.read("thread")).messages.map((message) => message.role),
        ).toEqual(["user", "assistant", "tool", "assistant"]);
      } finally {
        await agent.dispose();
        await stores.dispose();
      }
    }));

  it("persists a wait across process-local lifetimes and resumes without execute or duplicate approval", async () =>
    fixture(async (directory, own) => {
      const file = join(directory, "result.txt");
      const db = join(directory, "state.sqlite");
      const counters = { execute: 0, resume: 0 };
      let stores = own(createSqliteAgentStores(db));
      let agent = own(
        await own(
          createAgentApplication(
            services(
              stores,
              models(() => call()),
            ),
          ),
        ).agents.create(options([writer(file, counters, true)])),
      );
      const waiting = await (await agent.run(input("query", "run-1"))).completed;
      expect(waiting.status).toBe("waiting");
      if (waiting.status !== "waiting") throw new Error("Expected interaction");
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
      const blocked = await agent.run(input("other-query", "blocked-run"));
      await expect(blocked.completed).rejects.toMatchObject({ code: "THREAD_PENDING" });
      await agent.dispose();
      await stores.dispose();
      stores = own(createSqliteAgentStores(db));
      agent = own(
        await own(
          createAgentApplication(
            services(
              stores,
              models(() => answer("Approved write complete")),
            ),
          ),
        ).agents.create(options([writer(file, counters, true)])),
      );
      try {
        const resumed = await agent.resume({
          threadId: "thread",
          queryId: "query",
          runId: "run-2",
          response: { type: "answer", interactionId: waiting.interaction.id, value: true },
        });
        expect((await resumed.completed).status).toBe("completed");
        expect(await readFile(file, "utf8")).toBe("persistent document");
        expect(counters).toEqual({ execute: 1, resume: 1 });
        const duplicate = await agent.resume({
          threadId: "thread",
          queryId: "query",
          runId: "run-3",
          response: { type: "answer", interactionId: waiting.interaction.id, value: true },
        });
        await expect(duplicate.completed).rejects.toMatchObject({ code: "QUERY_TERMINAL" });
        expect(counters.resume).toBe(1);
      } finally {
        await agent.dispose();
        await stores.dispose();
      }
    }));

  it("does not replay an external effect when its result checkpoint failed", async () =>
    fixture(async (directory, own) => {
      const stores = own(createSqliteAgentStores(join(directory, "state.sqlite")));
      const counters = { execute: 0, resume: 0 };
      let failed = false;
      const checkpoint = faultingCheckpoint(stores.checkpoints, (state) => {
        if (
          !failed &&
          state.status === "running" &&
          state.inflight?.type === "tools" &&
          state.inflight.completed.length === 1
        ) {
          failed = true;
          return true;
        }
        return false;
      });
      let agent = own(
        await own(
          createAgentApplication(
            services(
              stores,
              models(() => call()),
              checkpoint,
            ),
          ),
        ).agents.create(options([writer(join(directory, "result.txt"), counters)])),
      );
      await expect((await agent.run(input("query", "run-1"))).completed).rejects.toMatchObject({
        code: "PERSISTENCE_FAILED",
      });
      expect(await readFile(join(directory, "result.txt"), "utf8")).toBe("persistent document");
      await agent.dispose();
      agent = own(
        await own(
          createAgentApplication(
            services(
              stores,
              models((request) => {
                expect(request.messages.at(-1)).toMatchObject({
                  role: "tool",
                  content: [
                    {
                      callId: "write-1",
                      isError: true,
                      content: [{ text: expect.stringContaining("unknown") }],
                    },
                  ],
                });
                return answer("External effect requires verification");
              }),
            ),
          ),
        ).agents.create(options([writer(join(directory, "result.txt"), counters)])),
      );
      try {
        expect(
          (
            await (
              await agent.resume({ threadId: "thread", queryId: "query", runId: "run-2" })
            ).completed
          ).status,
        ).toBe("completed");
        expect(counters.execute).toBe(1);
      } finally {
        await agent.dispose();
        await stores.dispose();
      }
    }));

  it("reconciles a committed-but-unconfirmed history append without duplicating user input", async () =>
    fixture(async (directory, own) => {
      const stores = own(createSqliteAgentStores(join(directory, "state.sqlite")));
      let fail = true;
      const dependency = services(
        stores,
        models(() => answer("done")),
      );
      const history = {
        read: stores.history.read.bind(stores.history),
        async append(...args: Parameters<typeof stores.history.append>) {
          const result = await stores.history.append(...args);
          if (fail) {
            fail = false;
            throw new Error("Lost append acknowledgement");
          }
          return result;
        },
      };
      let agent = own(
        await own(createAgentApplication({ ...dependency, history })).agents.create(options([])),
      );
      await expect((await agent.run(input("query", "run-1"))).completed).rejects.toMatchObject({
        code: "PERSISTENCE_FAILED",
      });
      await agent.dispose();
      agent = own(await own(createAgentApplication(dependency)).agents.create(options([])));
      try {
        expect(
          (
            await (
              await agent.resume({ threadId: "thread", queryId: "query", runId: "run-2" })
            ).completed
          ).status,
        ).toBe("completed");
        expect(
          (await stores.history.read("thread")).messages.map((message) => message.role),
        ).toEqual(["user", "assistant"]);
      } finally {
        await agent.dispose();
        await stores.dispose();
      }
    }));

  it("keeps step budgets across a tool turn instead of claiming a truncated query succeeded", async () =>
    fixture(async (directory, own) => {
      const stores = own(createSqliteAgentStores(join(directory, "state.sqlite")));
      const counters = { execute: 0, resume: 0 };
      let modelCalls = 0;
      const agent = own(
        await own(
          createAgentApplication(
            services(
              stores,
              models(() => {
                modelCalls += 1;
                return call();
              }),
            ),
          ),
        ).agents.create(options([writer(join(directory, "result.txt"), counters)], 1)),
      );
      try {
        expect(await (await agent.run(input("query", "run-1"))).completed).toMatchObject({
          status: "failed",
          error: { code: "STEP_LIMIT" },
        });
        expect(modelCalls).toBe(1);
        expect(counters.execute).toBe(1);
      } finally {
        await agent.dispose();
        await stores.dispose();
      }
    }));
  it("does not consume an answered interaction twice after a resume result is lost", async () =>
    fixture(async (directory, own) => {
      const stores = own(createSqliteAgentStores(join(directory, "state.sqlite")));
      const counters = { execute: 0, resume: 0 };
      const file = join(directory, "result.txt");
      let fail = true;
      const checkpoints = faultingCheckpoint(stores.checkpoints, (state) => {
        if (
          fail &&
          state.status === "running" &&
          state.inflight?.type === "tools" &&
          state.inflight.completed.length === 1
        ) {
          fail = false;
          return true;
        }
        return false;
      });
      let agent = own(
        await own(
          createAgentApplication(
            services(
              stores,
              models(() => call()),
              checkpoints,
            ),
          ),
        ).agents.create(options([writer(file, counters, true)])),
      );
      const waiting = await (await agent.run(input("query", "run-1"))).completed;
      if (waiting.status !== "waiting") throw new Error("Expected saved interaction");
      await expect(
        (
          await agent.resume({
            threadId: "thread",
            queryId: "query",
            runId: "run-2",
            response: { type: "answer", interactionId: waiting.interaction.id, value: true },
          })
        ).completed,
      ).rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
      expect(await readFile(file, "utf8")).toBe("persistent document");
      await agent.dispose();
      agent = own(
        await own(
          createAgentApplication(
            services(
              stores,
              models((request) => {
                expect(request.messages.at(-1)).toMatchObject({
                  role: "tool",
                  content: [{ callId: "write-1", isError: true }],
                });
                return answer("Verify the uncertain external outcome");
              }),
            ),
          ),
        ).agents.create(options([writer(file, counters, true)])),
      );
      expect(
        (
          await (
            await agent.resume({ threadId: "thread", queryId: "query", runId: "run-3" })
          ).completed
        ).status,
      ).toBe("completed");
      expect(counters).toEqual({ execute: 1, resume: 1 });
    }));

  it("never commits provisional stream text as a completed assistant message", async () =>
    fixture(async (directory, own) => {
      const stores = own(createSqliteAgentStores(join(directory, "state.sqlite")));
      const base = models(() => answer("Not used by a streaming client"));
      const streaming: ModelClientFactory = {
        async create(selected, signal) {
          const binding = await base.create(selected, signal);
          return {
            ...binding,
            client: {
              ...binding.client,
              capabilities: { ...binding.client.capabilities, streaming: true },
              async *stream() {
                yield {
                  type: "content-delta" as const,
                  index: 0,
                  delta: { type: "text" as const, text: "An unconfirmed answer" },
                };
              },
            },
          };
        },
      };
      const agent = own(
        await own(createAgentApplication(services(stores, streaming))).agents.create(options([])),
      );
      expect(await (await agent.run(input("query", "run-1"))).completed).toMatchObject({
        status: "failed",
        error: { code: "INCOMPLETE_MODEL_STREAM" },
      });
      expect((await stores.history.read("thread")).messages.map((message) => message.role)).toEqual(
        ["user"],
      );
    }));

  it("keeps native provider diagnostics out of durable public errors", async () =>
    fixture(async (directory, own) => {
      const stores = own(createSqliteAgentStores(join(directory, "state.sqlite")));
      const agent = own(
        await own(
          createAgentApplication(
            services(
              stores,
              models(() => {
                throw new Error("private-key-in-native-provider-diagnostic");
              }),
            ),
          ),
        ).agents.create(options([])),
      );
      const result = await (await agent.run(input("query", "run-1"))).completed;
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "EXECUTION_FAILED", message: "Agent execution failed" },
      });
      const saved = await stores.checkpoints.acquire(
        { agentId: "agent", threadId: "thread", queryId: "query" },
        "inspection",
      );
      if (saved.status !== "acquired") throw new Error("Expected released checkpoint");
      expect(JSON.stringify(saved.checkpoint)).not.toContain(
        "private-key-in-native-provider-diagnostic",
      );
      await stores.checkpoints.release(saved.lease);
    }));

  it("settles cancellation before admission without leaving a pending query", async () =>
    fixture(async (directory, own) => {
      const stores = own(createSqliteAgentStores(join(directory, "state.sqlite")));
      let calls = 0;
      const agent = own(
        await own(
          createAgentApplication(
            services(
              stores,
              models(() => {
                calls += 1;
                return answer("admitted");
              }),
            ),
          ),
        ).agents.create(options([])),
      );
      const cancelled = new AbortController();
      cancelled.abort();
      expect(
        (
          await (
            await agent.run({ ...input("cancelled-query", "run-1"), signal: cancelled.signal })
          ).completed
        ).status,
      ).toBe("cancelled");
      expect(calls).toBe(0);
      expect(await stores.checkpoints.findUnfinished("agent", "thread")).toBeNull();
      expect((await (await agent.run(input("new-query", "run-2"))).completed).status).toBe(
        "completed",
      );
      expect(calls).toBe(1);
      expect((await stores.history.read("thread")).messages.map((message) => message.role)).toEqual(
        ["user", "assistant"],
      );
    }));

  it("rejects a delayed new Query after another writer has durably entered waiting", async () =>
    fixture(async (directory, own) => {
      const path = join(directory, "approval.txt");
      const counters = { execute: 0, resume: 0 };
      const first = own(createSqliteAgentStores(join(directory, "state.sqlite")));
      const second = own(createSqliteAgentStores(join(directory, "state.sqlite")));
      const entered = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      let rejectedModelCalls = 0;
      const firstServices: AgentServices = {
        ...services(
          first,
          models((request) =>
            request.messages.some((message) => message.role === "tool")
              ? answer("approved completion")
              : call(),
          ),
        ),
        authorizeTool: (invocation, context) => ({
          type: "approval",
          interaction: {
            id: `approve:${context.identity.queryId}:${invocation.callId}`,
            owner: "host-policy",
            payload: { type: "documents.approval", version: 1, data: {} },
          },
        }),
      };
      const active = await own(createAgentApplication(firstServices)).agents.create(
        options([writer(path, counters)]),
      );
      const delayed = await own(
        createAgentApplication(
          services(
            second,
            models(() => {
              rejectedModelCalls += 1;
              return answer("must not run");
            }),
            {
              ...second.checkpoints,
              async acquire(...args) {
                entered.resolve();
                await proceed.promise;
                return second.checkpoints.acquire(...args);
              },
            },
          ),
        ),
      ).agents.create(options([writer(path, counters)]));
      const rejected = (await delayed.run(input("delayed", "delayed-run"))).completed;
      // 先登记拒绝观察，再放行竞争方，避免失败 Promise 悬空。
      const rejectedAssertion = expect(rejected).rejects.toMatchObject({ code: "THREAD_PENDING" });
      try {
        await entered.promise;
        const waiting = await (await active.run(input("waiting", "waiting-run"))).completed;
        expect(waiting.status).toBe("waiting");
        if (waiting.status !== "waiting") throw new Error("Expected approval");
        const before = await first.checkpoints.findUnfinished("agent", "thread");
        proceed.resolve();
        await rejectedAssertion;
        expect(rejectedModelCalls).toBe(0);
        expect(counters).toEqual({ execute: 0, resume: 0 });
        expect(await second.checkpoints.findUnfinished("agent", "thread")).toEqual(before);
        expect(await second.history.read("thread")).toEqual({
          threadId: "thread",
          revision: 1,
          messages: input("waiting", "waiting-run").input,
        });
        const resumed = await (
          await active.resume({
            threadId: "thread",
            queryId: "waiting",
            runId: "approved-run",
            response: { interactionId: waiting.interaction.id, type: "answer", value: true },
          })
        ).completed;
        expect(resumed.status).toBe("completed");
        expect(await readFile(path, "utf8")).toBe("persistent document");
        expect(counters).toEqual({ execute: 1, resume: 0 });
      } finally {
        proceed.resolve();
        await Promise.allSettled([rejected, rejectedAssertion]);
      }
    }));

  it.each(["initial-save", "terminal-release"] as const)(
    "keeps the Thread reserved across the %s boundary",
    async (boundary) =>
      fixture(async (directory, own) => {
        const first = own(createSqliteAgentStores(join(directory, "state.sqlite")));
        const second = own(createSqliteAgentStores(join(directory, "state.sqlite")));
        const entered = Promise.withResolvers<void>();
        const proceed = Promise.withResolvers<void>();
        let firstSave = true;
        let secondCalls = 0;
        const checkpoints: CheckpointStore = {
          ...first.checkpoints,
          async save(...args) {
            if (boundary === "initial-save" && firstSave) {
              firstSave = false;
              entered.resolve();
              await proceed.promise;
            }
            return first.checkpoints.save(...args);
          },
          async release(lease) {
            if (boundary === "terminal-release") {
              entered.resolve();
              await proceed.promise;
            }
            return first.checkpoints.release(lease);
          },
        };
        const active = await own(
          createAgentApplication(
            services(
              first,
              models(() => answer("first reply")),
              checkpoints,
            ),
          ),
        ).agents.create(options([]));
        const competing = await own(
          createAgentApplication(
            services(
              second,
              models(() => {
                secondCalls += 1;
                return answer("second reply");
              }),
            ),
          ),
        ).agents.create(options([]));
        const running = (await active.run(input("first", "first-run"))).completed;
        const observed = running.then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        try {
          await entered.promise;
          await expect(
            (await competing.run(input("second", "blocked-run"))).completed,
          ).rejects.toMatchObject({ code: "THREAD_PENDING" });
          expect(secondCalls).toBe(0);
          proceed.resolve();
          expect(await running).toMatchObject({ status: "completed" });
          expect(
            await (await competing.run(input("second", "allowed-run"))).completed,
          ).toMatchObject({ status: "completed" });
          expect(secondCalls).toBe(1);
          expect((await second.history.read("thread")).messages).toEqual([
            ...input("first", "first-run").input,
            answer("first reply").message,
            ...input("second", "allowed-run").input,
            answer("second reply").message,
          ]);
        } finally {
          proceed.resolve();
          await observed;
        }
      }),
  );
});

describe("execution and lease release failures", () => {
  it.each(
    (["success", "persistence", "fenced"] as const).flatMap((execution) =>
      (["before", "after"] as const).map((release) => ({ execution, release })),
    ),
  )("preserves $execution with release rejection $release commit", async ({ execution, release }) =>
    fixture(async (directory, own) => {
      const database = join(directory, "release.sqlite");
      const stores = own(createSqliteAgentStores(database));
      const releaseError = new Error("Native cleanup detail must stay internal");
      let modelCalls = 0;
      let lease: Parameters<CheckpointStore["release"]>[0] | undefined;
      let replacement: Parameters<CheckpointStore["release"]>[0] | undefined;
      const checkpoints: CheckpointStore = {
        findUnfinished: (...args) => stores.checkpoints.findUnfinished(...args),
        acquire: (...args) => stores.checkpoints.acquire(...args),
        async save(current, revision, state) {
          lease = current;
          if (execution === "persistence") throw new Error("Checkpoint unavailable");
          if (execution === "fenced") {
            const next = await stores.checkpoints.acquire(current.key, "replacement", {
              replace: current,
            });
            expect(next.status).toBe("acquired");
            if (next.status !== "acquired") throw new Error("Replacement did not acquire");
            replacement = next.lease;
          }
          return stores.checkpoints.save(current, revision, state);
        },
        async release(current) {
          if (release === "after") await stores.checkpoints.release(current);
          throw releaseError;
        },
      };
      const app = own(
        createAgentApplication(
          services(
            stores,
            models(() => {
              modelCalls += 1;
              return answer("finished");
            }),
            checkpoints,
          ),
        ),
      );
      const agent = own(await app.agents.create(options([])));
      const handle = await agent.run(input("query", "run-1"));
      const error: unknown = await handle.completed.then(
        () => {
          throw new Error("Release rejection must reject completed");
        },
        (reason: unknown) => reason,
      );
      // E1-6：事后排空观察仍可能看见成功 fact；它不能取代已拒绝的 completed。
      const observed: RuntimeEvent[] = [];
      for await (const event of handle.events) {
        expect(event.identity).toEqual(handle.identity);
        observed.push(event);
      }
      expect(observed.filter((event) => event.type === "run.completed")).toHaveLength(
        execution === "success" ? 1 : 0,
      );
      expect(observed.some((event) => event.type === "run.failed")).toBe(false);
      if (execution === "success") expect(error).toBe(releaseError);
      else {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([
          expect.objectContaining({
            code: execution === "persistence" ? "PERSISTENCE_FAILED" : "CHECKPOINT_CONFLICT",
          }),
          releaseError,
        ]);
      }
      expect(modelCalls).toBe(execution === "success" ? 1 : 0);
      const reader = new DatabaseSync(database, { readOnly: true });
      try {
        const row = reader
          .prepare("SELECT owner_id, generation, payload FROM general_agent_checkpoints")
          .get() as { owner_id: string | null; generation: number; payload: string | null };
        expect(row.owner_id).toBe(
          execution === "fenced" ? "replacement" : release === "before" ? "run-1" : null,
        );
        expect(row.generation).toBe(execution === "fenced" ? 2 : 1);
        if (execution === "success") {
          expect(JSON.parse(row.payload!)).toMatchObject({ status: "completed" });
          expect(
            (await stores.history.read("thread")).messages.map((message) => message.role),
          ).toEqual(["user", "assistant"]);
        } else {
          expect(row.payload).toBeNull();
          expect(await stores.history.read("thread")).toMatchObject({ revision: 0, messages: [] });
        }
      } finally {
        reader.close();
        if (replacement) await stores.checkpoints.release(replacement);
        else if (lease) await stores.checkpoints.release(lease);
      }
    }),
  );
});
