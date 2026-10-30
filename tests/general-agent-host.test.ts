import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModelMessage,
  ModelSelection,
  ModelStreamEvent,
} from "../src/agent/model/model-contract";
import type { CheckpointKey } from "../src/agent/session/checkpoint-contract";
import type { AgentCheckpoint } from "../src/agent/session/session-contract";
import { AgentGateway } from "../src/main/agent/gateway";
import {
  createGatewayModelFactory,
  type GatewayModelBindingSource,
} from "../src/main/agent-host/gateway-model-factory";
import { createSqliteAgentStores } from "../src/main/agent-host/sqlite-agent-stores";

const cleanup: Array<() => void | Promise<void>> = [];
const selected: ModelSelection = { providerId: "configured-host", modelId: "host-model" };
const key: CheckpointKey = { agentId: "agent", threadId: "thread", queryId: "query" };
const user: ModelMessage = { role: "user", content: [{ type: "text", text: "inspect this" }] };

beforeEach(() => {
  vi.stubEnv("AGENT_LOG_FILE", "false");
  vi.stubEnv("AGENT_GATEWAY_IO_LOG", "false");
});

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllEnvs();
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "general-agent-host-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "agent.sqlite");
}

function openStores(path: string) {
  const stores = createSqliteAgentStores(path);
  cleanup.push(() => stores.dispose());
  return stores;
}

function checkpoint(
  identity: CheckpointKey = key,
  status: AgentCheckpoint["status"] = "running",
): AgentCheckpoint {
  const base = {
    schemaVersion: 1 as const,
    ...identity,
    lastRunId: "run",
    definition: { id: "definition", version: "1" },
    plugins: [],
    model: selected,
    committed: { historyRevision: 0, messages: [], step: 0 },
    startMessageCount: 0,
    maxSteps: 8,
    extensions: [],
  };
  if (status === "waiting") {
    const call = { type: "tool-call" as const, callId: "pending", name: "approval", input: {} };
    return {
      ...base,
      status,
      inflight: {
        type: "tools",
        response: { message: { role: "assistant", content: [call] }, finishReason: "tool-calls" },
        remaining: [],
        completed: [],
      },
      pending: {
        invocation: {
          identity: { ...identity, runId: "run" },
          call,
          toolVersion: "1",
          state: "pending",
        },
        interaction: {
          id: "question",
          owner: "approval",
          payload: { type: "approval", version: 1, data: {} },
        },
        continuation: { type: "approval", version: 1, data: { callId: "pending" } },
        effects: "none",
      },
    };
  }
  if (status === "failed")
    return { ...base, status, error: { code: "failure", message: "failed" } };
  return { ...base, status };
}

