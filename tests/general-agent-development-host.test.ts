import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentConfiguration, createAgentConfiguration } from "../src/main/agent-configuration";
import { type AgentHost, createAgentHost } from "../src/main/agent-host/create-agent-host";
import {
  parseDevelopmentArguments,
  projectDevelopmentEvent,
  projectDevelopmentResult,
} from "../src/main/agent-host/development-command";
import { createSqliteAgentStores } from "../src/main/agent-host/sqlite-agent-stores";
import { MIMO_TOKEN_PLAN_CN_BASE_URL } from "../src/models/mimo-token-plan-cn-contract";
import type { ToolsMode } from "../src/tools/tools";

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
// Unit-test credential round-tripping only; real encryption is covered by Electron tests.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => "unknown" as const,
  encryptString: (value: string) => Buffer.from(value, "utf8"),
  encryptStringAsync: async (value: string) => Buffer.from(value, "utf8"),
  decryptString: (value: Buffer) => value.toString("utf8"),
  decryptStringAsync: async (value: Buffer) => ({
    result: value.toString("utf8"),
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
    if (url.href !== `${MIMO_TOKEN_PLAN_CN_BASE_URL}/responses`) {
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
      safeStorage: fakeSafeStorage,
      environment: {},
    });
    await configuration.management.initialize({
      vendors: [
        {
          id: "loopback",
          kind: "mimo-token-plan-cn",
          label: "Native consumer fixture",
          protocol: "openai",
          baseURL: MIMO_TOKEN_PLAN_CN_BASE_URL,
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
  content: [{ type: "reasoning_text", text: "private reasoning must not reach the terminal" }],
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
  textOutput("Need permission to inspect notes."),
  toolCall("read-1", "read", { path: "notes.txt" }),
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
    expect(f.publicURLs).toEqual([`${MIMO_TOKEN_PLAN_CN_BASE_URL}/responses`]);
    expect(f.authorizations).toEqual(["Bearer first-stored-key"]);
    expect(host.binding.toolMode).toBe("read-only");
    const tools = f.requests[0].tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual(["glob", "grep", "read"]);
    await expect(readFile(join(f.workspace, "deck/snapshot.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reads only after approval, survives reopening, accepts credential rotation, and keeps private replay off public output", async () => {
    const f = await fixture((body, response) => {
      const toolResult = lastToolResult(body);
      if (!toolResult) respondNative(response, readCall);
      else {
        expect(JSON.parse(toolResult.output!)).toMatchObject({
          path: "notes.txt",
          content: "revision written after approval was requested",
        });
        expect(JSON.parse(toolResult.output!)).toMatchObject({
          startOffset: 0,
          endOffset: "revision written after approval was requested".length,
          totalCharacters: "revision written after approval was requested".length,
          hasMore: false,
          version: expect.any(String),
        });
        expect(body.input).toEqual(expect.arrayContaining([privateReasoning]));
        respondNative(response, [textOutput("The updated file was read.")]);
      }
    });
    let host = await f.open(await f.configure());
    const waiting = await (await host.run(question)).completed;
    expect(waiting.status).toBe("waiting");
    if (waiting.status !== "waiting") throw new Error("Expected approval");
    expect(waiting.interaction).toMatchObject({
      owner: "host-permissions",
      payload: {
        type: "host.workspace-tool",
        version: 1,
        data: { tool: "read", path: "notes.txt", workspaceId: expect.any(String) },
      },
    });
    expect(f.requests).toHaveLength(1);
    await host.close();
    const stored = createSqliteAgentStores(join(f.directory, "agent-development.sqlite"));
    try {
      expect((await stored.history.read("thread")).messages).toEqual(question.input);
      expect(await stored.checkpoints.findUnfinished("development-agent", "thread")).toMatchObject({
        status: "waiting",
        inflight: { completed: [] },
      });
    } finally {
      await stored.dispose();
    }
    await writeFile(
      join(f.workspace, "notes.txt"),
      "revision written after approval was requested",
      "utf8",
    );
    host = await f.open(await f.configure("rotated-stored-key"), { resume: true });
    const resumed = await host.resume({
      queryId: "query",
      runId: "run-2",
      response: { interactionId: waiting.interaction.id, type: "answer", value: true },
    });
    const result = await resumed.completed;
    expect(result.status).toBe("completed");
    const projections: object[] = [projectDevelopmentResult(result)];
    for await (const event of resumed.events) {
      const value = projectDevelopmentEvent(event);
      if (value) projections.push(value);
    }
    const publicOutput = JSON.stringify(projections);
    expect(publicOutput).toContain("The updated file was read.");
    expect(publicOutput).not.toContain("private reasoning");
    expect(publicOutput).not.toContain("replayState");
    expect(publicOutput).not.toContain("stored-key");
    expect(publicOutput).not.toContain("opaque-private-replay");
    expect(f.requests).toHaveLength(2);
    expect(f.authorizations).toEqual(["Bearer first-stored-key", "Bearer rotated-stored-key"]);
  });

  it("rejects a different workspace before resuming a pending read", async () => {
    const f = await fixture((_body, response) => respondNative(response, readCall));
    const configuration = await f.configure();
    const host = await f.open(configuration);
    expect((await (await host.run(question)).completed).status).toBe("waiting");
    await host.close();
    const other = join(f.directory, "other-workspace");
    await mkdir(other);
    await writeFile(join(other, "notes.txt"), "must not enter original thread", "utf8");
    await expect(
      f.open(configuration, { workspaceRoot: other, resume: true }),
    ).rejects.toMatchObject({ code: "HOST_BINDING_CHANGED" });
    expect(f.requests).toHaveLength(1);
  });

  it("rejects a tool-mode change before resuming a pending call", async () => {
    const f = await fixture((_body, response) => respondNative(response, readCall));
    const configuration = await f.configure();
    const host = await f.open(configuration);
    expect((await (await host.run(question)).completed).status).toBe("waiting");
    await host.close();
    await expect(
      f.open(configuration, { toolMode: "read-write", resume: true }),
    ).rejects.toMatchObject({ code: "HOST_BINDING_CHANGED" });
    expect(f.requests).toHaveLength(1);
  });

  it("does not install or execute a mutator in the default read-only mode", async () => {
    const f = await fixture((body, response) => {
      if (lastToolResult(body)) {
        respondNative(response, [textOutput("The write tool is unavailable.")]);
      } else {
        respondNative(response, [
          toolCall("unavailable-write", "write", {
            path: "created.txt",
            content: "not permitted",
            mode: "create",
          }),
        ]);
      }
    });
    const host = await f.open(await f.configure());
    expect((await (await host.run(question)).completed).status).toBe("completed");
    await expect(readFile(join(f.workspace, "created.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

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

  it("executes an explicit writable installation only after separate read and edit approvals", async () => {
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
        const output = JSON.parse(last.output!) as { version: string };
        expect(output).toMatchObject({
          path: "notes.txt",
          replacements: 1,
          size: Buffer.byteLength(replacement),
        });
        editedVersion = output.version;
        respondNative(response, [textOutput("The approved edit succeeded.")]);
      }
    });
    const host = await f.open(await f.configure(), { toolMode: "read-write" });
    expect(host.binding.toolMode).toBe("read-write");
    const reading = await (await host.run(question)).completed;
    if (reading.status !== "waiting") throw new Error("Expected read approval");
    expect(await readFile(join(f.workspace, "notes.txt"), "utf8")).toBe("first file revision");
    const editing = await (
      await host.resume({
        queryId: "query",
        runId: "run-2",
        response: { type: "answer", interactionId: reading.interaction.id, value: true },
      })
    ).completed;
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
        runId: "run-3",
        response: { type: "answer", interactionId: editing.interaction.id, value: true },
      })
    ).completed;
    expect(completed.status).toBe("completed");
    expect(editedVersion).toEqual(expect.any(String));
    expect(await readFile(join(f.workspace, "notes.txt"), "utf8")).toBe(replacement);
    const tools = f.requests[0].tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "edit",
      "glob",
      "grep",
      "read",
      "write",
    ]);
  });

  it.each([
    { tool: "glob", input: { pattern: "*.txt" }, path: "*.txt" },
    { tool: "grep", input: { pattern: "first file revision" }, path: "**/*" },
  ])(
    "approves and executes $tool without exposing search text in its payload",
    async ({ tool, input, path }) => {
      const f = await fixture((body, response) => {
        const toolResult = lastToolResult(body);
        if (toolResult) {
          const output = JSON.parse(toolResult.output!) as {
            matches: unknown[];
            truncated: boolean;
          };
          expect(output.truncated).toBe(false);
          expect(output.matches).toEqual(
            tool === "glob"
              ? ["notes.txt"]
              : [
                  expect.objectContaining({
                    path: "notes.txt",
                    line: 1,
                    text: "first file revision",
                  }),
                ],
          );
          respondNative(response, [textOutput("Search completed.")]);
        } else {
          respondNative(response, [toolCall("search-1", tool, input)]);
        }
      });
      const host = await f.open(await f.configure());
      const waiting = await (await host.run(question)).completed;
      if (waiting.status !== "waiting") throw new Error("Expected search approval");
      expect(waiting.interaction.payload).toEqual({
        type: "host.workspace-tool",
        version: 1,
        data: { tool, path, workspaceId: expect.any(String) },
      });
      const result = await (
        await host.resume({
          queryId: "query",
          runId: "run-2",
          response: { type: "answer", interactionId: waiting.interaction.id, value: true },
        })
      ).completed;
      expect(result.status).toBe("completed");
    },
  );

  it("does not turn denied approval into file contents", async () => {
    const f = await fixture((body, response) => {
      const toolResult = lastToolResult(body);
      if (!toolResult) respondNative(response, readCall);
      else {
        expect(toolResult.output).not.toContain("first file revision");
        respondNative(response, [textOutput("Read was denied; no file contents are available.")]);
      }
    });
    const host = await f.open(await f.configure());
    const waiting = await (await host.run(question)).completed;
    if (waiting.status !== "waiting") throw new Error("Expected approval");
    const result = await (
      await host.resume({
        queryId: "query",
        runId: "run-2",
        response: { interactionId: waiting.interaction.id, type: "reject" },
      })
    ).completed;
    expect(result).toMatchObject({
      status: "completed",
      output: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "Read was denied; no file contents are available." }],
        }),
      ]),
    });
  });

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
    const output = JSON.stringify(projectDevelopmentResult(result));
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

  it("rejects model changes and custom routing even at the native URL before resuming a pending read", async () => {
    const f = await fixture((_body, response) => respondNative(response, readCall));
    const configuration = await f.configure();
    const host = await f.open(configuration);
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
      f.open(configuration, { resume: true, modelId: "other-model" }),
    ).rejects.toMatchObject({ code: "HOST_BINDING_CHANGED" });
    // A fixed native endpoint cannot be edited. A custom profile at that same URL
    // must not inherit native admission or fall back to the legacy Gateway.
    await configuration.management.saveVendor({
      vendor: { ...vendor, kind: "custom" },
      credential: { type: "replace", apiKey: "custom-stored-key" },
    });
    await expect(f.open(configuration, { resume: true })).rejects.toMatchObject({
      code: "MODEL_ADAPTER_UNSUPPORTED",
    });
    expect(f.requests).toHaveLength(1);
  });

  it("defaults CLI tools to read-only and accepts only the explicit writable mode", () => {
    expect(parseDevelopmentArguments(["--model", "m", "--workspace", "w"])).toMatchObject({
      command: { toolMode: "read-only" },
    });
    expect(
      parseDevelopmentArguments(["--model", "m", "--workspace", "w", "--tools", "read-write"]),
    ).toMatchObject({
      command: { toolMode: "read-write" },
    });
  });

  it("rejects contradictory CLI admission instead of silently choosing a new query", () => {
    for (const args of [
      ["--model", "m", "--workspace", "w", "--resume", "q"],
      [
        "--model",
        "m",
        "--workspace",
        "w",
        "--thread",
        "t",
        "--resume",
        "q",
        "--prompt",
        "new input",
      ],
      ["--model", "m", "--model", "other", "--workspace", "w"],
      ["--model", "m", "--workspace", "w", "--tools", "write"],
    ]) {
      expect(() => parseDevelopmentArguments(args)).toThrow(
        expect.objectContaining({ code: "CLI_ARGUMENTS_INVALID" }),
      );
    }
  });
});
