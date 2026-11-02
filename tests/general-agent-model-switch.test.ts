import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAgentConfiguration } from "@agent-harness/configuration/configuration";
import type {
  ModelRequest,
  ModelResponse,
  ModelSelection,
} from "@agent-harness/core/model/model-contract";
import type { createModelProvider } from "@agent-harness/models/models";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeHost } from "../cli/host/node-host.js";
import { createSqliteAgentStores } from "../cli/host/sqlite-agent-stores.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function answer(text: string): ModelResponse {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    finishReason: "stop",
  };
}
function call(selection: ModelSelection, name = "read"): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: [
        { type: "reasoning", text: "public thinking" },
        { type: "text", text: "Reading the original file" },
        {
          type: "tool-call",
          callId: `call-${selection.modelId}`,
          name,
          input:
            name === "read"
              ? { path: "notes.txt" }
              : { path: "created.txt", content: "approved only", mode: "create" },
        },
      ],
      replayState: {
        providerId: selection.providerId,
        modelId: selection.modelId,
        format: "controlled-signed-output",
        version: 1,
        data: { signature: `private-${selection.modelId}` },
      },
    },
    finishReason: "tool-calls",
  };
}

async function fixture(
  respond: (
    request: ModelRequest,
    selection: ModelSelection,
    signal: AbortSignal,
  ) => ModelResponse | Promise<ModelResponse>,
  options: {
    failBinding?: () => boolean;
    failDispose?: () => boolean;
    beforeDispose?: () => Promise<void>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "same-thread-model-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "notes.txt"), "authoritative tool result", "utf8");
  const configuration = createAgentConfiguration({
    applicationDataRoot: root,
    defaultTemplateId: "none",
    environment: {},
    credentialProtection: {
      scheme: "windows-dpapi-current-user",
      inspect: async () => ({ state: "secure", backend: "windows-dpapi-current-user" }),
      encrypt: async (value) => Buffer.from(value),
      decrypt: async (value) => ({ result: Buffer.from(value).toString(), shouldReEncrypt: false }),
    },
  });
  await configuration.management.initialize();
  for (const protocol of ["openai", "anthropic"] as const) {
    await configuration.management.saveVendor({
      vendor: {
        id: protocol,
        kind: "custom",
        label: protocol,
        protocol,
        baseURL: "http://127.0.0.1:1",
        enabled: true,
        models: (protocol === "openai" ? ["a", "b"] : ["c"]).map((id) => ({
          id,
          name: id,
          model: id,
          enabled: true,
          openaiApiMode: "responses" as const,
        })),
      },
      credential: { type: "replace", apiKey: "local-controlled-credential" },
    });
  }
  const requests: Array<{ selection: ModelSelection; request: ModelRequest }> = [];
  const prepared: string[] = [];
  const provider: typeof createModelProvider = async (providerOptions) => ({
    adapterId: providerOptions.adapterId,
    async dispose() {
      await options.beforeDispose?.();
      if (options.failDispose?.()) throw new Error("old provider close failed");
    },
    async create(selection) {
      prepared.push(selection.modelId);
      if (selection.modelId === "b" && options.failBinding?.()) throw new Error("B not ready");
      return {
        dispose: async () => undefined,
        client: {
          selection,
          capabilities: { streaming: false, toolCalls: true, reasoning: true, images: true },
          async generate(request, signal) {
            requests.push({ selection, request });
            return respond(request, selection, signal);
          },
          async *stream(request, signal) {
            requests.push({ selection, request });
            yield { type: "completed", response: await respond(request, selection, signal) };
          },
        },
      };
    },
  });
  const open = async (threadId?: string, toolsMode: "read-only" | "read-write" = "read-only") => {
    const host = createNodeHost({
      dataRoot: root,
      workspaceRoot: workspace,
      configuration,
      createProvider: provider,
    });
    cleanup.push(() => host.close());
    await host.open(threadId ? { threadId } : { modelId: "a", toolsMode });
    return host;
  };
  const stores = () => {
    const opened = createSqliteAgentStores(join(root, "sessions.sqlite"));
    cleanup.push(() => opened.dispose());
    return opened;
  };
  const openV2 = async (toolsMode: "read-only" | "read-write" = "read-only") => {
    const seed = await open(undefined, toolsMode);
    const threadId = seed.context.threadId;
    await seed.close();
    const database = new DatabaseSync(join(root, "sessions.sqlite"));
    try {
      const row = database
        .prepare("SELECT payload FROM general_agent_host_bindings WHERE thread_id = ?")
        .get(threadId)!;
      const {
        generation: _generation,
        modelHistoryStart: _historyStart,
        ...fields
      } = JSON.parse(row.payload as string);
      database
        .prepare("UPDATE general_agent_host_bindings SET payload = ? WHERE thread_id = ?")
        .run(JSON.stringify({ ...fields, schemaVersion: 2 }), threadId);
    } finally {
      database.close();
    }
    return open(threadId);
  };
  return { root, workspace, requests, prepared, open, openV2, stores };
}

describe("same-thread host model selection", () => {
  it.each(["b", "c"])(
    "explicitly upgrades a completed v2 thread to %s, preserves canonical tools and reopens the selection",
    async (target) => {
      const f = await fixture((request, selection) => {
        const toolResult = request.messages.some(
          (message) =>
            message.role === "tool" &&
            message.content.some((part) => part.callId === `call-${selection.modelId}`),
        );
        return toolResult ? answer(`finished-${selection.modelId}`) : call(selection);
      });
      const host = await f.openV2();
      const threadId = host.context.threadId;
      const first = await host.run("Read the file with A");
      expect((await first.completed).status).toBe("completed");
      const stores = f.stores();
      const before = await stores.history.read(threadId);
      const original = await stores.bindings.read(threadId);
      expect(original?.schemaVersion).toBe(2);
      const inspection = new DatabaseSync(join(f.root, "sessions.sqlite"), { readOnly: true });
      cleanup.push(() => inspection.close());
      const oldCheckpoint = inspection
        .prepare("SELECT payload FROM general_agent_checkpoints WHERE query_id = ?")
        .get(first.identity.queryId);
      const stale = await f.open(threadId);

      await host.selectModel(target);
      expect(host.context.threadId).toBe(threadId);
      expect(host.context.model.id).toBe(target);
      expect(host.context.toolsMode).toBe("read-only");
      expect(await stores.history.read(threadId)).toEqual(before);
      expect(await stores.bindings.read(threadId)).toEqual({
        ...original,
        schemaVersion: 3,
        generation: 1,
        modelHistoryStart: before.messages.length,
        model:
          target === "b"
            ? { providerId: "openai-responses", modelId: target }
            : { providerId: "anthropic-messages", modelId: target },
        connectionFingerprint: expect.any(String),
      });
      expect(await host.sessions()).toEqual([
        expect.objectContaining({ id: threadId, modelId: target }),
      ]);
      const callsBeforeStale = f.requests.length;
      await expect((await stale.run("stale writer")).completed).rejects.toMatchObject({
        code: "HOST_BINDING_CHANGED",
      });
      expect(f.requests).toHaveLength(callsBeforeStale);
      await host.close();

      const reopened = await f.open(threadId);
      expect(reopened.context.model.id).toBe(target);
      expect((await (await reopened.run("Continue with the new model")).completed).status).toBe(
        "completed",
      );
      const targetRequests = f.requests.filter(({ selection }) => selection.modelId === target);
      const prior = targetRequests[0]!.request.messages.slice(1, 1 + before.messages.length);
      expect(prior).toEqual(
        before.messages.map((message) =>
          message.role === "assistant"
            ? {
                role: "assistant",
                content: message.content.filter((part) => part.type !== "reasoning"),
              }
            : message,
        ),
      );
      const ownAssistant = targetRequests[1]!.request.messages.find(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (part) => part.type === "tool-call" && part.callId === `call-${target}`,
          ),
      );
      expect(ownAssistant).toEqual(
        call({
          providerId: target === "b" ? "openai-responses" : "anthropic-messages",
          modelId: target,
        }).message,
      );
      const after = await stores.history.read(threadId);
      expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
      expect(
        inspection
          .prepare("SELECT payload FROM general_agent_checkpoints WHERE query_id = ?")
          .get(first.identity.queryId),
      ).toEqual(oldCheckpoint);
      const beforeResume = f.requests.length;
      await expect((await reopened.resume(first.identity.queryId)).completed).rejects.toMatchObject(
        { code: "DEFINITION_CHANGED" },
      );
      expect(f.requests).toHaveLength(beforeResume);
    },
  );

  it("drops an old reasoning-only transport message without removing it from authoritative history", async () => {
    const f = await fixture((_request, selection) =>
      selection.modelId === "a"
        ? {
            message: {
              role: "assistant",
              content: [{ type: "reasoning", text: "signed thoughts only" }],
              replayState: {
                providerId: selection.providerId,
                modelId: selection.modelId,
                format: "private",
                version: 1,
                data: "signed",
              },
            },
            finishReason: "stop",
          }
        : answer("new model"),
    );
    const host = await f.open();
    expect((await (await host.run("Think")).completed).status).toBe("completed");
    const stores = f.stores();
    const before = await stores.history.read(host.context.threadId);
    await host.selectModel("b");
    expect((await (await host.run("Answer")).completed).status).toBe("completed");
    const sent = f.requests.at(-1)!.request.messages;
    expect(sent.every((message) => message.content.length > 0)).toBe(true);
    expect(sent.filter((message) => message.role === "user")).toHaveLength(2);
    expect(
      (await stores.history.read(host.context.threadId)).messages.slice(0, before.messages.length),
    ).toEqual(before.messages);
  });

  it("keeps A usable and its binding unchanged when preparing B fails", async () => {
    const f = await fixture((_request, selection) => answer(selection.modelId), {
      failBinding: () => true,
    });
    const host = await f.open();
    const stores = f.stores();
    const before = await stores.bindings.read(host.context.threadId);
    await expect(host.selectModel("b")).rejects.toThrow("B not ready");
    expect(host.context.model.id).toBe("a");
    expect(await stores.bindings.read(host.context.threadId)).toEqual(before);
    expect((await (await host.run("Still A")).completed).status).toBe("completed");
    expect(f.requests.map(({ selection }) => selection.modelId)).toEqual(["a"]);
  });

  it("restores A after another window acquires a writer between preparation and the binding CAS", async () => {
    const closingA = Promise.withResolvers<void>();
    const finishClose = Promise.withResolvers<void>();
    const writerEntered = Promise.withResolvers<void>();
    const finishWriter = Promise.withResolvers<void>();
    let held = false;
    const f = await fixture(
      async (request, selection) => {
        if (
          request.messages.some(
            (message) =>
              message.role === "user" &&
              message.content.some(
                (part) => part.type === "text" && part.text === "held competing A",
              ),
          )
        ) {
          writerEntered.resolve();
          await finishWriter.promise;
        }
        return answer(selection.modelId);
      },
      {
        async beforeDispose() {
          if (held) return;
          held = true;
          closingA.resolve();
          await finishClose.promise;
        },
      },
    );
    const host = await f.open();
    const other = await f.open(host.context.threadId);
    const stores = f.stores();
    const original = await stores.bindings.read(host.context.threadId);
    const selecting = host.selectModel("b");
    const rejected = expect(selecting).rejects.toMatchObject({ code: "HOST_THREAD_PENDING" });
    await closingA.promise;
    const competing = await other.run("held competing A");
    await writerEntered.promise;
    finishClose.resolve();
    await rejected;
    expect(host.context.model.id).toBe("a");
    expect(await stores.bindings.read(host.context.threadId)).toEqual(original);
    finishWriter.resolve();
    expect((await competing.completed).status).toBe("completed");
    expect((await (await host.run("A after lost CAS")).completed).status).toBe("completed");
    expect(f.requests.map(({ selection }) => selection.modelId)).toEqual(["a", "a"]);
  });

  it("does not commit B when closing A fails, and recreates a usable A", async () => {
    let failures = 1;
    const f = await fixture((_request, selection) => answer(selection.modelId), {
      failDispose: () => failures-- > 0,
    });
    const host = await f.open();
    const stores = f.stores();
    const original = await stores.bindings.read(host.context.threadId);
    await expect(host.selectModel("b")).rejects.toMatchObject({ code: "HOST_CLOSE_FAILED" });
    expect(host.context.model.id).toBe("a");
    expect(await stores.bindings.read(host.context.threadId)).toEqual(original);
    expect((await (await host.run("A after close failure")).completed).status).toBe("completed");
    expect(f.requests.map(({ selection }) => selection.modelId)).toEqual(["a"]);
  });

  it("keeps v2 waiting resumable on A, refuses switching, and preserves the original budget and binding", async () => {
    const f = await fixture((request, selection) =>
      request.messages.some((message) => message.role === "tool")
        ? answer("approved on A")
        : call(selection, "write"),
    );
    const host = await f.openV2("read-write");
    const run = await host.run("Write after approval");
    const waiting = await run.completed;
    expect(waiting.status).toBe("waiting");
    if (waiting.status !== "waiting") throw new Error("Expected approval.");
    const threadId = host.context.threadId;
    const stores = f.stores();
    const checkpoint = await stores.checkpoints.findUnfinished("cli-agent", threadId);
    const binding = await stores.bindings.read(threadId);
    expect(binding?.schemaVersion).toBe(2);
    await expect(host.selectModel("b")).rejects.toMatchObject({ code: "HOST_THREAD_PENDING" });
    expect(f.prepared).toEqual(["a", "a"]);
    expect(f.requests).toHaveLength(1);
    expect(await stores.bindings.read(threadId)).toEqual(binding);
    expect(await stores.checkpoints.findUnfinished("cli-agent", threadId)).toEqual(checkpoint);
    await host.close();
    const reopened = await f.open(threadId);
    await expect(reopened.selectModel("b")).rejects.toMatchObject({ code: "HOST_THREAD_PENDING" });
    const response = reopened.answerInteraction(
      waiting.interaction,
      "allow",
      waiting.interaction.id,
    );
    expect((await (await reopened.resume(run.identity.queryId, response)).completed).status).toBe(
      "completed",
    );
    expect(await readFile(join(f.workspace, "created.txt"), "utf8")).toBe("approved only");
    expect(await stores.bindings.read(threadId)).toEqual(binding);
    expect(f.requests.map(({ selection }) => selection.modelId)).toEqual(["a", "a"]);
  });

  it("rejects local running, remote running and persisted interrupted queries without extra model calls", async () => {
    const entered = Promise.withResolvers<void>();
    const f = await fixture(async (_request, _selection, signal) => {
      entered.resolve();
      const stopped = Promise.withResolvers<never>();
      if (signal.aborted) stopped.reject(signal.reason);
      else signal.addEventListener("abort", () => stopped.reject(signal.reason), { once: true });
      return stopped.promise;
    });
    const host = await f.open();
    const threadId = host.context.threadId;
    const other = await f.open(threadId);
    const run = await host.run("Held running query");
    await entered.promise;
    await expect(host.selectModel("b")).rejects.toMatchObject({ code: "HOST_BUSY" });
    await expect(other.selectModel("b")).rejects.toMatchObject({ code: "HOST_THREAD_PENDING" });
    expect(f.prepared).toEqual(["a", "a"]);
    await host.close();
    expect((await run.completed).status).toBe("interrupted");
    const reopened = await f.open(threadId);
    await expect(reopened.selectModel("b")).rejects.toMatchObject({ code: "HOST_THREAD_PENDING" });
    expect(f.requests).toHaveLength(1);
    expect(f.prepared).toEqual(["a", "a", "a"]);
  });
});
