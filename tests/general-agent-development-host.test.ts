import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AgentConfiguration,
  createAgentConfiguration,
} from "@agent-harness/configuration/configuration";
import type { SessionHistory } from "@agent-harness/core/session/session-contract";
import type { ModelProviderOptions } from "@agent-harness/models/model-contract";
import { getModelProfile } from "@agent-harness/models/model-profiles";
import type { ToolsMode } from "@agent-harness/tools/tools-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareConfiguredModel } from "../cli/host/configured-model-factory";
import { type AgentHost, createAgentHost } from "../cli/host/create-agent-host";
import type { TerminalSetupIO } from "../cli/host/host-contract";
import { configuredModels } from "../cli/host/model-catalog";
import { createNodeHost } from "../cli/host/node-host";
import { createSqliteAgentStores } from "../cli/host/sqlite-agent-stores";
import { projectTerminalEvent, projectTerminalResult } from "../cli/terminal/terminal-projection";

const mimoProfile = getModelProfile("mimo-token-plan-cn");
if (mimoProfile?.endpoint?.kind !== "fixed")
  throw new Error("The MiMo fixed endpoint profile is required.");
const mimoBaseURL = mimoProfile.endpoint.url;

const cleanup: Array<() => Promise<unknown>> = [];
const nativeFetch = globalThis.fetch;
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Development-host fixture cleanup failed");
});
// Controlled credential port: this fixture tests real persistence, not OS encryption.
const fakeProtection = {
  scheme: "windows-dpapi-current-user" as const,
  inspect: async () => ({
    state: "secure" as const,
    backend: "windows-dpapi-current-user" as const,
  }),
  encrypt: async (value: string) => Buffer.from(value, "utf8"),
  decrypt: async (value: Uint8Array) => ({
    result: Buffer.from(value).toString("utf8"),
    shouldReEncrypt: false,
  }),
};

async function fixture(
  respond: (body: Record<string, unknown>, response: ServerResponse) => void | Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "general-agent-development-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "notes.txt"), "first file revision", "utf8");
  const requests: Record<string, unknown>[] = [];
  const authorizations: Array<string | undefined> = [];
  const publicURLs: string[] = [];
  const fixtureErrors: unknown[] = [];
  cleanup.push(async () => {
    if (fixtureErrors.length === 1) throw fixtureErrors[0];
    if (fixtureErrors.length)
      throw new AggregateError(fixtureErrors, "Local Responses fixture failed");
  });
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      expect(request.url).toBe("/responses");
      expect(request.method).toBe("POST");
      authorizations.push(request.headers.authorization);
      requests.push(body);
      await respond(body, response);
    })().catch((error: unknown) => {
      fixtureErrors.push(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  cleanup.push(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP endpoint");
  const endpoint = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.href !== `${mimoBaseURL}/responses`) {
      const error = new Error(`Unexpected native test destination: ${url.href}`);
      fixtureErrors.push(error);
      throw error;
    }
    publicURLs.push(url.href);
    const target = `${endpoint}/responses`;
    return nativeFetch(input instanceof Request ? new Request(target, input) : target, init);
  });
  const configure = async (key = "first-stored-key"): Promise<AgentConfiguration> => {
    const configuration = createAgentConfiguration({
      applicationDataRoot: directory,
      credentialProtection: fakeProtection,
      defaultTemplateId: "none",
      environment: {},
    });
    await configuration.management.initialize({
      vendors: [
        {
          id: "loopback",
          kind: "mimo-token-plan-cn",
          label: "Native consumer fixture",
          protocol: "openai",
          baseURL: mimoBaseURL,
          enabled: true,
          models: [
            {
              id: "configured-model",
              name: "MiMo Flash",
              model: "mimo-v2.6-flash",
              enabled: true,
              openaiApiMode: "responses",
            },
          ],
        },
      ],
      gateway: { timeoutMs: 5000, maxOutputTokens: 1024 },
      stepLimits: { enabled: true, mainMaxSteps: 4, subMaxSteps: 2 },
      executionStrategy: "REQUEST_APPROVAL",
      defaultTemplateId: "builtin/swiss-minimal",
    });
    const snapshot = await configuration.management.getSnapshot();
    if (!snapshot) throw new Error("Expected initialized configuration");
    await configuration.management.saveVendor({
      vendor: snapshot.settings.vendors[0],
      credential: { type: "replace", apiKey: key },
    });
    return configuration;
  };
  const open = async (
    configuration: AgentConfiguration,
    overrides: {
      workspaceRoot?: string;
      resume?: boolean;
      modelId?: string;
      toolMode?: ToolsMode;
      requireReadApproval?: boolean;
    } = {},
  ): Promise<AgentHost> => {
    const host = await createAgentHost({
      configuration: configuration.runtime,
      applicationDataRoot: directory,
      workspaceRoot: workspace,
      modelId: "configured-model",
      threadId: "thread",
      ...overrides,
    });
    cleanup.push(() => host.close());
    return host;
  };
  return { directory, workspace, requests, authorizations, publicURLs, configure, open };
}

function textOutput(text: string) {
  return {
    id: "message-fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}
function toolCall(id: string, name: string, input: Record<string, unknown>) {
  return {
    id: `item-${id}`,
    type: "function_call",
    status: "completed",
    call_id: id,
    name,
    arguments: JSON.stringify(input),
  };
}
const privateReasoning = {
  id: "reason-fixture",
  type: "reasoning",
  status: "completed",
  summary: [],
  content: [{ type: "reasoning_text", text: "public reasoning provided by the model" }],
  encrypted_content: "opaque-private-replay",
};
function respondNative(response: ServerResponse, output: Record<string, unknown>[]) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (event: Record<string, unknown>) => {
    const bytes = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    response.write(bytes.slice(0, 9));
    response.write(bytes.slice(9));
  };
  emit({
    type: "response.created",
    response: { id: "response-fixture", status: "in_progress", output: [] },
  });
  output.forEach((item, outputIndex) => {
    const base = { output_index: outputIndex, item_id: item.id };
    emit({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        ...item,
        status: "in_progress",
        ...(item.type === "function_call" ? { arguments: "" } : { content: [], summary: [] }),
      },
    });
    if (item.type === "function_call") {
      emit({ ...base, type: "response.function_call_arguments.delta", delta: item.arguments });
      emit({ ...base, type: "response.function_call_arguments.done", arguments: item.arguments });
    } else {
      (item.content as Array<{ type: string; text: string }>).forEach((part, contentIndex) => {
        const partBase = { ...base, content_index: contentIndex };
        const prefix = part.type === "reasoning_text" ? "reasoning_text" : "output_text";
        emit({ ...partBase, type: "response.content_part.added", part: { ...part, text: "" } });
        emit({ ...partBase, type: `response.${prefix}.delta`, delta: part.text });
        emit({ ...partBase, type: `response.${prefix}.done`, text: part.text });
        emit({ ...partBase, type: "response.content_part.done", part });
      });
    }
    emit({ type: "response.output_item.done", output_index: outputIndex, item });
  });
  emit({
    type: "response.completed",
    response: {
      id: "response-fixture",
      object: "response",
      status: "completed",
      output,
      usage: { input_tokens: 8, output_tokens: 3, output_tokens_details: { reasoning_tokens: 1 } },
    },
  });
  response.end("data: [DONE]\n\n");
}
function lastToolResult(body: Record<string, unknown>) {
  const input = body.input as Array<{
    type?: string;
    call_id?: string;
    output?: Array<{ type: string; text: string }>;
  }>;
  const last = input.at(-1);
  if (last?.type !== "function_call_output") return undefined;
  expect(last.output).toEqual(expect.any(Array));
  for (const part of last.output!) {
    expect(part).toEqual({ type: "input_text", text: expect.any(String) });
  }
  return { ...last, output: last.output!.map((part) => part.text).join("") };
}
const readCall = [
  privateReasoning,
  textOutput("Inspecting notes."),
  toolCall("read-1", "read", { path: "notes.txt" }),
];
const createdContent = "private approved creation content";
const writeCall = [
  privateReasoning,
  toolCall("create-1", "write", {
    path: "created.txt",
    content: createdContent,
    mode: "create",
  }),
];
const question = {
  queryId: "query",
  runId: "run-1",
  input: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Read notes.txt and explain it" }],
    },
  ],
};

