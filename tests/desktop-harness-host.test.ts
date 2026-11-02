import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentConfiguration } from "@agent-harness/configuration/configuration";
import type { ModelRequest, ModelResponse } from "@agent-harness/core/model/model-contract";
import type { JsonObject } from "@agent-harness/core/protocol-values";
import type { createModelProvider } from "@agent-harness/models/models";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DesktopHarnessHost,
  type DesktopHostOptions,
  desktopError,
} from "../app/main/agent-host/desktop-host";
import { registerDesktopHarnessIpc } from "../app/main/agent-host/ipc";
import { createRecentWorkspaces } from "../app/main/agent-host/workspaces";
import type { HarnessDesktopEvent, HarnessSnapshot } from "../app/shared/harness-ipc";
import * as nodeHostModule from "../cli/host/node-host";
import { createNodeHost } from "../cli/host/node-host";
import { readHostCheckpoint } from "../cli/host/session-directory";
import { createSqliteAgentStores } from "../cli/host/sqlite-agent-stores";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const text = (value: string): ModelResponse => ({
  message: { role: "assistant", content: [{ type: "text", text: value }] },
  finishReason: "stop",
});
const readCall: ModelResponse = {
  message: {
    role: "assistant",
    content: [
      { type: "tool-call", callId: "read-private", name: "read", input: { path: "private.txt" } },
    ],
    replayState: {
      providerId: "openai-responses",
      modelId: "fixture",
      format: "fixture",
      version: 1,
      data: "private-replay",
    },
  },
  finishReason: "tool-calls",
};

