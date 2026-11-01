import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ModelAssistantMessage,
  ModelRequest,
  ModelStreamEvent,
} from "@agent-harness/core/model/model-contract";
import type { ModelProvider, OpenAIChatOptions } from "@agent-harness/models/model-contract";
import { ModelProviderError } from "@agent-harness/models/model-errors";
import { createModelProvider } from "@agent-harness/models/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const adapterId = "openai-chat-completions";
const signal = () => new AbortController().signal;
const request: ModelRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};
let server: Server;
let baseURL: string;
let providers: ModelProvider[];
let observed: { path: string; authorization?: string; body: Record<string, unknown> }[];
let respond: (
  response: ServerResponse,
  body: Record<string, unknown>,
  request: IncomingMessage,
) => void;

function completion(
  message: unknown = { role: "assistant", content: "hello back" },
  finish = "stop",
) {
  return {
    id: "chatcmpl-local",
    object: "chat.completion",
    created: 1,
    model: "custom-model",
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  };
}
function sendJSON(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
function startSSE(response: ServerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
}
function chunk(response: ServerResponse, delta: unknown, finish: string | null = null) {
  response.write(
    `data: ${JSON.stringify({ id: "chatcmpl-local", object: "chat.completion.chunk", created: 1, model: "custom-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
  );
}
async function provider(overrides: Partial<OpenAIChatOptions> = {}) {
  const result = await createModelProvider(
    {
      adapterId,
      apiKey: "local-private-key",
      baseURL,
      connectionFingerprint: "connection-one",
      timeoutMs: 1500,
      maxOutputTokens: 512,
      ...overrides,
    },
    signal(),
  );
  providers.push(result);
  return result;
}
async function client(
  modelId = "custom-model",
  overrides: Partial<OpenAIChatOptions> = {},
  reasoningEffort?: string,
) {
  const value = await provider(overrides);
  const binding = await value.create(
    {
      providerId: adapterId,
      modelId,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
    signal(),
  );
  return { provider: value, binding, client: binding.client };
}
async function events(iterable: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const result: ModelStreamEvent[] = [];
  for await (const event of iterable) result.push(event);
  return result;
}

beforeEach(async () => {
  providers = [];
  observed = [];
  respond = (response) => sendJSON(response, completion());
  server = createServer(async (incoming, response) => {
    let raw = "";
    for await (const part of incoming) raw += part;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    observed.push({
      path: incoming.url ?? "",
      authorization: incoming.headers.authorization,
      body,
    });
    respond(response, body, incoming);
  });
  const ready = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterEach(async () => {
  await Promise.all(providers.map((value) => value.dispose()));
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
});

describe("OpenAI Chat Completions public adapter", () => {
  it("uses the real SDK for system, images, tools, usage and private reasoning roundtrip", async () => {
    const wire = {
      role: "assistant",
      content: "checking",
      reasoning_content: "private compatible reasoning",
      tool_calls: [
        {
          id: "call-local",
          type: "function",
          function: { name: "lookup", arguments: '{ "city" : "Paris" }' },
        },
      ],
    };
    respond = (response) =>
      sendJSON(response, observed.length === 1 ? completion(wire, "tool_calls") : completion());
    const { client: model } = await client();
    const initial: ModelRequest = {
      messages: [
        { role: "system", content: [{ type: "text", text: "system rule" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
            { type: "image", source: { type: "base64", mediaType: "image/png", data: "aGVsbG8=" } },
          ],
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Look up weather",
          inputSchema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      maxOutputTokens: 123,
    };
    const result = await model.generate(initial, signal());
    expect(result).toMatchObject({
      finishReason: "tool-calls",
      usage: { inputTokens: 12, outputTokens: 7 },
      message: {
        content: [
          { type: "reasoning", text: "private compatible reasoning" },
          { type: "text", text: "checking" },
          { type: "tool-call", callId: "call-local", name: "lookup", input: { city: "Paris" } },
        ],
      },
    });
    expect(observed[0]).toMatchObject({
      path: "/v1/chat/completions",
      authorization: "Bearer local-private-key",
      body: {
        max_tokens: 123,
        tools: [{ type: "function", function: { name: "lookup", strict: false } }],
        messages: [
          { role: "system", content: "system rule" },
          {
            role: "user",
            content: [
              { type: "text", text: "inspect" },
              { type: "image_url", image_url: { url: "https://example.test/image.png" } },
              { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
            ],
          },
        ],
      },
    });
    const final = await model.generate(
      {
        messages: [
          ...initial.messages,
          result.message,
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                callId: "call-local",
                isError: true,
                content: [
                  { type: "text", text: "not found" },
                  {
                    type: "image",
                    source: { type: "base64", mediaType: "image/png", data: "aGVsbG8=" },
                  },
                ],
              },
            ],
          },
        ],
      },
      signal(),
    );
    expect(final.finishReason).toBe("stop");
    expect((observed[1].body.messages as unknown[])[2]).toEqual(wire);
    expect((observed[1].body.messages as unknown[])[3]).toEqual({
      role: "tool",
      tool_call_id: "call-local",
      content: "[tool_error]\nnot found",
    });
    expect((observed[1].body.messages as unknown[])[4]).toMatchObject({
      role: "user",
      content: [{ type: "text" }, { type: "image_url" }],
    });
  });

  it("assembles fragmented tool arguments and preserves final content delta indices", async () => {
    respond = (response) => {
      startSSE(response);
      chunk(response, { role: "assistant", content: "first " });
      chunk(response, { reasoning_content: "reason" });
      chunk(response, {
        tool_calls: [
          {
            index: 1,
            id: "call-b",
            type: "function",
            function: { name: "second", arguments: '{"b":' },
          },
        ],
      });
      chunk(response, {
        content: "text",
        tool_calls: [
          {
            index: 0,
            id: "call-a",
            type: "function",
            function: { name: "first", arguments: '{"a":' },
          },
        ],
      });
      chunk(
        response,
        {
          tool_calls: [
            { index: 1, function: { arguments: "2}" } },
            { index: 0, function: { arguments: "1}" } },
          ],
        },
        "tool_calls",
      );
      response.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 9 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    };
    const { client: model } = await client();
    const all = await events(model.stream(request, signal()));
    const last = all.at(-1);
    expect(last).toMatchObject({
      type: "completed",
      response: {
        finishReason: "tool-calls",
        usage: { inputTokens: 4, outputTokens: 9 },
        message: {
          content: [
            { type: "text", text: "first text" },
            { type: "reasoning", text: "reason" },
            { type: "tool-call", callId: "call-a", input: { a: 1 } },
            { type: "tool-call", callId: "call-b", input: { b: 2 } },
          ],
        },
      },
    });
    expect(all.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(all.filter((event) => event.type === "content-delta")).toEqual([
      { type: "content-delta", index: 0, delta: { type: "text", text: "first " } },
      { type: "content-delta", index: 1, delta: { type: "reasoning", text: "reason" } },
      { type: "content-delta", index: 0, delta: { type: "text", text: "text" } },
      {
        type: "content-delta",
        index: 2,
        delta: { type: "tool-call", callId: "call-a", name: "first", inputDelta: '{"a":1}' },
      },
      {
        type: "content-delta",
        index: 3,
        delta: { type: "tool-call", callId: "call-b", name: "second", inputDelta: '{"b":2}' },
      },
    ]);
    if (last?.type !== "completed") throw new Error("Missing completed response");
    respond = (response) => sendJSON(response, completion());
    await model.generate({ messages: [last.response.message] }, signal());
    expect((observed[1].body.messages as Record<string, unknown>[])[0]).toMatchObject({
      role: "assistant",
      content: "first text",
      reasoning_content: "reason",
    });
  });

  it.each(["done", "eof"])(
    "never completes a %s stream without terminal finish_reason",
    async (ending) => {
      respond = (response) => {
        startSSE(response);
        chunk(response, {
          content: "partial",
          tool_calls: [
            {
              index: 0,
              id: "call-incomplete",
              type: "function",
              function: { name: "write", arguments: '{"path":' },
            },
          ],
        });
        response.end(ending === "done" ? "data: [DONE]\n\n" : "");
      };
      const { client: model } = await client();
      const seen: ModelStreamEvent[] = [];
      await expect(
        (async () => {
          for await (const event of model.stream(request, signal())) seen.push(event);
        })(),
      ).rejects.toMatchObject({ code: "INCOMPLETE_STREAM", adapterId });
      expect(
        seen.some((event) => event.type === "completed" || event.delta.type === "tool-call"),
      ).toBe(false);
    },
  );

  it("rejects truncated streams and strips partial calls from nonstream length responses", async () => {
    respond = (response, body) => {
      if (body.stream) {
        startSSE(response);
        chunk(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "call-truncated",
                type: "function",
                function: { name: "write", arguments: '{"partial":' },
              },
            ],
          },
          "length",
        );
        response.end("data: [DONE]\n\n");
      } else
        sendJSON(
          response,
          completion(
            {
              role: "assistant",
              content: "partial",
              tool_calls: [
                {
                  id: "call-truncated",
                  type: "function",
                  function: { name: "write", arguments: '{"partial":' },
                },
              ],
            },
            "length",
          ),
        );
    };
    const { client: model } = await client();
    const result = await model.generate(request, signal());
    expect(result).toEqual({
      finishReason: "length",
      usage: { inputTokens: 12, outputTokens: 7 },
      message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
    });
    await expect(events(model.stream(request, signal()))).rejects.toMatchObject({
      code: "TRUNCATED",
    });
  });

  it("rejects replay identity and visible content mismatches before transport", async () => {
    const { client: original } = await client("gpt-5", {}, "high");
    const result = await original.generate(request, signal());
    expect(observed[0].body).toMatchObject({
      reasoning_effort: "high",
      max_completion_tokens: 512,
    });
    const changedConnection = await client(
      "gpt-5",
      { connectionFingerprint: "connection-two" },
      "high",
    );
    const changedModel = await client("gpt-5-other", {}, "high");
    const changedEffort = await client("gpt-5", {}, "low");
    for (const model of [changedConnection.client, changedModel.client, changedEffort.client]) {
      await expect(model.generate({ messages: [result.message] }, signal())).rejects.toMatchObject({
        code: "REPLAY_INCOMPATIBLE",
      });
    }
    const changedContent: ModelAssistantMessage = {
      ...result.message,
      content: [{ type: "text", text: "tampered" }],
    };
    await expect(original.generate({ messages: [changedContent] }, signal())).rejects.toMatchObject(
      { code: "REPLAY_INCOMPATIBLE" },
    );
    const changedProvider: ModelAssistantMessage = {
      ...result.message,
      replayState: { ...result.message.replayState!, providerId: "other" },
    };
    await expect(
      original.generate({ messages: [changedProvider] }, signal()),
    ).rejects.toMatchObject({ code: "REPLAY_INCOMPATIBLE" });
    expect(observed).toHaveLength(1);
  });

  it("rejects unsupported effort on custom model IDs without a network call", async () => {
    const value = await provider();
    await expect(
      value.create(
        { providerId: adapterId, modelId: "compatible/custom", reasoningEffort: "high" },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "MODEL_CAPABILITY" });
    await expect(
      value.create({ providerId: adapterId, modelId: "gpt-5", reasoningEffort: "ultra" }, signal()),
    ).rejects.toMatchObject({ code: "MODEL_CAPABILITY" });
    expect(observed).toEqual([]);
  });

  it("sanitizes SDK authentication failures without retries or SDK causes", async () => {
    respond = (response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "local-private-key https://private.example.test",
            type: "authentication_error",
          },
        }),
      );
    };
    const { client: model } = await client();
    let failure: unknown;
    try {
      await model.generate(request, signal());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProviderError);
    expect(failure).toMatchObject({ code: "AUTHENTICATION", adapterId });
    expect(String(failure)).not.toMatch(/private|https/u);
    expect(JSON.stringify(failure)).not.toMatch(/private|cause|headers/u);
    expect(observed).toHaveLength(1);
  });

  it.each(["bad-json", "missing-choice", "bad-tool"])(
    "rejects malformed %s completion",
    async (mode) => {
      respond = (response) => {
        if (mode === "bad-json") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("not json");
        } else if (mode === "missing-choice") sendJSON(response, { choices: [] });
        else
          sendJSON(
            response,
            completion(
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-bad",
                    type: "function",
                    function: { name: "write", arguments: "[]" },
                  },
                ],
              },
              "tool_calls",
            ),
          );
      };
      const { client: model } = await client();
      await expect(model.generate(request, signal())).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        adapterId,
      });
    },
  );

  it("discovers IDs through the SDK without duplicate entries", async () => {
    respond = (response) =>
      sendJSON(response, {
        object: "list",
        data: [{ id: "custom-model" }, { id: "custom-model" }, { id: "vendor/model" }],
      });
    const value = await provider();
    await expect(value.discovery!.listModels(signal())).resolves.toEqual([
      { id: "custom-model", supported: true },
      { id: "vendor/model", supported: true },
    ]);
    expect(observed[0].path).toBe("/v1/models");
  });

  it("honors pre-cancelled and in-flight generation cancellation", async () => {
    const ready = Promise.withResolvers<void>();
    respond = () => {
      ready.resolve();
    };
    const { client: model } = await client();
    const cancelled = new AbortController();
    cancelled.abort(new Error("private cancellation"));
    await expect(model.generate(request, cancelled.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(observed).toEqual([]);
    const controller = new AbortController();
    const pending = model.generate(request, controller.signal);
    await ready.promise;
    controller.abort(new Error("private cancellation"));
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED", adapterId });
  });

  it.each(["invalid-arguments", "duplicate-terminal", "unknown-finish"])(
    "never completes a malformed %s stream",
    async (mode) => {
      respond = (response) => {
        startSSE(response);
        if (mode === "invalid-arguments") {
          chunk(
            response,
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call-bad",
                  type: "function",
                  function: { name: "write", arguments: "[]" },
                },
              ],
            },
            "tool_calls",
          );
        } else {
          chunk(
            response,
            { content: "text" },
            mode === "unknown-finish" ? "invented-terminal" : "stop",
          );
          if (mode === "duplicate-terminal") chunk(response, {}, "stop");
        }
        response.end("data: [DONE]\n\n");
      };
      const { client: model } = await client();
      const seen: ModelStreamEvent[] = [];
      await expect(
        (async () => {
          for await (const event of model.stream(request, signal())) seen.push(event);
        })(),
      ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
      expect(seen.some((event) => event.type === "completed")).toBe(false);
    },
  );

  it("cancels a live stream without publishing a completed response", async () => {
    respond = (response) => {
      startSSE(response);
      chunk(response, { content: "first" });
    };
    const { client: model } = await client();
    const controller = new AbortController();
    const iterator = model.stream(request, controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "content-delta" });
    controller.abort(new Error("private cancellation"));
    await expect(iterator.next()).rejects.toMatchObject({ code: "CANCELLED", adapterId });
  });

  it("enforces a whole-operation timeout while stream consumption is paused", async () => {
    const closed = Promise.withResolvers<void>();
    respond = (response) => {
      response.on("close", closed.resolve);
      startSSE(response);
      chunk(response, { content: "first" });
    };
    const { client: model } = await client("custom-model", { timeoutMs: 150 });
    const iterator = model.stream(request, signal())[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "content-delta" });
    // 真正的 HTTP 取消关闭是超时完成信号，不用猜测网络泵所需的墙钟延迟。
    await closed.promise;
    await expect(iterator.next()).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it.each(["binding", "provider"])(
    "drains %s disposal with a paused live stream",
    async (owner) => {
      respond = (response) => {
        startSSE(response);
        chunk(response, { content: "first" });
      };
      const value = await client();
      const iterator = value.client.stream(request, signal())[Symbol.asyncIterator]();
      await iterator.next();
      await (owner === "binding" ? value.binding.dispose() : value.provider.dispose());
      await expect(iterator.next()).rejects.toMatchObject({ code: "CLOSED" });
      await expect(value.client.generate(request, signal())).rejects.toMatchObject({
        code: "CLOSED",
      });
    },
  );

  it("closes the HTTP response when the consumer returns from an unfinished stream", async () => {
    const closed = Promise.withResolvers<void>();
    respond = (response) => {
      response.on("close", closed.resolve);
      startSSE(response);
      chunk(response, { content: "first" });
    };
    const { client: model } = await client();
    const iterator = model.stream(request, signal())[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    await closed.promise;
  });
});