describe("durable general agent stores", () => {
  it("reopens committed history, checkpoint snapshots, revisions, and active writer fences", async () => {
    const path = databasePath();
    const first = openStores(path);
    const activation = await first.checkpoints.acquire(key, "writer-1");
    if (activation.status !== "acquired") throw new Error("Expected first writer.");
    const saved = checkpoint();
    expect(await first.history.append(key.threadId, 0, [user], "input")).toEqual({
      status: "appended",
      revision: 1,
    });
    expect(await first.checkpoints.save(activation.lease, 0, saved)).toEqual({
      status: "saved",
      revision: 1,
    });
    await first.dispose();
    const reopened = openStores(path);
    expect(await reopened.history.read(key.threadId)).toEqual({
      threadId: key.threadId,
      revision: 1,
      messages: [user],
    });
    expect(await reopened.checkpoints.findUnfinished(key.agentId, key.threadId)).toEqual(saved);
    expect(await reopened.checkpoints.acquire(key, "writer-2")).toEqual({
      status: "busy",
      lease: activation.lease,
    });
    const next = await reopened.checkpoints.acquire(key, "writer-2", { replace: activation.lease });
    expect(next).toEqual({
      status: "acquired",
      lease: { key, ownerId: "writer-2", generation: 2 },
      currentRevision: 1,
      checkpoint: saved,
    });
    if (next.status !== "acquired") throw new Error("Expected takeover.");
    expect(
      await reopened.checkpoints.save(activation.lease, 1, checkpoint(key, "completed")),
    ).toEqual({ status: "stale" });
    await reopened.checkpoints.release(activation.lease);
    expect(await reopened.checkpoints.acquire(key, "third")).toEqual({
      status: "busy",
      lease: next.lease,
    });
    await reopened.checkpoints.release(next.lease);
    expect(
      await reopened.checkpoints.acquire(key, "stale-takeover", { replace: next.lease }),
    ).toEqual({ status: "stale" });
    const third = await reopened.checkpoints.acquire(key, "writer-2");
    expect(third).toMatchObject({
      status: "acquired",
      lease: { generation: 3 },
      currentRevision: 1,
      checkpoint: saved,
    });
  });

  it("enforces CAS across connections and compares the complete observed takeover lease", async () => {
    const path = databasePath();
    const first = openStores(path);
    const second = openStores(path);
    const initial = await first.checkpoints.acquire(key, "same-owner");
    if (initial.status !== "acquired") throw new Error("Expected acquisition.");
    expect(await second.checkpoints.acquire(key, "same-owner")).toEqual({
      status: "busy",
      lease: initial.lease,
    });
    for (const replace of [
      { ...initial.lease, ownerId: "foreign" },
      { ...initial.lease, generation: 0 },
      { ...initial.lease, key: { ...key, queryId: "foreign" } },
    ]) {
      expect(await second.checkpoints.acquire(key, "replacement", { replace })).toEqual({
        status: "stale",
      });
    }
    expect(await first.checkpoints.save(initial.lease, 0, checkpoint())).toEqual({
      status: "saved",
      revision: 1,
    });
    expect(await second.checkpoints.save(initial.lease, 0, checkpoint(key, "completed"))).toEqual({
      status: "conflict",
      currentRevision: 1,
    });
    await expect(
      second.checkpoints.save(initial.lease, 1, checkpoint({ ...key, threadId: "wrong" })),
    ).rejects.toMatchObject({ code: "checkpoint-key-mismatch" });
    const takeover = await second.checkpoints.acquire(key, "replacement", {
      replace: initial.lease,
    });
    if (takeover.status !== "acquired") throw new Error("Expected takeover.");
    expect(await first.checkpoints.save(initial.lease, 0, checkpoint())).toEqual({
      status: "stale",
    });
    expect(await second.checkpoints.save(takeover.lease, 1, checkpoint(key, "completed"))).toEqual({
      status: "saved",
      revision: 2,
    });
    expect(await first.checkpoints.findUnfinished(key.agentId, key.threadId)).toBeNull();
  });

  it("finds the most recently saved running, waiting, or interrupted query, not a terminal query", async () => {
    const stores = openStores(databasePath());
    expect(await stores.checkpoints.findUnfinished("agent", "thread")).toBeNull();
    for (const [queryId, status] of [
      ["running", "running"],
      ["waiting", "waiting"],
      ["interrupted", "interrupted"],
      ["terminal", "completed"],
    ] as const) {
      const identity = { ...key, queryId };
      const activation = await stores.checkpoints.acquire(identity, queryId);
      if (activation.status !== "acquired") throw new Error("Expected acquisition.");
      await stores.checkpoints.save(activation.lease, 0, checkpoint(identity, status));
      await stores.checkpoints.release(activation.lease);
    }
    expect(await stores.checkpoints.findUnfinished("agent", "thread")).toMatchObject({
      queryId: "interrupted",
      status: "interrupted",
    });
    expect(await stores.checkpoints.findUnfinished("other-agent", "thread")).toBeNull();
    const interrupted = await stores.checkpoints.acquire(
      { ...key, queryId: "interrupted" },
      "close",
    );
    if (interrupted.status !== "acquired") throw new Error("Expected acquisition.");
    await stores.checkpoints.save(
      interrupted.lease,
      1,
      checkpoint(interrupted.lease.key, "cancelled"),
    );
    expect(await stores.checkpoints.findUnfinished("agent", "thread")).toMatchObject({
      queryId: "waiting",
      status: "waiting",
    });
  });

  it("deduplicates a lost append receipt after restart and rejects batch payload reuse", async () => {
    const path = databasePath();
    const first = openStores(path);
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", callId: "call", name: "read", input: { a: 1, b: 2 } }],
      },
    ];
    expect(await first.history.append("thread", 0, messages, "committed-before-crash")).toEqual({
      status: "appended",
      revision: 1,
    });
    await first.dispose();
    const next = openStores(path);
    const reordered: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", callId: "call", name: "read", input: { b: 2, a: 1 } }],
      },
    ];
    expect(await next.history.append("thread", 0, reordered, "committed-before-crash")).toEqual({
      status: "appended",
      revision: 1,
    });
    await next.history.append("thread", 1, [user], "later");
    expect(await next.history.append("thread", 2, messages, "committed-before-crash")).toEqual({
      status: "appended",
      revision: 1,
    });
    await expect(
      next.history.append("thread", 2, [user], "committed-before-crash"),
    ).rejects.toMatchObject({ code: "history-batch-conflict" });
    expect(await next.history.read("thread")).toEqual({
      threadId: "thread",
      revision: 2,
      messages: [...messages, user],
    });
    expect(await next.history.append("other-thread", 0, [user], "committed-before-crash")).toEqual({
      status: "appended",
      revision: 1,
    });
  });

  it("does not reserve an uncommitted batch on CAS conflict and rejects lossy protocol values", async () => {
    const stores = openStores(databasePath());
    expect(await stores.history.read("absent")).toEqual({
      threadId: "absent",
      revision: 0,
      messages: [],
    });
    expect(await stores.history.append("thread", 1, [user], "not-committed")).toEqual({
      status: "conflict",
      currentRevision: 0,
    });
    expect(await stores.history.append("thread", 0, [user], "not-committed")).toEqual({
      status: "appended",
      revision: 1,
    });
    for (const value of [undefined, Number.NaN, new Date(), { invalid: undefined }]) {
      const invalid = [
        {
          role: "assistant",
          content: [{ type: "tool-call", callId: "invalid", name: "read", input: { value } }],
        },
      ] as unknown as ModelMessage[];
      await expect(stores.history.append("thread", 1, invalid, "invalid")).rejects.toMatchObject({
        code: "INVALID_PROTOCOL_VALUE",
      });
    }
    const read = await stores.history.read("thread");
    Object.assign(read.messages[0].content[0], { text: "mutated caller copy" });
    expect((await stores.history.read("thread")).messages).toEqual([user]);
    await stores.dispose();
    await expect(stores.history.append("thread", 1, [user], "closed")).rejects.toMatchObject({
      code: "store-disposed",
    });
    expect(() => createSqliteAgentStores(":memory:")).toThrow("persistent database");
  });
});

