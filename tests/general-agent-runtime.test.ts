import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentServices } from "../src/agent/agent-factory";
import { createDefaultAgentFactory } from "../src/agent/application/default-agent-factory";
import type { AgentPlugin } from "../src/agent/extensions/plugin-contract";
import type {
  ModelClientFactory,
  ModelRequest,
  ModelResponse,
} from "../src/agent/model/model-contract";
import type { Disposable } from "../src/agent/protocol-values";
import type { CheckpointStore } from "../src/agent/session/checkpoint-contract";
import {
  createSqliteAgentStores,
  type SqliteAgentStores,
} from "../src/main/agent-host/sqlite-agent-stores";

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
): AgentPlugin {
  return {
    id: "documents",
    version: "1",
    setup(context) {
      const common = {
        name: "documents.write",
        owner: "documents",
        version: "1",
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

describe("general Agent execution and recovery", () => {
  it("runs a real file capability and preserves ordered tool pairs and reasoning replay", async () =>
    fixture(async (directory, own) => {
      const stores = own(createSqliteAgentStores(join(directory, "state.sqlite")));
      const counters = { execute: 0, resume: 0 };
      let requests = 0;
      const factory = createDefaultAgentFactory(
        services(
          stores,
          models((request) => {
            requests += 1;
            if (requests === 1) return call();
            expect(request.messages.at(-1)).toMatchObject({
              role: "tool",
              content: [{ type: "tool-result", callId: "write-1" }],
            });
            expect(request.messages.find((message) => message.role === "assistant")).toMatchObject({
              replayState: { data: { signature: "retained-by-adapter" } },
            });
            return answer("Document ready");
          }),
        ),
      );
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
        await createDefaultAgentFactory(
          services(
            stores,
            models(() => call()),
          ),
        ).create(options([writer(file, counters, true)])),
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
        await createDefaultAgentFactory(
          services(
            stores,
            models(() => answer("Approved write complete")),
          ),
        ).create(options([writer(file, counters, true)])),
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
        await createDefaultAgentFactory(
          services(
            stores,
            models(() => call()),
            checkpoint,
          ),
        ).create(options([writer(join(directory, "result.txt"), counters)])),
      );
      await expect((await agent.run(input("query", "run-1"))).completed).rejects.toMatchObject({
        code: "PERSISTENCE_FAILED",
      });
      expect(await readFile(join(directory, "result.txt"), "utf8")).toBe("persistent document");
      await agent.dispose();
      agent = own(
        await createDefaultAgentFactory(
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
        ).create(options([writer(join(directory, "result.txt"), counters)])),
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
        await createDefaultAgentFactory({ ...dependency, history }).create(options([])),
      );
      await expect((await agent.run(input("query", "run-1"))).completed).rejects.toMatchObject({
        code: "PERSISTENCE_FAILED",
      });
      await agent.dispose();
      agent = own(await createDefaultAgentFactory(dependency).create(options([])));
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
        await createDefaultAgentFactory(
          services(
            stores,
            models(() => {
              modelCalls += 1;
              return call();
            }),
          ),
        ).create(options([writer(join(directory, "result.txt"), counters)], 1)),
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
        await createDefaultAgentFactory(
          services(
            stores,
            models(() => call()),
            checkpoints,
          ),
        ).create(options([writer(file, counters, true)])),
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
        await createDefaultAgentFactory(
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
        ).create(options([writer(file, counters, true)])),
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
        await createDefaultAgentFactory(services(stores, streaming)).create(options([])),
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
        await createDefaultAgentFactory(
          services(
            stores,
            models(() => {
              throw new Error("private-key-in-native-provider-diagnostic");
            }),
          ),
        ).create(options([])),
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
        await createDefaultAgentFactory(
          services(
            stores,
            models(() => {
              calls += 1;
              return answer("admitted");
            }),
          ),
        ).create(options([])),
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
});