async function fixture(
  respond: (request: ModelRequest, signal: AbortSignal) => ModelResponse | Promise<ModelResponse>,
  configured = true,
) {
  const root = await mkdtemp(join(tmpdir(), "desktop-harness-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other-workspace");
  await mkdir(workspace);
  await mkdir(otherWorkspace);
  await writeFile(join(workspace, "private.txt"), "private-tool-output", "utf8");
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
  if (configured)
    await configuration.management.saveVendor({
      vendor: {
        id: "local",
        kind: "custom",
        label: "Local controlled model",
        protocol: "openai",
        baseURL: "http://127.0.0.1:1/v1",
        enabled: true,
        models: [
          {
            id: "model",
            name: "Fixture",
            model: "fixture",
            openaiApiMode: "responses",
            enabled: true,
          },
          {
            id: "next-model",
            name: "Next fixture",
            model: "fixture-next",
            openaiApiMode: "responses",
            enabled: true,
          },
        ],
      },
      credential: { type: "replace", apiKey: "private-credential" },
    });
  const requests: ModelRequest[] = [];
  const requestModels: string[] = [];
  const provider: typeof createModelProvider = async (options) => ({
    adapterId: options.adapterId,
    dispose: async () => undefined,
    create: async (selection) => ({
      dispose: async () => undefined,
      client: {
        selection,
        capabilities: { streaming: true, toolCalls: true, reasoning: false, images: false },
        generate: async (request, signal) => {
          requests.push(request);
          requestModels.push(selection.modelId);
          return respond(request, signal);
        },
        async *stream(request, signal) {
          requests.push(request);
          requestModels.push(selection.modelId);
          const response = await respond(request, signal);
          // Both public channels describe the same text. Desktop must not display it twice.
          for (const [index, part] of response.message.content.entries()) {
            if (part.type !== "text") continue;
            yield { type: "text-preview", previewId: `preview-${index}`, delta: part };
            yield { type: "content-delta", index, delta: part };
          }
          yield { type: "completed", response };
        },
      },
    }),
  });
  const dataRoot = join(root, "harness");
  const workspaces = createRecentWorkspaces(dataRoot);
  function open(
    options: Partial<
      Pick<DesktopHostOptions, "chooseDirectory" | "createHost" | "workspaces">
    > = {},
  ) {
    const events: HarnessDesktopEvent[] = [];
    const waiters: Array<{
      predicate: (snapshot: HarnessSnapshot) => boolean;
      resolve: (snapshot: HarnessSnapshot) => void;
    }> = [];
    const host = new DesktopHarnessHost({
      dataRoot,
      configuration,
      workspaces,
      chooseDirectory: async () => workspace,
      createHost: (options) => createNodeHost({ ...options, createProvider: provider }),
      ...options,
      emit: (event) => {
        events.push(event);
        if (event.type !== "snapshot") return;
        for (const waiter of [...waiters]) {
          if (waiter.predicate(event.snapshot)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(event.snapshot);
          }
        }
      },
    });
    cleanup.push(() => host.close());
    return {
      host,
      events,
      waitFor(predicate: (snapshot: HarnessSnapshot) => boolean): Promise<HarnessSnapshot> {
        const existing = [...events]
          .reverse()
          .find((event) => event.type === "snapshot" && predicate(event.snapshot));
        if (existing?.type === "snapshot") return Promise.resolve(existing.snapshot);
        const pending = Promise.withResolvers<HarnessSnapshot>();
        waiters.push({ predicate, resolve: pending.resolve });
        return pending.promise;
      },
    };
  }
  function openWithReadApproval(options: Parameters<typeof open>[0] = {}) {
    return open({
      ...options,
      createHost: (hostOptions) =>
        createNodeHost({ ...hostOptions, createProvider: provider, requireReadApproval: true }),
    });
  }
  return {
    root,
    workspace,
    otherWorkspace,
    dataRoot,
    configuration,
    workspaces,
    requests,
    requestModels,
    provider,
    open,
    openWithReadApproval,
  };
}

function selected(snapshot: HarnessSnapshot): string {
  if (!snapshot.selectedSessionId) throw new Error("Expected selected session");
  return snapshot.selectedSessionId;
}

describe("desktop Harness consumer boundary", () => {
  it("opens settings and snapshots without a model, and stores default selection in the shared CLI configuration", async () => {
    const f = await fixture(() => text("unused"), false);
    const { host } = f.open();
    expect(await host.snapshot()).toMatchObject({
      models: [],
      sessions: [],
      workspace: null,
      status: "idle",
    });
    await expect(stat(join(f.dataRoot, "sessions.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await host.chooseWorkspace();
    await expect(host.newSession({ modelId: "missing", toolsMode: "none" })).rejects.toMatchObject({
      code: "CLI_MODEL_UNAVAILABLE",
    });
  });

  it("executes ordinary conversation with no tools, safe history and exactly one temporary text preview", async () => {
    const f = await fixture(() => text("public answer"));
    const { host, events, waitFor } = f.open();
    await host.chooseWorkspace();
    await host.setDefaultModel("model");
    expect((await f.configuration.management.getSnapshot())?.settings.cli?.defaultModelId).toBe(
      "model",
    );
    const session = await host.newSession({ modelId: "model", toolsMode: "none" });
    await host.run({ sessionId: selected(session), text: "hello" });
    const completed = await waitFor((snapshot) => snapshot.status === "completed");
    expect(f.requests[0]?.tools ?? []).toEqual([]);
    expect(completed.sessions.find((entry) => entry.id === selected(session))?.history).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "public answer" },
    ]);
    expect(events.filter((event) => event.type === "text.delta")).toHaveLength(1);
    const firstText = events.findIndex((event) => event.type === "text.delta");
    expect(events.slice(0, firstText)).toContainEqual(
      expect.objectContaining({
        type: "snapshot",
        snapshot: expect.objectContaining({
          status: "running",
          activeRun: expect.objectContaining({ threadId: selected(session) }),
        }),
      }),
    );
    expect(JSON.stringify(events)).not.toContain("private-credential");
    await expect(
      host.resume({ sessionId: selected(session), queryId: "terminal-query" }),
    ).rejects.toMatchObject({ code: "STALE_QUERY" });
  });

  it("switches the same idle session through NodeHost, preserving canonical tool/replay history and restart selection", async () => {
    const f = await fixture((request) =>
      request.messages.some((message) => message.role === "tool")
        ? text("read complete")
        : readCall,
    );
    const first = f.open();
    const workspace = (await first.host.chooseWorkspace()).workspace!;
    const sessionId = selected(
      await first.host.newSession({ modelId: "model", toolsMode: "read-only" }),
    );
    await first.host.run({ sessionId, text: "Read private.txt" });
    const completed = await first.waitFor((snapshot) => snapshot.status === "completed");
    const history = completed.sessions.find((session) => session.id === sessionId)!.history;
    const checkpoint = await readHostCheckpoint(f.dataRoot, f.workspace, sessionId);
    const stores = createSqliteAgentStores(join(f.dataRoot, "sessions.sqlite"));
    cleanup.push(() => stores.dispose());
    const canonical = await stores.history.read(sessionId);
    const switched = await first.host.selectModel({ sessionId, modelId: "next-model" });
    expect(switched).toMatchObject({
      selectedSessionId: sessionId,
      selectedModelId: "next-model",
      toolsMode: "read-only",
      status: "completed",
    });
    expect(switched.sessions).toHaveLength(1);
    expect(switched.sessions[0]).toMatchObject({ id: sessionId, modelId: "next-model", history });
    expect(await readHostCheckpoint(f.dataRoot, f.workspace, sessionId)).toEqual(checkpoint);
    expect(await stores.history.read(sessionId)).toEqual(canonical);
    expect(first.events).toContainEqual({ type: "snapshot", snapshot: switched });
    await expect(
      first.host.resume({ sessionId, queryId: checkpoint!.queryId }),
    ).rejects.toMatchObject({ code: "STALE_QUERY" });
    await first.host.close();
    const reopened = f.open();
    await reopened.host.selectWorkspace(workspace.id);
    const restored = await reopened.host.selectSession(sessionId);
    expect(restored).toMatchObject({ selectedSessionId: sessionId, selectedModelId: "next-model" });
    expect(restored.sessions[0]?.history).toEqual(history);
    await reopened.host.run({ sessionId, text: "Continue with the new model" });
    await reopened.waitFor(
      (snapshot) =>
        snapshot.status === "completed" && snapshot.sessions[0]!.history.length > history.length,
    );
    expect(f.requestModels).toEqual(["fixture", "fixture", "fixture-next"]);
    expect(
      f.requests[2]!.messages.filter((message) => message.role !== "system").slice(
        0,
        canonical.messages.length,
      ),
    ).toEqual(
      canonical.messages.map((message) =>
        message.role === "assistant"
          ? {
              role: message.role,
              content: message.content.filter((part) => part.type !== "reasoning"),
            }
          : message,
      ),
    );
    expect(
      (await stores.history.read(sessionId)).messages.slice(0, canonical.messages.length),
    ).toEqual(canonical.messages);
    expect(canonical.messages).toContainEqual(readCall.message);
    expect(JSON.stringify(f.requests[2]!.messages)).not.toContain("private-replay");
    expect(JSON.stringify(f.requests[2]!.messages)).toContain("private-tool-output");
    expect(JSON.stringify(switched)).not.toContain("private-credential");
    expect(JSON.stringify(switched)).not.toContain("private-replay");
  });

  it("failed model preparation keeps the original session, binding and model usable", async () => {
    const f = await fixture(() => text("original model still works"));
    const { host, waitFor } = f.open({
      createHost: (options) =>
        createNodeHost({
          ...options,
          createProvider: async (providerOptions, signal) => {
            const provider = await f.provider(providerOptions, signal);
            return {
              ...provider,
              create: async (selection, signal) => {
                if (selection.modelId === "fixture-next") throw new Error("private-sdk-credential");
                return provider.create(selection, signal);
              },
            };
          },
        }),
    });
    await host.chooseWorkspace();
    const sessionId = selected(await host.newSession({ modelId: "model", toolsMode: "none" }));
    const stores = createSqliteAgentStores(join(f.dataRoot, "sessions.sqlite"));
    cleanup.push(() => stores.dispose());
    const binding = await stores.bindings.read(sessionId);
    await expect(
      host.selectModel({ sessionId: "stale-session", modelId: "next-model" }),
    ).rejects.toMatchObject({ code: "STALE_SESSION" });
    await expect(host.selectModel({ sessionId, modelId: "missing" })).rejects.toMatchObject({
      code: "CLI_MODEL_UNAVAILABLE",
    });
    await expect(host.selectModel({ sessionId, modelId: "next-model" })).rejects.toBeDefined();
    expect(await stores.bindings.read(sessionId)).toEqual(binding);
    expect(await host.snapshot()).toMatchObject({
      selectedSessionId: sessionId,
      selectedModelId: "model",
      status: "idle",
    });
    await host.run({ sessionId, text: "Still using the original model" });
    await waitFor((snapshot) => snapshot.status === "completed");
    expect(f.requestModels).toEqual(["fixture"]);
  });

  it("independently blocks a waiting checkpoint before invoking NodeHost.selectModel", async () => {
    const f = await fixture(() => readCall);
    const selectModel = vi.fn();
    const { host, waitFor } = f.open({
      createHost: (options) => {
        const node = createNodeHost({
          ...options,
          createProvider: f.provider,
          requireReadApproval: true,
        });
        selectModel.mockImplementation(node.selectModel.bind(node));
        node.selectModel = selectModel;
        return node;
      },
    });
    await host.chooseWorkspace();
    const sessionId = selected(await host.newSession({ modelId: "model", toolsMode: "read-only" }));
    await host.run({ sessionId, text: "Read private.txt" });
    const waiting = await waitFor((snapshot) => snapshot.status === "waiting");
    const checkpoint = await readHostCheckpoint(f.dataRoot, f.workspace, sessionId);
    await expect(host.selectModel({ sessionId, modelId: "next-model" })).rejects.toMatchObject({
      code: "HOST_QUERY_UNFINISHED",
    });
    expect(selectModel).not.toHaveBeenCalled();
    expect(await readHostCheckpoint(f.dataRoot, f.workspace, sessionId)).toEqual(checkpoint);
    expect(await host.snapshot()).toMatchObject({
      selectedSessionId: sessionId,
      selectedModelId: "model",
      pendingApproval: waiting.pendingApproval,
      status: "waiting",
    });
    expect(f.requestModels).toEqual(["fixture"]);
  });

  it("derives the desktop title from the first persisted request and keeps it across turns and host restarts", async () => {
    const f = await fixture(() => text("public answer"));
    const first = f.open();
    const workspace = (await first.host.chooseWorkspace()).workspace!;
    const created = await first.host.newSession({ modelId: "model", toolsMode: "none" });
    const sessionId = selected(created);
    expect(created.sessions.find((session) => session.id === sessionId)?.label).toBe("新会话");

    const prompt = " \n 请分析\t🧑‍💻 Agent\u3000架构与长期维护，\n 不要生成 PPT。  ";
    const title = "请分析 🧑‍💻 Agent 架构与长期维护， 不要生成 PPT。";
    await first.host.run({ sessionId, text: prompt });
    const completed = await first.waitFor((snapshot) => snapshot.status === "completed");
    expect(completed.sessions.find((session) => session.id === sessionId)?.label).toBe(title);

    await first.host.run({ sessionId, text: "第二轮：现在讨论测试策略" });
    const secondTurn = await first.waitFor(
      (snapshot) =>
        snapshot.status === "completed" &&
        snapshot.sessions
          .find((session) => session.id === sessionId)
          ?.history.filter((entry) => entry.role === "user").length === 2,
    );
    expect(secondTurn.sessions.find((session) => session.id === sessionId)?.label).toBe(title);
    expect(f.requests).toHaveLength(2);
    await first.host.close();

    const restarted = f.open();
    const directory = await restarted.host.selectWorkspace(workspace.id);
    expect(directory.sessions.find((session) => session.id === sessionId)?.label).toBe(title);
    const reopened = await restarted.host.selectSession(sessionId);
    expect(reopened.sessions.find((session) => session.id === sessionId)).toMatchObject({
      label: title,
      history: secondTurn.sessions.find((session) => session.id === sessionId)?.history,
    });
    expect(f.requests).toHaveLength(2);
  });

  it("keeps a delayed snapshot on its captured workspace/session and below the newer workspace revision", async () => {
    const f = await fixture(() => text("answer"));
    const { host, waitFor } = f.open();
    const originalWorkspace = (await host.chooseWorkspace()).workspace!;
    const sessionId = selected(await host.newSession({ modelId: "model", toolsMode: "none" }));
    await host.run({ sessionId, text: "hello" });
    await waitFor((snapshot) => snapshot.status === "completed");
    const other = await f.workspaces.remember(f.otherWorkspace);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const getSnapshot = f.configuration.management.getSnapshot.bind(f.configuration.management);
    vi.spyOn(f.configuration.management, "getSnapshot").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return getSnapshot();
    });
    const delayed = host.snapshot();
    await entered.promise;
    let newer: HarnessSnapshot;
    try {
      newer = await host.selectWorkspace(other.id);
    } finally {
      release.resolve();
    }
    const older = await delayed;
    expect(newer.workspace?.id).toBe(other.id);
    expect(newer.selectedSessionId).toBeNull();
    expect(newer.sessions).toEqual([]);
    expect(older.workspace?.id).toBe(originalWorkspace.id);
    expect(older.selectedSessionId).toBe(sessionId);
    expect(older.selectedModelId).toBe("model");
    expect(older.status).toBe("completed");
    expect(older.sessions.some((session) => session.id === sessionId)).toBe(true);
    expect(older.revision).toBeLessThan(newer.revision);
  });

  it.each<{ name: string; input: JsonObject; expected: string }>([
    { name: "read", input: { path: "private.txt" }, expected: "private-tool-output" },
    { name: "glob", input: { pattern: "*.txt" }, expected: "private.txt" },
    {
      name: "grep",
      input: { pattern: "private-tool-output", glob: "*.txt" },
      expected: "private-tool-output",
    },
  ])(
    "runs workspace $name without an approval prompt by default",
    async ({ name, input, expected }) => {
      const f = await fixture((request) =>
        request.messages.some((message) => message.role === "tool")
          ? text("read complete")
          : {
              message: {
                role: "assistant",
                content: [{ type: "tool-call", callId: "workspace-read", name, input }],
              },
              finishReason: "tool-calls",
            },
      );
      const { host, events, waitFor } = f.open();
      await host.chooseWorkspace();
      const sessionId = selected(
        await host.newSession({ modelId: "model", toolsMode: "read-only" }),
      );
      await host.run({ sessionId, text: "Inspect the workspace" });
      await waitFor((snapshot) => snapshot.status === "completed");
      expect(
        events.some(
          (event) => event.type === "snapshot" && event.snapshot.pendingApproval !== null,
        ),
      ).toBe(false);
      const results = f.requests[1]!.messages.filter((message) => message.role === "tool");
      expect(JSON.stringify(results)).toContain(expected);
      expect(await readHostCheckpoint(f.dataRoot, f.workspace, sessionId)).toMatchObject({
        status: "completed",
      });
    },
  );

  it("restores persisted approvals after restart and exposes only the safe approved tool preview", async () => {
    const f = await fixture((request) =>
      request.messages.some((message) => message.role === "tool")
        ? text("read complete")
        : readCall,
    );
    const first = f.openWithReadApproval();
    const workspace = (await first.host.chooseWorkspace()).workspace!;
    const sessionId = selected(
      await first.host.newSession({ modelId: "model", toolsMode: "read-only" }),
    );
    await first.host.run({ sessionId, text: "Read private.txt" });
    const waiting = await first.waitFor((snapshot) => snapshot.status === "waiting");
    expect(waiting.pendingApproval).toMatchObject({
      supported: true,
      choices: [{ id: "allow" }, { id: "reject" }],
    });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.tools?.map((tool) => tool.name)).not.toContain("write");
    expect(JSON.stringify(waiting)).not.toContain("private-tool-output");
    expect(waiting.sessions.find((session) => session.id === sessionId)!.history).toEqual([
      { role: "user", text: "Read private.txt" },
    ]);
    expect(
      first.events
        .filter((event) => event.type === "tool.status")
        .every(
          (event) =>
            event.type === "tool.status" &&
            event.status === "dispatched" &&
            event.error === undefined,
        ),
    ).toBe(true);
    await first.host.close();

    const restarted = f.open();
    await restarted.host.selectWorkspace(workspace.id);
    const restored = await restarted.host.selectSession(sessionId);
    expect(restored.pendingApproval).toEqual(waiting.pendingApproval);
    expect(restored.sessions.find((session) => session.id === sessionId)!.history).toEqual([
      { role: "user", text: "Read private.txt" },
    ]);
    const approval = restored.pendingApproval!;
    await expect(
      restarted.host.resume({
        sessionId,
        queryId: approval.queryId,
        interactionId: "stale",
        choiceId: "allow",
      }),
    ).rejects.toMatchObject({ code: "STALE_INTERACTION" });
    expect(f.requests).toHaveLength(1);
    await restarted.host.resume({
      sessionId,
      queryId: approval.queryId,
      interactionId: approval.interactionId,
      choiceId: "allow",
    });
    const completed = await restarted.waitFor((snapshot) => snapshot.status === "completed");
    expect(JSON.stringify(f.requests[1])).toContain("private-tool-output");
    expect(restarted.events).toContainEqual(
      expect.objectContaining({
        type: "tool.status",
        status: "completed",
        effects: "none",
        display: expect.objectContaining({ title: "private.txt", output: ["private-tool-output"] }),
      }),
    );
    expect(JSON.stringify(restarted.events)).not.toContain("private-replay");
    expect(completed.pendingApproval).toBeNull();
    expect(restarted.events).toContainEqual(
      expect.objectContaining({ type: "tool.status", status: "completed", name: "read" }),
    );
    const freshSessionId = selected(
      await restarted.host.newSession({ modelId: "model", toolsMode: "read-only" }),
    );
    await restarted.host.run({ sessionId: freshSessionId, text: "Read private.txt" });
    await restarted.waitFor(
      (snapshot) =>
        snapshot.selectedSessionId === freshSessionId && snapshot.status === "completed",
    );
    expect(
      restarted.events.some(
        (event) =>
          event.type === "snapshot" &&
          event.snapshot.selectedSessionId === freshSessionId &&
          event.snapshot.pendingApproval !== null,
      ),
    ).toBe(false);
    expect(JSON.stringify(f.requests[3])).toContain("private-tool-output");
    const other = await f.workspaces.remember(f.otherWorkspace);
    await restarted.host.selectWorkspace(other.id);
    await expect(restarted.host.selectSession(sessionId)).rejects.toMatchObject({
      code: "HOST_SESSION_NOT_FOUND",
    });
    expect((await restarted.host.sessions()).some((entry) => entry.id === sessionId)).toBe(false);
  });

  it("sends the real approved read preview through IPC live, settled history and a reopened host without rereading changed files", async () => {
    const f = await fixture((request) =>
      request.messages.some((message) => message.role === "tool")
        ? text("read complete")
        : readCall,
    );
    const original = `approved-${randomUUID()}`;
    await writeFile(join(f.workspace, "private.txt"), original, "utf8");
    const createHost = nodeHostModule.createNodeHost;
    vi.spyOn(nodeHostModule, "createNodeHost").mockImplementation((options) =>
      createHost({ ...options, createProvider: f.provider, requireReadApproval: true }),
    );
    function connect() {
      const handlers = new Map<
        string,
        (event: IpcMainInvokeEvent, argument?: unknown) => unknown
      >();
      const events: HarnessDesktopEvent[] = [];
      const waiters: Array<{
        predicate: (snapshot: HarnessSnapshot) => boolean;
        resolve: (snapshot: HarnessSnapshot) => void;
      }> = [];
      const mainFrame = { url: "file:///trusted/index.html" };
      const sender = {
        id: 1,
        mainFrame,
        isDestroyed: () => false,
        send: (channel: string, event: HarnessDesktopEvent) => {
          expect(channel).toBe("harness:event");
          events.push(structuredClone(event));
          if (event.type !== "snapshot") return;
          for (const waiter of [...waiters]) {
            if (!waiter.predicate(event.snapshot)) continue;
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(event.snapshot);
          }
        },
      };
      const trusted = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
      const registration = registerDesktopHarnessIpc({
        ipcMain: {
          handle: (channel, handler) => {
            handlers.set(channel, handler);
          },
          removeHandler: (channel) => {
            handlers.delete(channel);
          },
        },
        configuration: f.configuration,
        dataRoot: f.dataRoot,
        assertTrusted: (event) => {
          if (event.sender !== trusted.sender || event.senderFrame !== mainFrame)
            throw new Error("untrusted");
        },
        chooseDirectory: async () => f.workspace,
      });
      cleanup.push(() => registration.close());
      const ready = registration.documentCommitted(sender.id);
      return {
        registration,
        events,
        async invoke<T>(method: string, argument?: unknown): Promise<T> {
          await ready;
          const reply = (await handlers.get(`harness:${method}`)!(trusted, argument)) as {
            ok: boolean;
            value: T;
            error?: unknown;
          };
          expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
          return reply.value;
        },
        waitFor(predicate: (snapshot: HarnessSnapshot) => boolean): Promise<HarnessSnapshot> {
          const existing = events.findLast(
            (event) => event.type === "snapshot" && predicate(event.snapshot),
          );
          if (existing?.type === "snapshot") return Promise.resolve(existing.snapshot);
          const pending = Promise.withResolvers<HarnessSnapshot>();
          waiters.push({ predicate, resolve: pending.resolve });
          return pending.promise;
        },
      };
    }
    const first = connect();
    const workspace = (await first.invoke<HarnessSnapshot>("chooseWorkspace")).workspace!;
    const sessionId = selected(
      await first.invoke<HarnessSnapshot>("newSession", {
        modelId: "model",
        toolsMode: "read-only",
      }),
    );
    await first.invoke("run", { sessionId, text: "Read private.txt" });
    const waiting = await first.waitFor((snapshot) => snapshot.status === "waiting");
    expect(JSON.stringify(waiting)).not.toContain(original);
    await first.invoke("resume", {
      sessionId,
      queryId: waiting.pendingApproval!.queryId,
      interactionId: waiting.pendingApproval!.interactionId,
      choiceId: "allow",
    });
    const completed = await first.waitFor((snapshot) => snapshot.status === "completed");
    const live = first.events.find(
      (event) => event.type === "tool.status" && event.status === "completed",
    );
    expect(live).toMatchObject({
      effects: "none",
      step: 1,
      invocationIdentity: expect.objectContaining({ threadId: sessionId }),
      display: { title: "private.txt", input: ["offset: 0", "limit: 4000"], output: [original] },
    });
    const history = completed.sessions.find((session) => session.id === sessionId)!.history;
    const tool = history.find((entry) => entry.role === "tool");
    expect(tool).toMatchObject({
      tool: {
        status: "completed",
        effects: "none",
        result: "recorded",
        step: 1,
        display: { output: [original] },
      },
    });
    if (live?.type !== "tool.status" || tool?.role !== "tool")
      throw new Error("Expected tool facts");
    expect(tool.tool.identity).toEqual(live.invocationIdentity);
    expect(tool.tool.display).toEqual(live.display);
    expect(JSON.stringify(first.events)).not.toContain("private-replay");
    expect(JSON.stringify(first.events)).not.toContain("private-credential");
    await first.registration.close();
    await writeFile(join(f.workspace, "private.txt"), `changed-${randomUUID()}`, "utf8");
    const restarted = connect();
    await restarted.invoke("selectWorkspace", workspace.id);
    const reopened = await restarted.invoke<HarnessSnapshot>("selectSession", sessionId);
    expect(reopened.sessions.find((session) => session.id === sessionId)!.history).toEqual(history);
    expect(f.requests).toHaveLength(2);
  });

  it("keeps approved read errors as failures with safe input context and no raw result fallback", async () => {
    const f = await fixture((request) =>
      request.messages.some((message) => message.role === "tool") ? text("read failed") : readCall,
    );
    const { host, events, waitFor } = f.openWithReadApproval();
    await host.chooseWorkspace();
    const sessionId = selected(await host.newSession({ modelId: "model", toolsMode: "read-only" }));
    await host.run({ sessionId, text: "Read private.txt" });
    const waiting = await waitFor((snapshot) => snapshot.status === "waiting");
    await rm(join(f.workspace, "private.txt"));
    const approval = waiting.pendingApproval!;
    await host.resume({
      sessionId,
      queryId: approval.queryId,
      interactionId: approval.interactionId,
      choiceId: "allow",
    });
    const completed = await waitFor((snapshot) => snapshot.status === "completed");
    const live = events.find((event) => event.type === "tool.status" && event.status === "failed");
    expect(live).toMatchObject({
      effects: "none",
      error: { code: expect.any(String), message: expect.any(String) },
      display: { title: "private.txt", output: [] },
    });
    const tool = completed.sessions
      .find((session) => session.id === sessionId)!
      .history.find((entry) => entry.role === "tool");
    expect(tool).toMatchObject({
      tool: { status: "failed", effects: "none", result: "error", display: { output: [] } },
    });
    if (live?.type !== "tool.status" || tool?.role !== "tool")
      throw new Error("Expected failure facts");
    expect(tool.tool.error).toEqual(live.error);
    expect(Object.keys(live.error!).sort()).toEqual(["code", "message"]);
    expect(JSON.stringify(events)).not.toContain("private-tool-output");
    expect(JSON.stringify(events)).not.toContain("private-replay");
  });

  it.each(["reject", "cancel"] as const)(
    "%s ends a waiting request without exposing file contents",
    async (choice) => {
      const f = await fixture((request) =>
        request.messages.some((message) => message.role === "tool") ? text("denied") : readCall,
      );
      const { host, events, waitFor } = f.openWithReadApproval();
      await host.chooseWorkspace();
      const sessionId = selected(
        await host.newSession({ modelId: "model", toolsMode: "read-only" }),
      );
      await host.run({ sessionId, text: "Read private.txt" });
      const waiting = await waitFor((snapshot) => snapshot.status === "waiting");
      const approval = waiting.pendingApproval!;
      if (choice === "cancel") await host.cancel({ sessionId, queryId: approval.queryId });
      else
        await host.resume({
          sessionId,
          queryId: approval.queryId,
          interactionId: approval.interactionId,
          choiceId: "reject",
        });
      const final = await waitFor(
        (snapshot) => snapshot.status === (choice === "cancel" ? "cancelled" : "completed"),
      );
      expect(final.pendingApproval).toBeNull();
      expect(JSON.stringify(f.requests)).not.toContain("private-tool-output");
      expect(JSON.stringify(events)).not.toContain("private-tool-output");
      await expect(
        host.resume({
          sessionId,
          queryId: approval.queryId,
          interactionId: approval.interactionId,
          choiceId: "allow",
        }),
      ).rejects.toMatchObject({ code: "STALE_QUERY" });
      expect(await readFile(join(f.workspace, "private.txt"), "utf8")).toBe("private-tool-output");
    },
  );

  it("requires an exact persisted approval before writing and leaves rejected writes unapplied", async () => {
    const writeCall: ModelResponse = {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            callId: "write-file",
            name: "write",
            input: { path: "created.txt", content: "private-write-payload", mode: "create" },
          },
        ],
      },
      finishReason: "tool-calls",
    };
    const f = await fixture((request) =>
      request.messages.some((message) => message.role === "tool")
        ? text("write denied")
        : writeCall,
    );
    const { host, events, waitFor } = f.open();
    await host.chooseWorkspace();
    const sessionId = selected(
      await host.newSession({ modelId: "model", toolsMode: "read-write" }),
    );
    await host.run({ sessionId, text: "Create created.txt" });
    const waiting = await waitFor((snapshot) => snapshot.status === "waiting");
    const approval = waiting.pendingApproval!;
    expect(f.requests[0]?.tools?.map((tool) => tool.name)).toContain("write");
    await expect(stat(join(f.workspace, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      host.resume({ sessionId, queryId: approval.queryId, choiceId: "allow" }),
    ).rejects.toMatchObject({ code: "STALE_INTERACTION" });
    await host.resume({
      sessionId,
      queryId: approval.queryId,
      interactionId: approval.interactionId,
      choiceId: "reject",
    });
    await waitFor((snapshot) => snapshot.status === "completed");
    await expect(stat(join(f.workspace, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(events)).not.toContain("private-write-payload");
  });

  it("keeps an approved write's content and applied effects in live and persisted history after cancelling later model work", async () => {
    const entered = Promise.withResolvers<void>();
    const content = `written-${randomUUID()}`;
    const f = await fixture(async (request, signal) => {
      if (!request.messages.some((message) => message.role === "tool"))
        return {
          message: {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                callId: "write-applied",
                name: "write",
                input: { path: "created.txt", content, mode: "create" },
              },
            ],
          },
          finishReason: "tool-calls",
        };
      entered.resolve();
      if (signal.aborted) throw signal.reason;
      const aborted = Promise.withResolvers<never>();
      signal.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
      return aborted.promise;
    });
    const first = f.open();
    const workspace = (await first.host.chooseWorkspace()).workspace!;
    const sessionId = selected(
      await first.host.newSession({ modelId: "model", toolsMode: "read-write" }),
    );
    await first.host.run({ sessionId, text: "Create created.txt" });
    const waiting = await first.waitFor((snapshot) => snapshot.status === "waiting");
    expect(JSON.stringify(waiting)).not.toContain(content);
    const approval = waiting.pendingApproval!;
    const run = await first.host.resume({
      sessionId,
      queryId: approval.queryId,
      interactionId: approval.interactionId,
      choiceId: "allow",
    });
    await entered.promise;
    const cancelled = await first.host.cancel({
      sessionId,
      queryId: run.queryId,
      runId: run.runId,
    });
    expect(cancelled.status).toBe("cancelled");
    expect(await readFile(join(f.workspace, "created.txt"), "utf8")).toBe(content);
    expect(first.events).toContainEqual(
      expect.objectContaining({
        type: "tool.status",
        status: "completed",
        effects: "applied",
        display: expect.objectContaining({ title: "created.txt", output: [content] }),
      }),
    );
    const history = cancelled.sessions.find((session) => session.id === sessionId)!.history;
    expect(history).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool: expect.objectContaining({
          status: "completed",
          effects: "applied",
          display: expect.objectContaining({ output: [content] }),
        }),
      }),
    );
    await first.host.close();
    const reopened = f.open();
    await reopened.host.selectWorkspace(workspace.id);
    const snapshot = await reopened.host.selectSession(sessionId);
    expect(snapshot.sessions.find((session) => session.id === sessionId)!.history).toEqual(history);
  });

  it("isolates windows and run identities, rejects workspace switches while running, and interrupts/drains on close", async () => {
    const entered = Promise.withResolvers<void>();
    const f = await fixture(async (_request, signal) => {
      entered.resolve();
      const interruption = Promise.withResolvers<never>();
      if (signal.aborted) throw signal.reason;
      signal.addEventListener("abort", () => interruption.reject(signal.reason), { once: true });
      return interruption.promise;
    });
    const first = f.open();
    const workspace = (await first.host.chooseWorkspace()).workspace!;
    const sessionId = selected(
      await first.host.newSession({ modelId: "model", toolsMode: "none" }),
    );
    const identity = await first.host.run({ sessionId, text: "wait" });
    await entered.promise;
    expect(() => first.host.selectWorkspace(workspace.id)).toThrow(
      expect.objectContaining({ code: "HOST_BUSY" }),
    );
    expect(() => first.host.selectModel({ sessionId, modelId: "next-model" })).toThrow(
      expect.objectContaining({ code: "HOST_BUSY" }),
    );
    await expect(
      first.host.cancel({ sessionId, queryId: identity.queryId, runId: "other-run" }),
    ).rejects.toMatchObject({ code: "STALE_RUN" });
    const second = f.open();
    expect((await second.host.snapshot()).scopeId).not.toBe((await first.host.snapshot()).scopeId);
    await expect(
      second.host.cancel({ sessionId, queryId: identity.queryId, runId: identity.runId }),
    ).rejects.toMatchObject({ code: "STALE_SESSION" });
    expect(second.events).toEqual([]);
    await first.host.close();
    const restarted = f.open();
    await restarted.host.selectWorkspace(workspace.id);
    expect(await restarted.host.selectSession(sessionId)).toMatchObject({
      status: "interrupted",
      activeRun: null,
    });
    await expect(
      restarted.host.selectModel({ sessionId, modelId: "next-model" }),
    ).rejects.toMatchObject({
      code: "HOST_QUERY_UNFINISHED",
    });
  });

  it("keeps SDK exceptions private and gates every IPC method before creating a host", async () => {
    const f = await fixture(() => text("unused"), false);
    const handlers = new Map<string, (event: IpcMainInvokeEvent, argument?: never) => unknown>();
    const selectDirectory = vi.fn(async () => f.workspace);
    const registration = registerDesktopHarnessIpc({
      ipcMain: {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
        removeHandler: (channel) => {
          handlers.delete(channel);
        },
      },
      configuration: f.configuration,
      dataRoot: f.dataRoot,
      assertTrusted: (event) => {
        if (event.sender.id !== 1 || event.senderFrame !== event.sender.mainFrame)
          throw new Error("private credential-bearing SDK error");
      },
      chooseDirectory: selectDirectory,
    });
    cleanup.push(() => registration.close());
    const mainFrame = { url: "file:///trusted/index.html" };
    const sender = { id: 1, mainFrame, isDestroyed: () => false, send: vi.fn() };
    const untrusted = {
      sender,
      senderFrame: { url: mainFrame.url },
    } as unknown as IpcMainInvokeEvent;
    for (const handler of handlers.values()) {
      const reply = await handler(untrusted);
      expect(reply).toMatchObject({ ok: false });
      expect(JSON.stringify(reply)).not.toContain("credential-bearing");
    }
    expect(selectDirectory).not.toHaveBeenCalled();
    expect(desktopError(new Error("secret SDK key"))).toEqual({
      code: "TERMINAL_OPERATION_FAILED",
      message: "The operation failed; private diagnostic details were withheld.",
    });
    const trusted = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
    await registration.documentCommitted(sender.id);
    expect(await handlers.get("harness:snapshot")!(trusted)).toMatchObject({
      ok: true,
      value: { status: "idle" },
    });
  });

  it("routes selectModel through trusted IPC with strict input and current-session identity", async () => {
    const f = await fixture(() => text("unused"));
    const createHost = nodeHostModule.createNodeHost;
    vi.spyOn(nodeHostModule, "createNodeHost").mockImplementation((options) =>
      createHost({ ...options, createProvider: f.provider }),
    );
    const handlers = new Map<string, (event: IpcMainInvokeEvent, argument?: unknown) => unknown>();
    const mainFrame = { url: "file:///trusted/index.html" };
    const sender = { id: 1, mainFrame, isDestroyed: () => false, send: vi.fn() };
    const trusted = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
    const registration = registerDesktopHarnessIpc({
      ipcMain: {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
        removeHandler: (channel) => {
          handlers.delete(channel);
        },
      },
      configuration: f.configuration,
      dataRoot: f.dataRoot,
      assertTrusted: (event) => {
        if (event.sender !== trusted.sender || event.senderFrame !== mainFrame)
          throw new Error("private-sender-diagnostic");
      },
      chooseDirectory: async () => f.workspace,
    });
    cleanup.push(() => registration.close());
    await registration.documentCommitted(sender.id);
    await handlers.get("harness:chooseWorkspace")!(trusted);
    const created = (await handlers.get("harness:newSession")!(trusted, {
      modelId: "model",
      toolsMode: "none",
    })) as { ok: true; value: HarnessSnapshot };
    expect(created.ok).toBe(true);
    const sessionId = selected(created.value);
    const switchModel = handlers.get("harness:selectModel")!;
    const request = { sessionId, modelId: "next-model" };
    const child = { ...trusted, senderFrame: { url: mainFrame.url } };
    const foreign = { ...trusted, sender: { ...sender, id: 2 } };
    for (const event of [child, foreign]) {
      const reply = await switchModel(event as IpcMainInvokeEvent, request);
      expect(reply).toMatchObject({ ok: false });
      expect(JSON.stringify(reply)).not.toContain("private-sender-diagnostic");
    }
    for (const invalid of [
      { modelId: "next-model" },
      { ...request, apiKey: "not-accepted" },
      { ...request, modelId: "" },
    ])
      expect(await switchModel(trusted, invalid)).toMatchObject({ ok: false });
    expect(await switchModel(trusted, { ...request, sessionId: "old-session" })).toMatchObject({
      ok: false,
      error: { code: "STALE_SESSION" },
    });
    expect(await switchModel(trusted, request)).toMatchObject({
      ok: true,
      value: { selectedSessionId: sessionId, selectedModelId: "next-model", toolsMode: "none" },
    });
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain("private-credential");
    await registration.invalidateDocument(sender.id);
    expect(await switchModel(trusted, request)).toMatchObject({
      ok: false,
      error: { code: "HOST_CLOSED" },
    });
  });
});