interface HttpReply {
  readonly body?: unknown;
  readonly sse?: string;
  readonly status?: number;
}

async function host(
  callPath: GatewayModelBindingSource["callPath"],
  respond: (body: Record<string, unknown>, count: number) => HttpReply,
) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>;
      requests.push({ path: request.url ?? "", body });
      const reply = respond(body, requests.length);
      response.writeHead(reply.status ?? 200, {
        "content-type": reply.sse !== undefined ? "text/event-stream" : "application/json",
      });
      response.end(reply.sse ?? JSON.stringify(reply.body));
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
  if (!address || typeof address === "string") throw new Error("Expected local HTTP address.");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const gateway = new AgentGateway();
  const oldSelection = gateway.configure({
    provider: callPath === "anthropic" ? "anthropic" : "openai",
    model: "host-model",
    apiKey: "host-secret-key",
    baseURL: endpoint,
    ...(callPath !== "anthropic"
      ? { openaiApiMode: callPath === "chat" ? "chat-completions" : "responses" }
      : {}),
  });
  const source: GatewayModelBindingSource = {
    gateway,
    selection: oldSelection,
    callPath,
    replayScope: endpoint,
    capabilities: {
      streaming: true,
      toolCalls: true,
      images: callPath !== "chat",
      reasoning: true,
    },
  };
  const factory = createGatewayModelFactory(() => source);
  const binding = await factory.create(selected, new AbortController().signal);
  cleanup.push(() => binding.dispose());
  return { requests, source, factory, binding };
}

function anthropic(content: unknown[], stopReason = "end_turn") {
  return {
    id: "msg_host",
    type: "message",
    role: "assistant",
    model: "host-model",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 3 },
  };
}

function chat(content: Record<string, unknown>) {
  return {
    id: "chat_host",
    object: "chat.completion",
    created: 1,
    model: "host-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", ...content },
        finish_reason: content.tool_calls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
  };
}