describe("independent configured Agent host", () => {
  it("uses configured real HTTP transport without importing a business session", async () => {
    const f = await fixture((_body, response) =>
      respondNative(response, [textOutput("ordinary answer")]),
    );
    const host = await f.open(await f.configure());
    const result = await (
      await host.run({
        ...question,
        input: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      })
    ).completed;
    expect(result).toMatchObject({
      status: "completed",
      output: [{ content: [{ type: "text", text: "ordinary answer" }] }],
    });
    expect(f.requests[0]).toMatchObject({
      model: "mimo-v2.6-flash",
      max_output_tokens: 1024,
      stream: true,
      input: expect.arrayContaining([
        { role: "user", content: [{ type: "input_text", text: "Hello" }] },
      ]),
    });
    expect(f.publicURLs).toEqual([`${mimoBaseURL}/responses`]);
    expect(f.authorizations).toEqual(["Bearer first-stored-key"]);
    expect(host.binding.toolMode).toBe("read-only");
    const tools = f.requests[0].tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual(["glob", "grep", "read"]);
    await expect(readFile(join(f.workspace, "deck/snapshot.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes only after approval, survives reopening, accepts credential rotation, and keeps private replay off public output", async () => {
    const f = await fixture((body, response) => {
      const toolResult = lastToolResult(body);
      if (!toolResult) respondNative(response, writeCall);
      else {
        expect(JSON.parse(toolResult.output!)).toMatchObject({
          path: "created.txt",
          operation: "created",
          size: Buffer.byteLength(createdContent),
          version: expect.any(String),
        });
        expect(body.input).toEqual(expect.arrayContaining([privateReasoning]));
        respondNative(response, [textOutput("The approved file was created.")]);
      }
    });
    let host = await f.open(await f.configure(), { toolMode: "read-write" });
    const originalBinding = host.binding;
    const waiting = await (await host.run(question)).completed;
    expect(waiting.status).toBe("waiting");
    if (waiting.status !== "waiting") throw new Error("Expected approval");
    expect(waiting.interaction).toMatchObject({
      owner: "host-permissions",
      payload: {
        type: "host.workspace-tool",
        version: 1,
        data: { tool: "write", path: "created.txt", workspaceId: expect.any(String) },
      },
    });
    expect(f.requests).toHaveLength(1);
    await expect(readFile(join(f.workspace, "created.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await host.close();
    const stored = createSqliteAgentStores(join(f.directory, "sessions.sqlite"));
    try {
      expect((await stored.history.read("thread")).messages).toEqual(question.input);
      expect(await stored.checkpoints.findUnfinished("cli-agent", "thread")).toMatchObject({
        status: "waiting",
        inflight: { completed: [] },
      });
    } finally {
      await stored.dispose();
    }
    await expect(readFile(join(f.workspace, "created.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    host = await f.open(await f.configure("rotated-stored-key"), {
      toolMode: "read-write",
      resume: true,
    });
    const resumed = await host.resume({
      queryId: "query",
      runId: "run-2",
      response: { interactionId: waiting.interaction.id, type: "answer", value: true },
    });
    const result = await resumed.completed;
    expect(result.status).toBe("completed");
    expect(await readFile(join(f.workspace, "created.txt"), "utf8")).toBe(createdContent);
    const projections: object[] = [
      ...projectTerminalResult(result, () => ({ support: "unsupported" })),
    ];
    for await (const event of resumed.events) {
      const value = projectTerminalEvent(event, () => ({ support: "unsupported" }));
      if (value) projections.push(value);
    }
    const publicOutput = JSON.stringify(projections);
    expect(publicOutput).toContain("The approved file was created.");
    expect(publicOutput).toContain("public reasoning provided by the model");
    expect(publicOutput).not.toContain("replayState");
    expect(publicOutput).not.toContain("stored-key");
    expect(publicOutput).not.toContain("opaque-private-replay");
    expect(f.requests).toHaveLength(2);
    expect(f.authorizations).toEqual(["Bearer first-stored-key", "Bearer rotated-stored-key"]);
    expect(host.binding).toEqual(originalBinding);
    await host.close();
    const final = new DatabaseSync(join(f.directory, "sessions.sqlite"), { readOnly: true });
    try {
      const row = final
        .prepare(
          "SELECT owner_id, generation, payload FROM general_agent_checkpoints WHERE query_id = ?",
        )
        .get("query");
      expect(row).toMatchObject({
        owner_id: null,
        generation: 2,
        payload: expect.stringContaining('"status":"completed"'),
      });
    } finally {
      final.close();
    }
  });

  it.each([
    "workspace",
    "tool-mode",
    "read-approval-version",
    "connection-fingerprint",
    "maxSteps-increase",
    "maxSteps-decrease",
  ] as const)(
    "preserves a configured waiting write across rejected %s and original-binding recovery",
    async (dimension) => {
      const f = await fixture((body, response) => {
        if (lastToolResult(body))
          respondNative(response, [textOutput("Original binding recovered.")]);
        else respondNative(response, writeCall);
      });
      const configuration = await f.configure();
      const host = await f.open(configuration, { toolMode: "read-write" });
      const originalBinding = host.binding;
      const waiting = await (await host.run(question)).completed;
      if (waiting.status !== "waiting") throw new Error("Expected write approval.");
      await host.close();
      const inspection = new DatabaseSync(join(f.directory, "sessions.sqlite"), { readOnly: true });
      cleanup.push(async () => inspection.close());
      const before = inspection.prepare("SELECT * FROM general_agent_checkpoints").all();
      const bound = inspection.prepare("SELECT * FROM general_agent_host_bindings").all();
      const stored = createSqliteAgentStores(join(f.directory, "sessions.sqlite"));
      let history: SessionHistory;
      try {
        history = await stored.history.read("thread");
      } finally {
        await stored.dispose();
      }
      const other = join(f.directory, "other-workspace");
      await mkdir(other);
      const snapshot = await configuration.management.getSnapshot();
      if (!snapshot) throw new Error("Expected saved configuration.");
      const preferences = {
        gateway: snapshot.settings.gateway,
        stepLimits: snapshot.settings.stepLimits,
        executionStrategy: snapshot.settings.executionStrategy,
        defaultTemplateId: snapshot.settings.defaultTemplateId,
      };
      if (dimension === "connection-fingerprint") {
        await configuration.management.savePreferences({
          ...preferences,
          gateway: { ...preferences.gateway, maxOutputTokens: 512 },
        });
      }
      if (dimension === "maxSteps-increase" || dimension === "maxSteps-decrease") {
        await configuration.management.savePreferences({
          ...preferences,
          stepLimits: {
            ...preferences.stepLimits,
            mainMaxSteps: originalBinding.maxSteps + (dimension === "maxSteps-increase" ? 1 : -1),
          },
        });
      }
      await expect(
        f.open(configuration, {
          toolMode: dimension === "tool-mode" ? "read-only" : "read-write",
          workspaceRoot: dimension === "workspace" ? other : f.workspace,
          requireReadApproval: dimension === "read-approval-version",
          resume: true,
        }),
      ).rejects.toMatchObject({ code: "HOST_BINDING_CHANGED" });
      expect(inspection.prepare("SELECT * FROM general_agent_checkpoints").all()).toEqual(before);
      expect(inspection.prepare("SELECT * FROM general_agent_host_bindings").all()).toEqual(bound);
      expect(f.requests).toHaveLength(1);
      await expect(readFile(join(f.workspace, "created.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(join(other, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await configuration.management.savePreferences(preferences);
      const restored = await f.open(configuration, { toolMode: "read-write", resume: true });
      expect(restored.binding).toEqual(originalBinding);
      const completed = await (
        await restored.resume({
          queryId: "query",
          runId: "original-binding",
          response: { type: "answer", interactionId: waiting.interaction.id, value: true },
        })
      ).completed;
      expect(completed.status).toBe("completed");
      expect(await readFile(join(f.workspace, "created.txt"), "utf8")).toBe(createdContent);
      expect(f.requests).toHaveLength(2);
      await restored.close();
      const finalStores = createSqliteAgentStores(join(f.directory, "sessions.sqlite"));
      try {
        expect(await finalStores.bindings.read("thread")).toEqual(originalBinding);
        expect(
          (await finalStores.history.read("thread")).messages.slice(0, history.messages.length),
        ).toEqual(history.messages);
        expect(await finalStores.checkpoints.findUnfinished("cli-agent", "thread")).toBeNull();
      } finally {
        await finalStores.dispose();
      }
      expect(
        inspection
          .prepare(
            "SELECT owner_id, generation, payload FROM general_agent_checkpoints WHERE query_id = ?",
          )
          .get("query"),
      ).toMatchObject({
        owner_id: null,
        generation: 2,
        payload: expect.stringContaining('"status":"completed"'),
      });
    },
  );

  it.each(["write", "edit"] as const)(
    "does not install or execute %s in the default read-only mode",
    async (tool) => {
      const f = await fixture((body, response) => {
        if (lastToolResult(body)) {
          respondNative(response, [textOutput("The mutator is unavailable.")]);
        } else {
          respondNative(response, [
            tool === "write"
              ? toolCall("unavailable-write", "write", {
                  path: "created.txt",
                  content: "not permitted",
                  mode: "create",
                })
              : toolCall("unavailable-edit", "edit", {
                  path: "notes.txt",
                  oldText: "first file revision",
                  newText: "not permitted",
                }),
          ]);
        }
      });
      const host = await f.open(await f.configure());
      const run = await host.run(question);
      expect((await run.completed).status).toBe("completed");
      for await (const event of run.events) {
        expect(event.type).not.toBe("interaction.requested");
        if (event.type === "tool.completed") expect(event.completion.status).toBe("failed");
      }
      const tools = f.requests[0].tools as Array<{ name: string }>;
      expect(tools.map((installed) => installed.name).sort()).toEqual(["glob", "grep", "read"]);
      expect(await readFile(join(f.workspace, "notes.txt"), "utf8")).toBe("first file revision");
      await expect(readFile(join(f.workspace, "created.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each([true, false])(
    "gates writable creation on host approval (approve=%s)",
    async (approve) => {
      const content = "private approved creation content";
      const f = await fixture((body, response) => {
        const toolResult = lastToolResult(body);
        if (toolResult) {
          if (approve) {
            expect(JSON.parse(toolResult.output!)).toMatchObject({
              path: "created.txt",
              operation: "created",
              size: Buffer.byteLength(content),
              version: expect.any(String),
            });
          } else {
            expect(toolResult.output).not.toContain(content);
          }
          respondNative(response, [
            textOutput(approve ? "Creation succeeded." : "Creation denied."),
          ]);
        } else {
          respondNative(response, [
            toolCall("create-1", "write", { path: "created.txt", content, mode: "create" }),
          ]);
        }
      });
      const host = await f.open(await f.configure(), { toolMode: "read-write" });
      const waiting = await (await host.run(question)).completed;
      if (waiting.status !== "waiting") throw new Error("Expected write approval");
      expect(waiting.interaction.payload).toEqual({
        type: "host.workspace-tool",
        version: 1,
        data: { tool: "write", path: "created.txt", workspaceId: expect.any(String) },
      });
      expect(JSON.stringify(waiting.interaction.payload)).not.toContain(content);
      await expect(readFile(join(f.workspace, "created.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const result = await (
        await host.resume({
          queryId: "query",
          runId: "run-2",
          response: approve
            ? { type: "answer", interactionId: waiting.interaction.id, value: true }
            : { type: "reject", interactionId: waiting.interaction.id },
        })
      ).completed;
      expect(result.status).toBe("completed");
      if (approve) expect(await readFile(join(f.workspace, "created.txt"), "utf8")).toBe(content);
      else {
        await expect(readFile(join(f.workspace, "created.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
  );

  it.each([true, false])(
    "automatically reads and gates an edit on approval (approve=%s)",
    async (approve) => {
      const replacement = "private replacement content";
      let editedVersion: string | undefined;
      const f = await fixture((body, response) => {
        const last = lastToolResult(body);
        if (!last) {
          respondNative(response, readCall);
        } else if (last.call_id === "read-1") {
          const output = JSON.parse(last.output!) as {
            version: string;
            content: string;
            hasMore: boolean;
          };
          expect(output.content).toBe("first file revision");
          expect(output.hasMore).toBe(false);
          respondNative(response, [
            toolCall("edit-1", "edit", {
              path: "notes.txt",
              oldText: output.content,
              newText: replacement,
              expectedVersion: output.version,
            }),
          ]);
        } else {
          if (approve) {
            const output = JSON.parse(last.output!) as { version: string };
            expect(output).toMatchObject({
              path: "notes.txt",
              replacements: 1,
              size: Buffer.byteLength(replacement),
            });
            editedVersion = output.version;
          } else {
            expect(last.output).not.toContain(replacement);
          }
          respondNative(response, [textOutput(approve ? "Edit succeeded." : "Edit denied.")]);
        }
      });
      const host = await f.open(await f.configure(), { toolMode: "read-write" });
      expect(host.binding.toolMode).toBe("read-write");
      const editing = await (await host.run(question)).completed;
      if (editing.status !== "waiting") throw new Error("Expected edit approval");
      expect(editing.interaction.payload).toEqual({
        type: "host.workspace-tool",
        version: 1,
        data: { tool: "edit", path: "notes.txt", workspaceId: expect.any(String) },
      });
      expect(JSON.stringify(editing.interaction.payload)).not.toContain(replacement);
      expect(await readFile(join(f.workspace, "notes.txt"), "utf8")).toBe("first file revision");
      const completed = await (
        await host.resume({
          queryId: "query",
          runId: "run-2",
          response: approve
            ? { type: "answer", interactionId: editing.interaction.id, value: true }
            : { type: "reject", interactionId: editing.interaction.id },
        })
      ).completed;
      expect(completed.status).toBe("completed");
      if (approve) expect(editedVersion).toEqual(expect.any(String));
      else expect(editedVersion).toBeUndefined();
      expect(await readFile(join(f.workspace, "notes.txt"), "utf8")).toBe(
        approve ? replacement : "first file revision",
      );
      const tools = f.requests[0].tools as Array<{ name: string }>;
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "edit",
        "glob",
        "grep",
        "read",
        "write",
      ]);
    },
  );

  it.each(["read-only", "read-write"] as const)(
    "executes consecutive read, glob, and grep calls without waiting in %s mode",
    async (toolMode) => {
      const f = await fixture((body, response) => {
        const last = lastToolResult(body);
        if (!last) {
          respondNative(response, readCall);
        } else if (last.call_id === "read-1") {
          expect(JSON.parse(last.output!)).toMatchObject({
            path: "notes.txt",
            content: "first file revision",
            startOffset: 0,
            endOffset: "first file revision".length,
            totalCharacters: "first file revision".length,
            hasMore: false,
            version: expect.any(String),
          });
          respondNative(response, [toolCall("glob-1", "glob", { pattern: "*.txt" })]);
        } else if (last.call_id === "glob-1") {
          expect(JSON.parse(last.output!)).toMatchObject({
            matches: ["notes.txt"],
            truncated: false,
          });
          respondNative(response, [toolCall("grep-1", "grep", { pattern: "first file revision" })]);
        } else {
          expect(last.call_id).toBe("grep-1");
          expect(JSON.parse(last.output!)).toMatchObject({
            matches: [{ path: "notes.txt", line: 1, text: "first file revision" }],
            truncated: false,
          });
          respondNative(response, [textOutput("Workspace inspection completed.")]);
        }
      });
      const host = await f.open(await f.configure(), { toolMode });
      const run = await host.run(question);
      expect((await run.completed).status).toBe("completed");
      const completedTools: string[] = [];
      for await (const event of run.events) {
        expect(event.type).not.toBe("run.waiting");
        expect(event.type).not.toBe("interaction.requested");
        if (event.type === "tool.completed") {
          expect(event.completion.status).toBe("succeeded");
          completedTools.push(event.invocation.call.name);
        }
      }
      expect(completedTools).toEqual(["read", "glob", "grep"]);
      expect(f.requests).toHaveLength(4);
    },
  );

  it.each(["read-only", "read-write"] as const)(
    "rejects an out-of-workspace read without approval or leaking contents in %s mode",
    async (toolMode) => {
      const secret = "private contents outside the workspace";
      const f = await fixture((body, response) => {
        const last = lastToolResult(body);
        if (!last) {
          respondNative(response, [toolCall("outside-read", "read", { path: "../private.txt" })]);
        } else {
          expect(last.output).not.toContain(secret);
          respondNative(response, [textOutput("The path is unavailable.")]);
        }
      });
      await writeFile(join(f.directory, "private.txt"), secret, "utf8");
      const host = await f.open(await f.configure(), { toolMode });
      const run = await host.run(question);
      const result = await run.completed;
      expect(result.status).toBe("completed");
      expect(JSON.stringify(result)).not.toContain(secret);
      let failures = 0;
      for await (const event of run.events) {
        expect(event.type).not.toBe("run.waiting");
        expect(event.type).not.toBe("interaction.requested");
        expect(JSON.stringify(event)).not.toContain(secret);
        if (event.type === "tool.completed") {
          expect(event.completion).toMatchObject({ status: "failed", effects: "none" });
          failures += 1;
        }
      }
      expect(failures).toBe(1);
      expect(f.requests).toHaveLength(2);
    },
  );

  it("routes provider failure diagnostics to private logs, not terminal output or successful completion", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture((_body, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "first-stored-key and private native diagnostic" },
        }),
      );
    });
    const host = await f.open(await f.configure());
    const result = await (await host.run(question)).completed;
    expect(result.status).toBe("failed");
    expect(error).not.toHaveBeenCalled();
    const output = JSON.stringify(
      projectTerminalResult(result, () => ({ support: "unsupported" })),
    );
    expect(output).not.toContain("first-stored-key");
    expect(output).not.toContain("private native diagnostic");
  });

  it("interrupts and releases a live HTTP query on host shutdown, then resumes it", async () => {
    const entered = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    let hold = true;
    const f = await fixture((_body, response) => {
      if (hold) {
        response.once("close", () => disconnected.resolve());
        entered.resolve();
      } else respondNative(response, [textOutput("Recovered response")]);
    });
    const configuration = await f.configure();
    let host = await f.open(configuration);
    const running = await host.run(question);
    await entered.promise;
    await host.close();
    expect((await running.completed).status).toBe("interrupted");
    await disconnected.promise;
    hold = false;
    host = await f.open(configuration, { resume: true });
    expect(await (await host.resume({ queryId: "query", runId: "run-2" })).completed).toMatchObject(
      { status: "completed", output: [{ content: [{ text: "Recovered response" }] }] },
    );
  });

  it("rejects model changes and custom routing even at the native URL before resuming a pending write", async () => {
    const f = await fixture((_body, response) => respondNative(response, writeCall));
    const configuration = await f.configure();
    const host = await f.open(configuration, { toolMode: "read-write" });
    expect((await (await host.run(question)).completed).status).toBe("waiting");
    await host.close();
    const snapshot = await configuration.management.getSnapshot();
    if (!snapshot) throw new Error("Expected initialized configuration");
    const vendor = snapshot.settings.vendors[0];
    await configuration.management.saveVendor({
      vendor: {
        ...vendor,
        models: [
          ...vendor.models,
          { ...vendor.models[0], id: "other-model", model: "mimo-v2.6-pro" },
        ],
      },
      credential: { type: "keep" },
    });
    await expect(
      f.open(configuration, { resume: true, toolMode: "read-write", modelId: "other-model" }),
    ).rejects.toMatchObject({ code: "HOST_BINDING_CHANGED" });
    // 相同 URL 的自定义 Responses 连接不继承 MiMo 身份；已有会话仍拒绝换适配器。
    await configuration.management.saveVendor({
      vendor: { ...vendor, kind: "custom" },
      credential: { type: "replace", apiKey: "custom-stored-key" },
    });
    await expect(
      f.open(configuration, { resume: true, toolMode: "read-write" }),
    ).rejects.toMatchObject({
      code: "HOST_BINDING_CHANGED",
    });
    expect(f.requests).toHaveLength(1);
  });

  it("rejects an unknown adapter before resolving the signed plan or credentials", async () => {
    const runtime: AgentConfiguration["runtime"] = {
      loadExecutionPlan: vi.fn().mockResolvedValue({ modelAdapter: "unknown-adapter" }),
      resolveRuntime: vi.fn(),
    };
    await expect(
      prepareConfiguredModel(runtime, "configured-model", new AbortController().signal),
    ).rejects.toMatchObject({ code: "MODEL_ADAPTER_UNSUPPORTED" });
    expect(runtime.resolveRuntime).not.toHaveBeenCalled();
  });

  it("lists model eligibility from saved configuration without making a model request", async () => {
    const f = await fixture((_body, response) =>
      respondNative(response, [textOutput("unexpected")]),
    );
    const configuration = await f.configure();
    const snapshot = await configuration.management.getSnapshot();
    if (!snapshot) throw new Error("Expected saved configuration");
    const vendor = snapshot.settings.vendors[0];
    await configuration.management.saveVendor({
      vendor: {
        ...vendor,
        models: [
          ...vendor.models,
          { ...vendor.models[0], id: "disabled", enabled: false },
          { ...vendor.models[0], id: "audio", model: "mimo-v2.5-tts" },
        ],
      },
      credential: { type: "keep" },
    });
    for (const [id, kind] of [
      ["missing", "mimo-token-plan-cn"],
      ["legacy", "custom"],
    ] as const) {
      await configuration.management.saveVendor({
        vendor: {
          ...vendor,
          id,
          kind,
          models: [{ ...vendor.models[0], id }],
        },
        credential: { type: "keep" },
      });
    }
    const saved = await configuration.management.getSnapshot();
    const listed = configuredModels(saved);
    expect(listed.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "configured-model", status: "ready" },
      { id: "disabled", status: "disabled" },
      { id: "audio", status: "unsupported-model" },
      { id: "missing", status: "missing-credential" },
      { id: "legacy", status: "missing-credential" },
    ]);
    expect(configuredModels(undefined)).toEqual([]);
    if (!saved) throw new Error("Expected saved configuration");
    saved.settings.gateway.maxOutputTokens = 131_072;
    expect(configuredModels(saved)[0].status).toBe("ready");
    saved.settings.gateway.maxOutputTokens = 131_073;
    expect(configuredModels(saved)[0].status).toBe("invalid-budget");
    saved.settings.gateway.maxOutputTokens = 1024;
    saved.credentials.storage.state = "unavailable";
    expect(configuredModels(saved)[0].status).toBe("credential-storage-unavailable");
    expect(f.requests).toEqual([]);
  });

  it("lists every saved connection and creation target without decrypting keys or requesting models", async () => {
    const f = await fixture((_body, response) =>
      respondNative(response, [textOutput("unexpected")]),
    );
    const configuration = await f.configure();
    await configuration.management.saveVendor({
      vendor: {
        id: "empty",
        kind: "openai",
        label: "Empty connection",
        protocol: "openai",
        baseURL: "https://api.openai.com/v1",
        enabled: false,
        models: [],
      },
      credential: { type: "keep" },
    });
    const decrypt = vi.spyOn(fakeProtection, "decrypt");
    const discover = vi.spyOn(configuration.management, "listRemoteModels");
    const host = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration,
      credentialProtection: fakeProtection,
    });
    cleanup.push(() => host.close());
    expect(await host.connections()).toEqual([
      {
        id: "vendor:loopback",
        label: "Native consumer fixture",
        description: "1 个模型",
        target: { type: "existing", vendorId: "loopback" },
      },
      {
        id: "vendor:empty",
        label: "Empty connection",
        description: "0 个模型",
        target: { type: "existing", vendorId: "empty" },
      },
      ...[
        "mimo-token-plan-cn",
        "openai-responses",
        "openai-chat-completions",
        "anthropic-messages",
      ].map((adapterId) => ({
        id: `create:${adapterId}`,
        label: expect.any(String),
        target: { type: "new", adapterId },
      })),
    ]);
    expect(decrypt).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
    await host.close();
    await expect(host.connections()).rejects.toMatchObject({ code: "HOST_CLOSED" });
  });

  it("runs no-plugin conversations through the production host and retains real persistent sessions", async () => {
    const f = await fixture((_body, response) =>
      respondNative(response, [textOutput("No plugin answer")]),
    );
    const configuration = await f.configure();
    await configuration.management.saveCliPreferences({ defaultModelId: "configured-model" });
    const host = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration,
    });
    cleanup.push(() => host.close());
    await host.open({ toolsMode: "none" });
    expect(await host.models()).toEqual([
      expect.objectContaining({
        id: "configured-model",
        label: "Native consumer fixture / MiMo Flash",
        vendor: { id: "loopback", label: "Native consumer fixture" },
        modelName: "MiMo Flash",
        availability: { state: "ready", reason: expect.any(String) },
      }),
    ]);
    const first = await host.run("Hello without tools");
    const result = await first.completed;
    expect(result.status).toBe("completed");
    expect(f.requests[0].tools ?? []).toEqual([]);
    const sessions = await host.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: host.context.threadId,
      modelId: "configured-model",
      toolsMode: "none",
      history: [
        { role: "user", text: "Hello without tools" },
        { role: "assistant", text: "No plugin answer" },
      ],
    });
    await host.newSession({ toolsMode: "read-only" });
    expect(host.context.threadId).not.toBe(first.identity.threadId);
    await host.selectSession(first.identity.threadId);
    expect(host.context.toolsMode).toBe("none");
  });

  it("reopens configuration for a ready default, preserves cancellation, and excludes concurrent input owners", async () => {
    const f = await fixture((_body, response) =>
      respondNative(response, [textOutput("Original host survives cancelled setup")]),
    );
    const configuration = await f.configure();
    await configuration.management.saveCliPreferences({ defaultModelId: "configured-model" });
    const host = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration,
      credentialProtection: fakeProtection,
    });
    cleanup.push(() => host.close());
    await host.open({ toolsMode: "none" });
    const original = host.context;
    const before = await configuration.management.getSnapshot();
    const selection = Promise.withResolvers<string | undefined>();
    const entered = Promise.withResolvers<void>();
    const setup: TerminalSetupIO = {
      select: vi.fn(async () => {
        entered.resolve();
        return selection.promise;
      }),
      secret: vi.fn(async () => undefined),
      text: vi.fn(async () => undefined),
      notify: vi.fn(async () => {}),
    };
    const target = { type: "existing", vendorId: "loopback" } as const;
    const configuring = host.configureModel(setup, target);
    await entered.promise;
    expect(setup.select).toHaveBeenCalledTimes(1);
    await expect(host.configureModel(setup, target)).rejects.toMatchObject({ code: "HOST_BUSY" });
    await expect(host.newSession()).rejects.toMatchObject({ code: "HOST_BUSY" });
    await expect(host.run("Cannot borrow setup input")).rejects.toMatchObject({
      code: "HOST_BUSY",
    });
    selection.resolve(undefined);
    await expect(configuring).resolves.toBeUndefined();
    expect(setup.secret).not.toHaveBeenCalled();
    expect(host.context).toBe(original);
    expect(await configuration.management.getSnapshot()).toEqual(before);
    expect(f.requests).toEqual([]);
    expect((await (await host.run("Still using original model")).completed).status).toBe(
      "completed",
    );
  });

  it("adds a second vendor through local discovery without rebinding the ready session or exposing credentials", async () => {
    const f = await fixture((_body, response) =>
      respondNative(response, [textOutput("Original model is still bound")]),
    );
    const configuration = await f.configure();
    await configuration.management.saveCliPreferences({ defaultModelId: "configured-model" });
    const host = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration,
      credentialProtection: fakeProtection,
    });
    cleanup.push(() => host.close());
    await host.open({ toolsMode: "none" });
    const original = host.context;
    expect(original.model).toMatchObject({
      vendor: { id: "loopback", label: "Native consumer fixture" },
      modelName: "MiMo Flash",
    });
    const discoveryRequests: Array<{ url: string | undefined; authorization: string | undefined }> =
      [];
    const discovery = createServer((request, response) => {
      discoveryRequests.push({ url: request.url, authorization: request.headers.authorization });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "second-conversation" }] }));
    });
    const listening = once(discovery, "listening");
    discovery.listen(0, "127.0.0.1");
    await listening;
    cleanup.push(async () => {
      const closed = once(discovery, "close");
      discovery.close();
      discovery.closeAllConnections();
      await closed;
    });
    const address = discovery.address();
    if (!address || typeof address === "string") throw new Error("Expected discovery endpoint");
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const controlledFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.href === `${baseURL}/models`
        ? nativeFetch(input, init)
        : controlledFetch(input, init);
    });
    const key = "second-vendor-private-key";
    const notices: string[] = [];
    const select = vi.fn<TerminalSetupIO["select"]>(async (_title, items) => items[0]?.id);
    const modelId = await host.configureModel(
      {
        select,
        text: async () => baseURL,
        secret: async () => key,
        notify: async (message) => {
          notices.push(message);
        },
      },
      { type: "new", adapterId: "openai-responses" },
    );
    expect(select).toHaveBeenCalledTimes(1);
    expect(modelId).toEqual(expect.any(String));
    expect(discoveryRequests).toEqual([{ url: "/v1/models", authorization: `Bearer ${key}` }]);
    expect(host.context).toBe(original);
    const snapshot = (await configuration.management.getSnapshot())!;
    expect(snapshot.settings.cli?.defaultModelId).toBe(modelId);
    expect(snapshot.settings.vendors).toHaveLength(2);
    const added = snapshot.settings.vendors.find((vendor) => vendor.id !== "loopback")!;
    const models = await host.models();
    expect(models).toEqual([
      expect.objectContaining({
        id: "configured-model",
        label: "Native consumer fixture / MiMo Flash",
        vendor: { id: "loopback", label: "Native consumer fixture" },
        modelName: "MiMo Flash",
      }),
      expect.objectContaining({
        id: modelId,
        vendor: { id: added.id, label: "OpenAI Responses" },
        modelName: "second-conversation",
        availability: { state: "ready", reason: expect.any(String) },
      }),
    ]);
    const plan = await configuration.runtime.loadExecutionPlan(modelId!);
    expect((await configuration.runtime.resolveRuntime(plan)).primary.apiKey).toBe(key);
    expect(JSON.stringify({ models, context: host.context, notices })).not.toContain(key);
    expect(models.some((model) => "connectionFingerprint" in model)).toBe(false);
    expect(f.requests).toEqual([]);
    expect((await (await host.run("Do not switch implicitly")).completed).status).toBe("completed");
    expect(f.authorizations).toEqual(["Bearer first-stored-key"]);
    expect(host.context).toBe(original);
  });

  it("keeps the active host after setup preparation or input failures and redacts their details", async () => {
    const f = await fixture((_body, response) =>
      respondNative(response, [textOutput("Original host survives configuration failure")]),
    );
    const configuration = await f.configure();
    const host = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration,
      credentialProtection: fakeProtection,
    });
    cleanup.push(() => host.close());
    await host.open({ modelId: "configured-model", toolsMode: "none" });
    const original = host.context;
    const privateError = "untrusted-error-containing-private-key";
    const setup: TerminalSetupIO = {
      select: async () => {
        throw new Error(privateError);
      },
      secret: vi.fn(async () => undefined),
      text: vi.fn(async () => undefined),
      notify: vi.fn(async () => {}),
    };
    for (const preparationFailure of [false, true]) {
      const snapshot = preparationFailure
        ? vi
            .spyOn(configuration.management, "getSnapshot")
            .mockRejectedValueOnce(new Error(privateError))
        : undefined;
      const failure = await host
        .configureModel(setup, { type: "existing", vendorId: "loopback" })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "HOST_CONFIGURATION_REJECTED" });
      expect(String(failure)).not.toContain(privateError);
      expect(host.context).toBe(original);
      snapshot?.mockRestore();
    }
    expect(setup.secret).not.toHaveBeenCalled();
    expect((await (await host.run("Keep original model")).completed).status).toBe("completed");
  });

  it("interrupts a borrowed setup prompt on close and rejects later configuration", async () => {
    const f = await fixture((_body, response) =>
      respondNative(response, [textOutput("unexpected")]),
    );
    const host = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration: await f.configure(),
      credentialProtection: fakeProtection,
    });
    cleanup.push(() => host.close());
    await host.open({ modelId: "configured-model" });
    const entered = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<string | undefined>();
    const setup: TerminalSetupIO = {
      select: async () => {
        entered.resolve();
        return pending.promise;
      },
      secret: async () => undefined,
      text: async () => undefined,
      notify: async () => {},
    };
    const target = { type: "existing", vendorId: "loopback" } as const;
    const configuring = host.configureModel(setup, target);
    const rejected = expect(configuring).rejects.toMatchObject({ code: "HOST_CLOSED" });
    await entered.promise;
    await host.close();
    await rejected;
    pending.resolve(undefined);
    await expect(host.configureModel(setup, target)).rejects.toMatchObject({ code: "HOST_CLOSED" });
    expect(f.requests).toEqual([]);
  });

  it("retains unavailable catalog entries, rejects their activation, and binds a new model to a fresh session", async () => {
    const f = await fixture((_body, response) =>
      respondNative(response, [textOutput("Original host still usable")]),
    );
    const configuration = await f.configure();
    const snapshot = await configuration.management.getSnapshot();
    if (!snapshot) throw new Error("Expected saved configuration");
    const vendor = snapshot.settings.vendors[0];
    await configuration.management.saveVendor({
      vendor: {
        ...vendor,
        models: [
          ...vendor.models,
          { ...vendor.models[0], id: "other", name: "Other" },
          { ...vendor.models[0], id: "disabled", enabled: false },
        ],
      },
      credential: { type: "keep" },
    });
    const host = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration,
    });
    cleanup.push(() => host.close());
    await host.open({ modelId: "configured-model", toolsMode: "none" });
    const original = host.context;
    const models = await host.models();
    expect(models).toEqual([
      expect.objectContaining({
        id: "configured-model",
        availability: { state: "ready", reason: expect.any(String) },
      }),
      expect.objectContaining({
        id: "other",
        availability: { state: "ready", reason: expect.any(String) },
      }),
      expect.objectContaining({
        id: "disabled",
        availability: { state: "unavailable", reason: expect.any(String) },
      }),
    ]);
    expect(models.some((model) => "connectionFingerprint" in model)).toBe(false);
    expect(f.requests).toHaveLength(0);
    await expect(host.newSession({ modelId: "disabled" })).rejects.toMatchObject({
      code: "HOST_SWITCH_REJECTED",
    });
    expect(host.context).toBe(original);
    expect((await (await host.run("Keep old binding")).completed).status).toBe("completed");
    await host.newSession({ modelId: "other" });
    expect(host.context.model.id).toBe("other");
    expect(host.context.threadId).not.toBe(original.threadId);
    const oldSession = (await host.sessions()).find((session) => session.id === original.threadId);
    expect(oldSession?.modelId).toBe(original.model.id);
    await host.selectSession(original.threadId);
    expect(host.context.model.id).toBe(original.model.id);
    expect(host.context.threadId).toBe(original.threadId);
    expect(f.requests).toHaveLength(1);
  });

  it("restores the authoritative waiting interaction in a fresh Run and consumes only an explicit matching choice", async () => {
    const f = await fixture((body, response) => {
      if (!lastToolResult(body)) respondNative(response, readCall);
      else respondNative(response, [textOutput("Approved read complete")]);
    });
    const configuration = await f.configure();
    const firstHost = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration,
      requireReadApproval: true,
    });
    cleanup.push(() => firstHost.close());
    await firstHost.open({ modelId: "configured-model" });
    const first = await firstHost.run("Read notes.txt");
    const waiting = await first.completed;
    if (waiting.status !== "waiting") throw new Error("Expected read approval.");
    expect(f.requests).toHaveLength(1);
    const threadId = firstHost.context.threadId;
    expect((await firstHost.sessions())[0]?.history).toEqual([
      { role: "user", text: "Read notes.txt" },
    ]);
    await firstHost.close();
    const resumedHost = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration,
      requireReadApproval: true,
    });
    cleanup.push(() => resumedHost.close());
    await resumedHost.open({ threadId });
    const probe = await resumedHost.resume(first.identity.queryId);
    expect(probe.identity.queryId).toBe(first.identity.queryId);
    expect(probe.identity.runId).not.toBe(first.identity.runId);
    const restored = await probe.completed;
    if (restored.status !== "waiting") throw new Error("Expected persistent waiting.");
    expect(restored.interaction).toEqual(waiting.interaction);
    expect(f.requests).toHaveLength(1);
    expect(resumedHost.describeInteraction(restored.interaction)).toMatchObject({
      support: "supported",
      confirmation: "explicit-choice",
    });
    expect(
      resumedHost.describeInteraction({ ...restored.interaction, owner: "untrusted" }),
    ).toEqual({ support: "unsupported" });
    expect(() => resumedHost.answerInteraction(restored.interaction, "yes")).toThrow();
    expect(() =>
      resumedHost.answerInteraction(restored.interaction, "allow", "stale-id"),
    ).toThrow();
    const answer = resumedHost.answerInteraction(restored.interaction, "allow");
    const resumed = await resumedHost.resume(first.identity.queryId, answer);
    expect(resumed.identity.runId).not.toBe(probe.identity.runId);
    expect((await resumed.completed).status).toBe("completed");
    expect((await resumedHost.sessions())[0]?.history).toEqual([
      { role: "user", text: "Read notes.txt" },
      { role: "reasoning", text: "public reasoning provided by the model" },
      { role: "assistant", text: "Inspecting notes." },
      { role: "tool", tool: { callId: "read-1", name: "read", result: "recorded" } },
      { role: "assistant", text: "Approved read complete" },
    ]);
  });

  it("refuses to restore an approval-bound session under a different host read policy", async () => {
    const f = await fixture((body, response) => {
      if (!lastToolResult(body)) respondNative(response, readCall);
      else respondNative(response, [textOutput("Original read policy recovered")]);
    });
    const configuration = await f.configure();
    const protectedHost = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration,
      requireReadApproval: true,
    });
    cleanup.push(() => protectedHost.close());
    await protectedHost.open({ modelId: "configured-model" });
    const run = await protectedHost.run("Read notes.txt");
    const waiting = await run.completed;
    if (waiting.status !== "waiting") throw new Error("Expected read approval.");
    const threadId = protectedHost.context.threadId;
    await protectedHost.close();
    const inspection = new DatabaseSync(join(f.directory, "sessions.sqlite"), { readOnly: true });
    cleanup.push(async () => inspection.close());
    const before = inspection.prepare("SELECT * FROM general_agent_checkpoints").all();
    const unprotectedHost = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration,
    });
    cleanup.push(() => unprotectedHost.close());
    await expect(unprotectedHost.open({ threadId })).rejects.toMatchObject({
      code: "HOST_BINDING_CHANGED",
    });
    expect(f.requests).toHaveLength(1);
    expect(inspection.prepare("SELECT * FROM general_agent_checkpoints").all()).toEqual(before);
    const restored = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration,
      requireReadApproval: true,
    });
    cleanup.push(() => restored.close());
    await restored.open({ threadId });
    const resumed = await restored.resume(
      run.identity.queryId,
      restored.answerInteraction(waiting.interaction, "allow"),
    );
    expect(resumed.identity.runId).not.toBe(run.identity.runId);
    expect((await resumed.completed).status).toBe("completed");
    expect(f.requests).toHaveLength(2);
    await restored.close();
    expect(
      inspection
        .prepare(
          "SELECT owner_id, generation, payload FROM general_agent_checkpoints WHERE query_id = ?",
        )
        .get(run.identity.queryId),
    ).toMatchObject({
      owner_id: null,
      generation: 2,
      payload: expect.stringContaining('"status":"completed"'),
    });
  });

  it("keeps sessions with changed model configuration visible but rejects restore before acquiring a lease", async () => {
    const f = await fixture((_body, response) => respondNative(response, writeCall));
    const configuration = await f.configure();
    const firstHost = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration,
    });
    cleanup.push(() => firstHost.close());
    await firstHost.open({ modelId: "configured-model", toolsMode: "read-write" });
    expect((await (await firstHost.run("Create the file")).completed).status).toBe("waiting");
    const threadId = firstHost.context.threadId;
    await firstHost.close();
    const snapshot = await configuration.management.getSnapshot();
    if (!snapshot) throw new Error("Expected saved model configuration.");
    await configuration.management.savePreferences({
      gateway: { ...snapshot.settings.gateway, maxOutputTokens: 512 },
      stepLimits: snapshot.settings.stepLimits,
      executionStrategy: snapshot.settings.executionStrategy,
      defaultTemplateId: snapshot.settings.defaultTemplateId,
    });
    const inspection = new DatabaseSync(join(f.directory, "sessions.sqlite"), { readOnly: true });
    cleanup.push(async () => inspection.close());
    const before = inspection
      .prepare("SELECT * FROM general_agent_checkpoints ORDER BY query_id")
      .all();
    const host = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration,
    });
    cleanup.push(() => host.close());
    expect(await host.sessions()).toEqual([
      expect.objectContaining({
        id: threadId,
        modelId: undefined,
        toolsMode: "read-write",
        unfinished: { queryId: expect.any(String), status: "waiting" },
      }),
    ]);
    await expect(host.open({ threadId })).rejects.toMatchObject({ code: "HOST_BINDING_CHANGED" });
    await expect(host.open({ threadId, modelId: "configured-model" })).rejects.toMatchObject({
      code: "HOST_BINDING_CHANGED",
    });
    await host.open({ modelId: "configured-model" });
    const newThreadId = host.context.threadId;
    await expect(host.selectSession(threadId)).rejects.toMatchObject({
      code: "HOST_BINDING_CHANGED",
    });
    expect(host.context.threadId).toBe(newThreadId);
    expect(
      inspection.prepare("SELECT * FROM general_agent_checkpoints ORDER BY query_id").all(),
    ).toEqual(before);
    expect(f.requests).toHaveLength(1);
    await expect(readFile(join(f.workspace, "created.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["write", "edit"] as const)(
    "requires the exact interaction ID before approving %s",
    async (tool) => {
      const f = await fixture((body, response) => {
        const result = lastToolResult(body);
        if (!result) {
          respondNative(response, tool === "write" ? writeCall : readCall);
        } else if (tool === "edit" && result.call_id === "read-1") {
          const read = JSON.parse(result.output!) as { content: string; version: string };
          respondNative(response, [
            toolCall("edit-approval", "edit", {
              path: "notes.txt",
              oldText: read.content,
              newText: "approved edit",
              expectedVersion: read.version,
            }),
          ]);
        } else {
          respondNative(response, [textOutput("Approved modification complete")]);
        }
      });
      const host = createNodeHost({
        dataRoot: f.directory,
        workspaceRoot: f.workspace,
        configuration: await f.configure(),
      });
      cleanup.push(() => host.close());
      await host.open({ modelId: "configured-model", toolsMode: "read-write" });
      const run = await host.run("Perform the requested modification");
      const waiting = await run.completed;
      if (waiting.status !== "waiting") throw new Error("Expected writable approval.");
      expect(host.describeInteraction(waiting.interaction)).toMatchObject({
        support: "supported",
        confirmation: "interaction-id",
      });
      expect(() => host.answerInteraction(waiting.interaction, "allow")).toThrow(
        expect.objectContaining({ code: "STALE_INTERACTION" }),
      );
      expect(() => host.answerInteraction(waiting.interaction, "allow", "wrong-id")).toThrow(
        expect.objectContaining({ code: "STALE_INTERACTION" }),
      );
      expect(await readFile(join(f.workspace, "notes.txt"), "utf8")).toBe("first file revision");
      await expect(readFile(join(f.workspace, "created.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const answer = host.answerInteraction(waiting.interaction, "allow", waiting.interaction.id);
      expect((await (await host.resume(run.identity.queryId, answer)).completed).status).toBe(
        "completed",
      );
      expect(
        await readFile(join(f.workspace, tool === "write" ? "created.txt" : "notes.txt"), "utf8"),
      ).toBe(tool === "write" ? createdContent : "approved edit");
    },
  );

  it("reports abandoned setup distinctly without starting a Query", async () => {
    const f = await fixture((_body, response) =>
      respondNative(response, [textOutput("unexpected")]),
    );
    const host = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration: await f.configure(),
    });
    cleanup.push(() => host.close());
    const secret = vi.fn();
    await expect(
      host.open({
        setup: {
          select: async () => undefined,
          secret,
          text: async () => undefined,
          notify: async () => {},
        },
      }),
    ).rejects.toMatchObject({ code: "CLI_SETUP_CANCELLED" });
    expect(secret).not.toHaveBeenCalled();
    expect(await host.sessions()).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it("aborts and drains model preparation on close without publishing a live host", async () => {
    const f = await fixture((_body, response) =>
      respondNative(response, [textOutput("unexpected")]),
    );
    const entered = Promise.withResolvers<void>();
    const host = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration: await f.configure(),
      createProvider: async (_options: ModelProviderOptions, signal: AbortSignal) => {
        const pending = Promise.withResolvers<never>();
        const aborted = () => pending.reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        entered.resolve();
        try {
          return await pending.promise;
        } finally {
          signal.removeEventListener("abort", aborted);
        }
      },
    });
    cleanup.push(() => host.close());
    const opening = host.open({ modelId: "configured-model" });
    const rejected = expect(opening).rejects.toMatchObject({ code: "HOST_CLOSED" });
    await entered.promise;
    await host.close();
    await rejected;
    expect(() => host.context).toThrow(expect.objectContaining({ code: "HOST_CLOSED" }));
    expect(f.requests).toEqual([]);
  });

  it("closes while the terminal owns a pending setup prompt without publishing a host", async () => {
    const f = await fixture((_body, response) =>
      respondNative(response, [textOutput("unexpected")]),
    );
    const host = createNodeHost({
      dataRoot: f.directory,
      workspaceRoot: f.workspace,
      configuration: await f.configure(),
    });
    cleanup.push(() => host.close());
    const entered = Promise.withResolvers<void>();
    const selection = Promise.withResolvers<string | undefined>();
    const opening = host.open({
      setup: {
        select: async () => {
          entered.resolve();
          return selection.promise;
        },
        secret: async () => undefined,
        text: async () => undefined,
        notify: async () => {},
      },
    });
    const rejected = expect(opening).rejects.toMatchObject({ code: "HOST_CLOSED" });
    await entered.promise;
    await host.close();
    await rejected;
    expect(() => host.context).toThrow(expect.objectContaining({ code: "HOST_CLOSED" }));
    expect(f.requests).toEqual([]);
  });
});