describe("desktop Harness scope lifetime", () => {
  it("drains a pending picker and rejects its late directory without remembering or opening it", async () => {
    const f = await fixture(() => text("unused"));
    const entered = Promise.withResolvers<void>();
    const directory = Promise.withResolvers<string | undefined>();
    const createHost = vi.fn<NonNullable<DesktopHostOptions["createHost"]>>((options) =>
      createNodeHost({ ...options, createProvider: f.provider }),
    );
    const remember = vi.spyOn(f.workspaces, "remember");
    const { host, events } = f.open({
      createHost,
      chooseDirectory: () => {
        entered.resolve();
        return directory.promise;
      },
    });
    cleanup.push(async () => directory.resolve(undefined));
    const choosing = host.chooseWorkspace();
    const rejected = expect(choosing).rejects.toMatchObject({ code: "HOST_CLOSED" });
    await entered.promise;
    const closing = host.close();
    expect(host.close()).toBe(closing);
    const settled = vi.fn();
    void closing.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    directory.resolve(f.workspace);
    await rejected;
    await closing;
    expect(remember).not.toHaveBeenCalled();
    expect(createHost).not.toHaveBeenCalled();
    expect(await f.workspaces.list()).toEqual([]);
    expect(events).toEqual([]);
    await expect(stat(join(f.dataRoot, "sessions.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("invalidates a directory already awaiting recent-record preparation and keeps the shared directory usable", async () => {
    const f = await fixture(() => text("unused"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const createHost = vi.fn<NonNullable<DesktopHostOptions["createHost"]>>((options) =>
      createNodeHost({ ...options, createProvider: f.provider }),
    );
    const first = f.open({
      createHost,
      workspaces: {
        list: () => f.workspaces.list(),
        remember: async (path, signal) => {
          entered.resolve();
          await release.promise;
          return f.workspaces.remember(path, signal);
        },
      },
    });
    cleanup.push(async () => release.resolve());
    const choosing = first.host.chooseWorkspace();
    const rejected = expect(choosing).rejects.toMatchObject({ code: "HOST_CLOSED" });
    await entered.promise;
    const closing = first.host.close();
    release.resolve();
    await rejected;
    await closing;
    expect(createHost).not.toHaveBeenCalled();
    expect(await f.workspaces.list()).toEqual([]);
    await expect(stat(join(f.dataRoot, "workspaces.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const second = f.open();
    expect((await second.host.chooseWorkspace()).workspace?.path).toBe(f.workspace);
  });

  it("keeps the selected waiting session, permission and original binding on picker cancel or invalid paths", async () => {
    const f = await fixture(() => readCall);
    let path: string | undefined = f.workspace;
    const first = f.openWithReadApproval({ chooseDirectory: async () => path });
    const workspace = (await first.host.chooseWorkspace()).workspace!;
    const sessionId = selected(
      await first.host.newSession({ modelId: "model", toolsMode: "read-only" }),
    );
    await first.host.run({ sessionId, text: "Read private.txt" });
    const waiting = await first.waitFor((snapshot) => snapshot.status === "waiting");
    const stores = createSqliteAgentStores(join(f.dataRoot, "sessions.sqlite"));
    cleanup.push(() => stores.dispose());
    const binding = await stores.bindings.read(sessionId);
    const original = await readHostCheckpoint(f.dataRoot, f.workspace, sessionId);
    path = undefined;
    expect(await first.host.chooseWorkspace()).toMatchObject({
      workspace,
      selectedSessionId: sessionId,
      selectedModelId: waiting.selectedModelId,
      toolsMode: waiting.toolsMode,
      pendingApproval: waiting.pendingApproval,
      status: "waiting",
    });
    path = join(f.root, "missing-directory");
    await expect(first.host.chooseWorkspace()).rejects.toBeDefined();
    expect(await first.host.snapshot()).toMatchObject({
      workspace,
      selectedSessionId: sessionId,
      toolsMode: "read-only",
      pendingApproval: waiting.pendingApproval,
    });
    expect(await f.workspaces.list()).toEqual([workspace]);
    // Direct navigation must not rewrite the waiting Query's original binding.
    path = f.otherWorkspace;
    await first.host.chooseWorkspace();
    expect(await stores.bindings.read(sessionId)).toEqual(binding);
    expect(await readHostCheckpoint(f.dataRoot, f.workspace, sessionId)).toEqual(original);
    expect(f.requests).toHaveLength(1);
  });

  it("drains blocked session initialization without adopting or publishing its late context", async () => {
    const f = await fixture(() => text("unused"));
    const first = f.open();
    await first.host.chooseWorkspace();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    cleanup.push(async () => release.resolve());
    const getSnapshot = f.configuration.management.getSnapshot.bind(f.configuration.management);
    vi.spyOn(f.configuration.management, "getSnapshot").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return getSnapshot();
    });
    const eventCount = first.events.length;
    const creating = first.host.newSession({ modelId: "model", toolsMode: "none" });
    const rejected = expect(creating).rejects.toMatchObject({ code: "HOST_CLOSED" });
    await entered.promise;
    const closing = first.host.close();
    expect(first.host.close()).toBe(closing);
    release.resolve();
    await rejected;
    await closing;
    expect(first.events).toHaveLength(eventCount);
    await expect(stat(join(f.dataRoot, "sessions.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains and drains the observer when close interrupts a blocked running-identity publication", async () => {
    const modelEntered = Promise.withResolvers<void>();
    const f = await fixture(async (_request, signal) => {
      modelEntered.resolve();
      const interrupted = Promise.withResolvers<never>();
      if (signal.aborted) throw signal.reason;
      signal.addEventListener("abort", () => interrupted.reject(signal.reason), { once: true });
      return interrupted.promise;
    });
    const observationEntered = Promise.withResolvers<void>();
    const releaseObservation = Promise.withResolvers<void>();
    const first = f.open({
      createHost: (options) => {
        const node = createNodeHost({ ...options, createProvider: f.provider });
        const run = node.run.bind(node);
        vi.spyOn(node, "run").mockImplementation(async (input) => {
          const handle = await run(input);
          return {
            ...handle,
            events: {
              async *[Symbol.asyncIterator]() {
                try {
                  yield* handle.events;
                } finally {
                  observationEntered.resolve();
                  await releaseObservation.promise;
                }
              },
            },
          };
        });
        return node;
      },
    });
    await first.host.chooseWorkspace();
    const sessionId = selected(
      await first.host.newSession({ modelId: "model", toolsMode: "none" }),
    );
    const publicationEntered = Promise.withResolvers<void>();
    const releasePublication = Promise.withResolvers<void>();
    cleanup.push(async () => {
      releasePublication.resolve();
      releaseObservation.resolve();
    });
    const getSnapshot = f.configuration.management.getSnapshot.bind(f.configuration.management);
    vi.spyOn(f.configuration.management, "getSnapshot").mockImplementationOnce(async () => {
      publicationEntered.resolve();
      await releasePublication.promise;
      return getSnapshot();
    });
    const running = first.host.run({ sessionId, text: "wait during publication" });
    const rejected = expect(running).rejects.toMatchObject({ code: "HOST_CLOSED" });
    await Promise.all([publicationEntered.promise, modelEntered.promise]);
    const eventCount = first.events.length;
    const closing = first.host.close();
    const settled = vi.fn();
    void closing.then(settled);
    releasePublication.resolve();
    await observationEntered.promise;
    await rejected;
    expect(settled).not.toHaveBeenCalled();
    releaseObservation.resolve();
    await closing;
    expect(first.events).toHaveLength(eventCount);
    expect(await readHostCheckpoint(f.dataRoot, f.workspace, sessionId)).toMatchObject({
      status: "interrupted",
    });
  });

  it("drains independent snapshot reads even after another read has already failed", async () => {
    const f = await fixture(() => text("unused"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = f.open({
      workspaces: {
        remember: (path, signal) => f.workspaces.remember(path, signal),
        list: async () => {
          entered.resolve();
          await release.promise;
          return f.workspaces.list();
        },
      },
    });
    cleanup.push(async () => release.resolve());
    vi.spyOn(f.configuration.management, "getSnapshot").mockRejectedValueOnce(
      new Error("private read failure"),
    );
    const reading = first.host.snapshot();
    const rejected = expect(reading).rejects.toMatchObject({ code: "HOST_CLOSED" });
    await entered.promise;
    const closing = first.host.close();
    const settled = vi.fn();
    void closing.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    release.resolve();
    await rejected;
    await closing;
  });

  it("preserves both catalog read and cleanup failures while keeping their details private", async () => {
    const f = await fixture(() => text("unused"));
    const readError = new Error("B_CATALOG_READ_SENTINEL");
    const closeError = new Error("B_CATALOG_CLOSE_SENTINEL");
    const host = new DesktopHarnessHost({
      dataRoot: f.dataRoot,
      configuration: f.configuration,
      workspaces: f.workspaces,
      chooseDirectory: async () => undefined,
      emit: () => undefined,
      createHost: (options) => {
        const node = createNodeHost(options);
        node.models = async () => {
          throw readError;
        };
        const close = node.close.bind(node);
        node.close = async () => {
          await close();
          throw closeError;
        };
        return node;
      },
    });
    cleanup.push(() => host.close().catch(() => undefined));
    const error = await host.models().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([readError, closeError]);
    expect(JSON.stringify(desktopError(error))).not.toContain("SENTINEL");
    await expect(host.close()).rejects.toMatchObject({ code: "HOST_CLOSE_FAILED" });
  });

  it("aggregates safe host and observer close failures while duplicate close keeps the same rejection", async () => {
    const entered = Promise.withResolvers<void>();
    const f = await fixture(async (_request, signal) => {
      entered.resolve();
      const interrupted = Promise.withResolvers<never>();
      if (signal.aborted) throw signal.reason;
      signal.addEventListener("abort", () => interrupted.reject(signal.reason), { once: true });
      return interrupted.promise;
    });
    const host = new DesktopHarnessHost({
      dataRoot: f.dataRoot,
      configuration: f.configuration,
      workspaces: f.workspaces,
      chooseDirectory: async () => f.workspace,
      emit: () => undefined,
      createHost: (options) => {
        const node = createNodeHost({ ...options, createProvider: f.provider });
        const run = node.run.bind(node);
        vi.spyOn(node, "run").mockImplementation(async (input) => {
          const handle = await run(input);
          return {
            ...handle,
            events: {
              async *[Symbol.asyncIterator]() {
                yield* handle.events;
                throw new Error("private observer diagnostic");
              },
            },
          };
        });
        const close = node.close.bind(node);
        vi.spyOn(node, "close").mockImplementation(async () => {
          await close();
          throw new Error("private resource diagnostic");
        });
        return node;
      },
    });
    cleanup.push(() => host.close().catch(() => undefined));
    await host.chooseWorkspace();
    const sessionId = selected(await host.newSession({ modelId: "model", toolsMode: "none" }));
    await host.run({ sessionId, text: "wait" });
    await entered.promise;
    const closing = host.close();
    expect(host.close()).toBe(closing);
    const failure = await closing.then(
      () => null,
      (error: unknown) => desktopError(error),
    );
    expect(failure).toMatchObject({ code: "HOST_CLOSE_FAILED" });
    expect(failure?.message).toContain("host:TERMINAL_OPERATION_FAILED");
    expect(failure?.message).toContain("observation:TERMINAL_OPERATION_FAILED");
    expect(JSON.stringify(failure)).not.toContain("private");
    await expect(host.close()).rejects.toMatchObject({ code: "HOST_CLOSE_FAILED" });
    expect(await f.configuration.management.getSnapshot()).toBeDefined();
  });

  it("runs different SQLite Threads independently and releases only the closing instance's writer", async () => {
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const release = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const f = await fixture(async (request, signal) => {
      const index = request.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.some((part) => part.type === "text" && part.text === "second"),
      )
        ? 1
        : 0;
      signals[index] = signal;
      entered[index]!.resolve();
      const interrupted = Promise.withResolvers<never>();
      if (signal.aborted) throw signal.reason;
      signal.addEventListener("abort", () => interrupted.reject(signal.reason), { once: true });
      return index === 0
        ? interrupted.promise
        : Promise.race([release.promise.then(() => text("second complete")), interrupted.promise]);
    });
    const first = f.open();
    const workspace = (await first.host.chooseWorkspace()).workspace!;
    const firstSession = selected(
      await first.host.newSession({ modelId: "model", toolsMode: "none" }),
    );
    const second = f.open();
    await second.host.selectWorkspace(workspace.id);
    const secondSession = selected(
      await second.host.newSession({ modelId: "model", toolsMode: "none" }),
    );
    const firstRun = await first.host.run({ sessionId: firstSession, text: "first" });
    const secondRun = await second.host.run({ sessionId: secondSession, text: "second" });
    await Promise.all(entered.map((gate) => gate.promise));
    const stores = createSqliteAgentStores(join(f.dataRoot, "sessions.sqlite"));
    cleanup.push(() => stores.dispose());
    cleanup.push(async () => release.resolve());
    expect(await stores.checkpoints.acquire(secondRun, "observer")).toMatchObject({
      status: "busy",
      lease: { ownerId: secondRun.runId },
    });
    const secondScope = (await second.host.snapshot()).scopeId;
    const firstClose = first.host.close();
    expect(first.host.close()).toBe(firstClose);
    await firstClose;
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    const acquired = await stores.checkpoints.acquire(firstRun, "inspector");
    expect(acquired).toMatchObject({ status: "acquired", checkpoint: { status: "interrupted" } });
    if (acquired.status !== "acquired") throw new Error("Expected released first writer");
    await stores.checkpoints.release(acquired.lease);
    expect(await stores.checkpoints.acquire(secondRun, "observer-again")).toMatchObject({
      status: "busy",
      lease: { ownerId: secondRun.runId },
    });
    expect((await second.host.snapshot()).scopeId).toBe(secondScope);
    expect(await f.configuration.management.getSnapshot()).toBeDefined();
    release.resolve();
    await second.waitFor((snapshot) => snapshot.status === "completed");
    expect(await readHostCheckpoint(f.dataRoot, f.workspace, firstSession)).toMatchObject({
      status: "interrupted",
    });
    expect(await readHostCheckpoint(f.dataRoot, f.workspace, secondSession)).toMatchObject({
      status: "completed",
    });
  });

  it("uses the real SQLite lease to reject competing answers without replaying a waiting tool", async () => {
    const modelEntered = Promise.withResolvers<void>();
    const releaseModel = Promise.withResolvers<void>();
    let winningSignal: AbortSignal | undefined;
    const f = await fixture(async (request, signal) => {
      if (!request.messages.some((message) => message.role === "tool")) return readCall;
      winningSignal = signal;
      modelEntered.resolve();
      await releaseModel.promise;
      signal.throwIfAborted();
      return text("approved once");
    });
    const bothReady = Promise.withResolvers<void>();
    const compete = Promise.withResolvers<void>();
    let ready = 0;
    const createHost: NonNullable<DesktopHostOptions["createHost"]> = (options) => {
      const node = createNodeHost({
        ...options,
        createProvider: f.provider,
        requireReadApproval: true,
      });
      const resume = node.resume.bind(node);
      vi.spyOn(node, "resume").mockImplementation(async (...input) => {
        if (++ready === 2) bothReady.resolve();
        await compete.promise;
        return resume(...input);
      });
      return node;
    };
    const first = f.open({ createHost });
    const workspace = (await first.host.chooseWorkspace()).workspace!;
    const sessionId = selected(
      await first.host.newSession({ modelId: "model", toolsMode: "read-only" }),
    );
    await first.host.run({ sessionId, text: "Read private.txt once" });
    const waiting = await first.waitFor((snapshot) => snapshot.status === "waiting");
    const second = f.open({ createHost });
    await second.host.selectWorkspace(workspace.id);
    const restored = await second.host.selectSession(sessionId);
    expect(restored.pendingApproval).toEqual(waiting.pendingApproval);
    const stores = createSqliteAgentStores(join(f.dataRoot, "sessions.sqlite"));
    cleanup.push(() => stores.dispose());
    cleanup.push(async () => {
      compete.resolve();
      releaseModel.resolve();
    });
    const binding = await stores.bindings.read(sessionId);
    const answer = {
      sessionId,
      queryId: waiting.pendingApproval!.queryId,
      interactionId: waiting.pendingApproval!.interactionId,
      choiceId: "allow" as const,
    };
    const attempts = [first.host.resume(answer), second.host.resume(answer)];
    await bothReady.promise;
    compete.resolve();
    const identities = await Promise.all(attempts);
    const failed = await Promise.race([
      first.waitFor((snapshot) => snapshot.status === "failed"),
      second.waitFor((snapshot) => snapshot.status === "failed"),
    ]);
    expect(failed.error?.code).toBe("WRITER_BUSY");
    await modelEntered.promise;
    const loser = failed.scopeId === waiting.scopeId ? first : second;
    const winner = loser === first ? second : first;
    const winnerIdentity = identities[loser === first ? 1 : 0]!;
    expect(await stores.checkpoints.acquire(winnerIdentity, "observer")).toMatchObject({
      status: "busy",
      lease: { ownerId: winnerIdentity.runId },
    });
    await loser.host.close();
    expect(winningSignal?.aborted).toBe(false);
    releaseModel.resolve();
    const completed = await winner.waitFor((snapshot) => snapshot.status === "completed");
    expect(
      completed.sessions
        .find((session) => session.id === sessionId)
        ?.history.filter((entry) => entry.role === "tool"),
    ).toHaveLength(1);
    expect(
      [...first.events, ...second.events].filter(
        (event) => event.type === "tool.status" && event.status === "completed",
      ),
    ).toHaveLength(1);
    expect(await stores.bindings.read(sessionId)).toEqual(binding);
    expect(f.requests).toHaveLength(2);
    const acquired = await stores.checkpoints.acquire(winnerIdentity, "after-settlement");
    expect(acquired).toMatchObject({
      status: "acquired",
      checkpoint: { status: "completed", lastRunId: winnerIdentity.runId },
    });
    if (acquired.status !== "acquired") throw new Error("Expected released winning writer");
    await stores.checkpoints.release(acquired.lease);
  });
});
