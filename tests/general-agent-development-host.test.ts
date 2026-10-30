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

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const unavailableStorage = {
  isEncryptionAvailable: () => false,
  async isAsyncEncryptionAvailable() {
    return false;
  },
  getSelectedStorageBackend: () => "unknown" as const,
  encryptString(): Buffer {
    throw new Error("This fixture uses endpoint-bound environment credentials");
  },
  async encryptStringAsync(): Promise<Buffer> {
    throw new Error("This fixture uses endpoint-bound environment credentials");
  },
  decryptString(): string {
    throw new Error("This fixture has no stored credential");
  },
  async decryptStringAsync(): Promise<{ result: string; shouldReEncrypt: boolean }> {
    throw new Error("This fixture has no stored credential");
  },
};

async function fixture(
  respond: (body: Record<string, unknown>, response: ServerResponse) => void | Promise<void>,
) {
  vi.stubEnv("AGENT_LOG_FILE", "false");
  vi.stubEnv("AGENT_GATEWAY_IO_LOG", "false");
  const directory = await mkdtemp(join(tmpdir(), "general-agent-development-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "notes.txt"), "first file revision", "utf8");
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(body);
      await respond(body, response);
    })().catch(() => {
      response.writeHead(500);
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
  const configure = async (
    key = "first-environment-key",
    baseURL = endpoint,
  ): Promise<AgentConfiguration> => {
    const configuration = createAgentConfiguration({
      applicationDataRoot: directory,
      safeStorage: unavailableStorage,
      environment: { OPENAI_API_KEY: key, OPENAI_BASE_URL: baseURL },
    });
    await configuration.management.initialize({
      vendors: [
        {
          id: "loopback",
          kind: "custom",
          label: "Local consumer fixture",
          protocol: "openai",
          baseURL,
          enabled: true,
          models: [
            {
              id: "configured-model",
              name: "Local model",
              model: "remote-model",
              enabled: true,
              openaiApiMode: "chat-completions",
            },
          ],
        },
      ],
      gateway: { timeoutMs: 5000, maxOutputTokens: 1024 },
      stepLimits: { enabled: true, mainMaxSteps: 4, subMaxSteps: 2 },
      executionStrategy: "REQUEST_APPROVAL",
      defaultTemplateId: "builtin/swiss-minimal",
    });
    return configuration;
  };
  const open = async (
    configuration: AgentConfiguration,
    overrides: { workspaceRoot?: string; resume?: boolean; modelId?: string } = {},
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
  return { directory, workspace, endpoint, requests, configure, open };
}

function respondChat(response: ServerResponse, message: Record<string, unknown>) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "chat_fixture",
      object: "chat.completion",
      created: 1,
      model: "remote-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", ...message },
          finish_reason: message.tool_calls ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }),
  );
}
const readCall = {
  content: "Need permission to inspect notes.",
  reasoning_content: "private reasoning must not reach the terminal",
  tool_calls: [
    {
      id: "read-1",
      type: "function",
      function: { name: "ReadFile", arguments: JSON.stringify({ path: "notes.txt" }) },
    },
  ],
};
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
      respondChat(response, { content: "ordinary answer" }),
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
    expect(f.requests[0]).toMatchObject({ model: "remote-model", max_tokens: 1024 });
    await expect(readFile(join(f.workspace, "deck/snapshot.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reads only after approval, survives reopening, accepts credential rotation, and keeps private replay off public output", async () => {
    const f = await fixture((body, response) => {
      const messages = body.messages as Array<{ role: string; content: string }>;
      if (messages.at(-1)?.role !== "tool") respondChat(response, readCall);
      else {
        expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({
          path: "notes.txt",
          content: "revision written after approval was requested",
        });
        respondChat(response, { content: "The updated file was read." });
      }
    });
    let host = await f.open(await f.configure());
    const waiting = await (await host.run(question)).completed;
    expect(waiting.status).toBe("waiting");
    if (waiting.status !== "waiting") throw new Error("Expected approval");
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
    host = await f.open(await f.configure("rotated-environment-key"), { resume: true });
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
    expect(publicOutput).not.toContain("environment-key");
    expect(f.requests).toHaveLength(2);
  });

  it("rejects a different workspace before resuming a pending read", async () => {
    const f = await fixture((_body, response) => respondChat(response, readCall));
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

  it("does not turn denied approval into file contents", async () => {
    const f = await fixture((body, response) => {
      const messages = body.messages as Array<{ role: string; content: string }>;
      if (messages.at(-1)?.role !== "tool") respondChat(response, readCall);
      else {
        expect(messages.at(-1)!.content).not.toContain("first file revision");
        respondChat(response, { content: "Read was denied; no file contents are available." });
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
        {
          role: "assistant",
          content: [{ type: "text", text: "Read was denied; no file contents are available." }],
        },
      ]),
    });
  });

  it("routes provider failure diagnostics to private logs, not terminal output or successful completion", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture((_body, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "first-environment-key and private native diagnostic" },
        }),
      );
    });
    const host = await f.open(await f.configure());
    const result = await (await host.run(question)).completed;
    expect(result.status).toBe("failed");
    expect(error).not.toHaveBeenCalled();
    const output = JSON.stringify(projectDevelopmentResult(result));
    expect(output).not.toContain("first-environment-key");
    expect(output).not.toContain("private native diagnostic");
  });

  it("interrupts and releases a live HTTP query on host shutdown, then resumes it", async () => {
    const entered = Promise.withResolvers<void>();
    let hold = true;
    const f = await fixture((_body, response) => {
      if (hold) entered.resolve();
      else respondChat(response, { content: "Recovered response" });
    });
    const configuration = await f.configure();
    let host = await f.open(configuration);
    const running = await host.run(question);
    await entered.promise;
    await host.close();
    expect((await running.completed).status).toBe("interrupted");
    hold = false;
    host = await f.open(configuration, { resume: true });
    expect(await (await host.resume({ queryId: "query", runId: "run-2" })).completed).toMatchObject(
      { status: "completed", output: [{ content: [{ text: "Recovered response" }] }] },
    );
  });

  it("rejects configured model or endpoint changes before a pending read can use them", async () => {
    const f = await fixture((_body, response) => respondChat(response, readCall));
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
          { ...vendor.models[0], id: "other-model", model: "other-remote" },
        ],
      },
      credential: { type: "keep" },
    });
    await expect(
      f.open(configuration, { resume: true, modelId: "other-model" }),
    ).rejects.toMatchObject({ code: "HOST_BINDING_CHANGED" });
    const changedEndpoint = `${f.endpoint}/changed`;
    const changed = await f.configure("new-endpoint-key", changedEndpoint);
    await changed.management.saveVendor({
      vendor: { ...vendor, baseURL: changedEndpoint },
      credential: { type: "keep" },
    });
    await expect(f.open(changed, { resume: true })).rejects.toMatchObject({
      code: "HOST_BINDING_CHANGED",
    });
    expect(f.requests).toHaveLength(1);
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
    ]) {
      expect(() => parseDevelopmentArguments(args)).toThrow(
        expect.objectContaining({ code: "CLI_ARGUMENTS_INVALID" }),
      );
    }
  });
});