describe("GatewayModelFactory network consumers", () => {
  it("calls real Anthropic HTTP transport, persists canonical calls, and round-trips signatures and redacted blocks", async () => {
    const original = [
      { type: "thinking", thinking: "public reasoning", signature: "provider-signature" },
      { type: "redacted_thinking", data: "opaque-private-data" },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "read-1", name: "read", input: { path: "first" } },
      { type: "tool_use", id: "read-2", name: "read", input: { path: "second" } },
    ];
    const network = await host("anthropic", (_body, count) => ({
      body: anthropic(
        count === 1 ? original : [{ type: "text", text: "Finished." }],
        count === 1 ? "tool_use" : "end_turn",
      ),
    }));
    const image: ModelMessage = {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", mediaType: "image/png", data: "aGVsbG8=" } },
      ],
    };
    const answer = await network.binding.client.generate(
      {
        messages: [
          { role: "system", content: [{ type: "text", text: "Act carefully." }] },
          user,
          image,
        ],
        tools: [
          {
            name: "read",
            description: "Read a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        maxOutputTokens: 123,
      },
      new AbortController().signal,
    );
    expect(answer).toMatchObject({
      finishReason: "tool-calls",
      usage: { inputTokens: 4, outputTokens: 3 },
      message: {
        content: [
          { type: "reasoning", text: "public reasoning" },
          { type: "text", text: "Checking." },
          { type: "tool-call", callId: "read-1", name: "read", input: { path: "first" } },
          { type: "tool-call", callId: "read-2", name: "read", input: { path: "second" } },
        ],
      },
    });
    expect(network.requests[0]).toMatchObject({
      path: "/v1/messages",
      body: {
        system: "Act carefully.",
        max_tokens: 123,
        tools: [{ name: "read", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "inspect this" }] },
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(answer)).not.toContain("host-secret-key");
    expect(JSON.stringify(answer.message.content)).not.toContain("opaque-private-data");
    const path = databasePath();
    const stores = openStores(path);
    await stores.history.append("conversation", 0, [user, answer.message], "answer");
    await stores.dispose();
    const persisted = await openStores(path).history.read("conversation");
    const result = await network.binding.client.generate(
      {
        messages: [
          ...persisted.messages,
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                callId: "read-1",
                content: [{ type: "text", text: "first result" }],
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                callId: "read-2",
                content: [{ type: "text", text: "failed read" }],
                isError: true,
              },
            ],
          },
        ],
      },
      new AbortController().signal,
    );
    expect(result.message.content).toEqual([{ type: "text", text: "Finished." }]);
    const sent = network.requests[1].body.messages as Array<{ content: unknown[] }>;
    expect(sent[1].content).toEqual(original);
    expect(sent[2].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "read-1",
        content: [{ type: "text", text: "first result" }],
      },
      {
        type: "tool_result",
        tool_use_id: "read-2",
        content: [{ type: "text", text: "failed read" }],
        is_error: true,
      },
    ]);
  });

  it("rejects foreign, modified, and cross-connection replay before another HTTP dispatch", async () => {
    const network = await host("anthropic", () => ({
      body: anthropic([
        { type: "thinking", thinking: "reasoning", signature: "signed" },
        { type: "text", text: "answer" },
      ]),
    }));
    const response = await network.binding.client.generate(
      { messages: [user] },
      new AbortController().signal,
    );
    const state = response.message.replayState;
    if (!state) throw new Error("Expected private replay.");
    for (const message of [
      { ...response.message, replayState: { ...state, providerId: "another-host" } },
      { ...response.message, replayState: { ...state, version: 2 } },
      { ...response.message, content: [{ type: "text" as const, text: "tampered" }] },
    ]) {
      await expect(
        network.binding.client.generate(
          { messages: [user, message] },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(Error);
    }
    const other = await createGatewayModelFactory(() => ({
      ...network.source,
      replayScope: "different-endpoint",
    })).create(selected, new AbortController().signal);
    cleanup.push(() => other.dispose());
    await expect(
      other.client.generate({ messages: [user, response.message] }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "incompatible-model-replay" });
    expect(network.requests).toHaveLength(1);
  });

  it("round-trips Chat reasoning with exact tool IDs and rejects unsupported images and malformed arguments", async () => {
    const network = await host("chat", (_body, count) => ({
      body: chat(
        count === 1
          ? {
              content: "read",
              reasoning_content: "plan",
              tool_calls: [
                {
                  id: "chat-call",
                  type: "function",
                  function: { name: "read", arguments: '{"path":"file"}' },
                },
              ],
            }
          : { content: "done" },
      ),
    }));
    const response = await network.binding.client.generate(
      { messages: [user] },
      new AbortController().signal,
    );
    expect(response.message.content).toEqual([
      { type: "reasoning", text: "plan" },
      { type: "text", text: "read" },
      { type: "tool-call", callId: "chat-call", name: "read", input: { path: "file" } },
    ]);
    await network.binding.client.generate(
      {
        messages: [
          user,
          response.message,
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                callId: "chat-call",
                content: [{ type: "text", text: "result" }],
              },
            ],
          },
        ],
      },
      new AbortController().signal,
    );
    expect(network.requests[1].body.messages).toEqual([
      { role: "user", content: "inspect this" },
      {
        role: "assistant",
        content: "read",
        reasoning_content: "plan",
        tool_calls: [
          {
            id: "chat-call",
            type: "function",
            function: { name: "read", arguments: '{"path":"file"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "chat-call", content: "result" },
    ]);
    await expect(
      network.binding.client.generate(
        {
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", mediaType: "image/png", data: "AAAA" } },
              ],
            },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "unsupported-model-images" });
    expect(network.requests).toHaveLength(2);
    const invalid = await host("chat", () => ({
      body: chat({
        content: null,
        tool_calls: [
          { id: "broken", type: "function", function: { name: "read", arguments: "{broken" } },
        ],
      }),
    }));
    await expect(
      invalid.binding.client.generate({ messages: [user] }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-tool-arguments" });
  });

  it("retains Responses reasoning but refuses its unsupported private replay rather than silently dropping it", async () => {
    const network = await host("responses", () => ({
      body: {
        id: "resp_host",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "host-model",
        output_text: "answer",
        output: [
          {
            id: "reasoning-id",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "summary" }],
          },
          {
            id: "message",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "answer", annotations: [] }],
          },
        ],
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
      },
    }));
    const response = await network.binding.client.generate(
      { messages: [user] },
      new AbortController().signal,
    );
    expect(response.message.content).toEqual([
      { type: "reasoning", text: "summary" },
      { type: "text", text: "answer" },
    ]);
    await expect(
      network.binding.client.generate(
        { messages: [user, response.message] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "unsupported-model-replay" });
    expect(network.requests).toHaveLength(1);
  });

  it("consumes actual SDK SSE and publishes only the authoritative canonical completion", async () => {
    const events = [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            ...anthropic([]),
            stop_reason: null,
            usage: { input_tokens: 4, output_tokens: 0 },
          },
        },
      ],
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "streamed answer" },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 3 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ];
    const sse = events
      .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      .join("");
    const network = await host("anthropic", () => ({ sse }));
    const received: ModelStreamEvent[] = [];
    for await (const event of network.binding.client.stream(
      { messages: [user] },
      new AbortController().signal,
    ))
      received.push(event);
    expect(received).toEqual([
      {
        type: "completed",
        response: {
          message: { role: "assistant", content: [{ type: "text", text: "streamed answer" }] },
          finishReason: "stop",
          usage: { inputTokens: 4, outputTokens: 3 },
        },
      },
    ]);
    expect(network.requests[0].body.stream).toBe(true);
  });

  it("does not expose provider error secrets or publish a completion from failed HTTP transport", async () => {
    const network = await host("anthropic", () => ({
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "host-secret-key in provider diagnostics",
        },
      },
    }));
    await expect(
      network.binding.client.generate({ messages: [user] }, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "model-gateway-failed",
      message: "Model Gateway request failed.",
    });
    const received: ModelStreamEvent[] = [];
    const consume = async () => {
      for await (const event of network.binding.client.stream(
        { messages: [user] },
        new AbortController().signal,
      ))
        received.push(event);
    };
    await expect(consume()).rejects.toMatchObject({
      code: "model-gateway-failed",
      message: "Model Gateway stream failed.",
    });
    expect(received).toEqual([]);
    expect(network.requests).toHaveLength(2);
  });

  it("rejects malformed histories and URL images, releases owned bindings once, and honors cancellation", async () => {
    const network = await host("anthropic", () => ({
      body: anthropic([{ type: "text", text: "unused" }]),
    }));
    for (const messages of [
      [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
          ],
        },
      ],
      [
        user,
        {
          role: "assistant",
          content: [{ type: "tool-call", callId: "unpaired", name: "read", input: {} }],
        },
      ],
      [user, { role: "system", content: [{ type: "text", text: "late" }] }],
      [user, { role: "assistant", content: [{ type: "reasoning", text: "lost signature" }] }],
    ] as readonly ModelMessage[][]) {
      await expect(
        network.binding.client.generate({ messages }, new AbortController().signal),
      ).rejects.toBeInstanceOf(Error);
    }
    let disposals = 0;
    const owned = await createGatewayModelFactory(() => ({
      ...network.source,
      dispose: async () => {
        disposals += 1;
      },
    })).create(selected, new AbortController().signal);
    await Promise.all([owned.dispose(), owned.dispose()]);
    expect(disposals).toBe(1);
    await expect(
      owned.client.generate({ messages: [user] }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "model-disposed" });
    const cancelled = new AbortController();
    cancelled.abort("private cancellation reason");
    await expect(
      network.binding.client.generate({ messages: [user] }, cancelled.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      createGatewayModelFactory(() => {
        throw new Error("host-secret-key");
      }).create(selected, new AbortController().signal),
    ).rejects.toMatchObject({ message: "Host could not resolve the requested model." });
    expect(network.requests).toHaveLength(0);
  });
});
