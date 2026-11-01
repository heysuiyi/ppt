import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ModelAssistantMessage,
  ModelRequest,
  ModelStreamEvent,
} from "@agent-harness/core/model/model-contract";
import type { AnthropicMessagesOptions, ModelProvider } from "@agent-harness/models/model-contract";
import { ModelProviderError } from "@agent-harness/models/model-errors";
import { getModelSupport } from "@agent-harness/models/model-profiles";
import { createModelProvider } from "@agent-harness/models/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapterId = "anthropic-messages";
const modelId = "compatible-custom-model";
const signal = () => new AbortController().signal;
const prompt: ModelRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};
let server: Server;
let baseURL: string;
let providers: ModelProvider[];
let requests: { path: string; body: Record<string, unknown>; key: string | string[] | undefined }[];
let handler: (
  response: ServerResponse,
  body: Record<string, unknown>,
  request: IncomingMessage,
) => void;

function message(content: unknown[] = [{ type: "text", text: "answer" }], stop = "end_turn") {
  return {
    id: "msg_local",
    type: "message",
    role: "assistant",
    model: modelId,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 5,
      output_tokens: 7,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
    },
  };
}
function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
function sse(response: ServerResponse, event: Record<string, unknown>) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
function start(response: ServerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sse(response, { type: "message_start", message: { ...message([]), stop_reason: null } });
}
function textStream(response: ServerResponse, end = true) {
  start(response);
  sse(response, {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  sse(response, {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "streamed" },
  });
  if (end) {
    sse(response, { type: "content_block_stop", index: 0 });
    sse(response, {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 9 },
    });
    sse(response, { type: "message_stop" });
    response.end();
  }
}
async function provider(extra: Partial<AnthropicMessagesOptions> = {}) {
  const value = await createModelProvider(
    {
      adapterId,
      apiKey: "local-private-key",
      baseURL,
      connectionFingerprint: "connection-A",
      timeoutMs: 3000,
      maxOutputTokens: 2048,
      ...extra,
    },
    signal(),
  );
  providers.push(value);
  return value;
}
async function client(extra: Partial<AnthropicMessagesOptions> = {}) {
  return (await provider(extra)).create({ providerId: adapterId, modelId }, signal());
}
async function collect(events: AsyncIterable<ModelStreamEvent>) {
  const values: ModelStreamEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

beforeEach(async () => {
  requests = [];
  providers = [];
  handler = (response) => json(response, message());
  server = createServer(async (request, response) => {
    let raw = "";
    for await (const part of request) raw += part;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    requests.push({ path: request.url ?? "", body, key: request.headers["x-api-key"] });
    handler(response, body, request);
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await Promise.all(providers.map((value) => value.dispose()));
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  vi.restoreAllMocks();
});

describe("Anthropic Messages real SDK boundary", () => {
  it("accepts custom models, discovers paginated models and rejects unsupported effort", async () => {
    expect(getModelSupport(adapterId, modelId)).toMatchObject({
      supported: true,
      capabilities: { images: true, reasoning: true },
      reasoningEfforts: [],
    });
    const value = await provider();
    await expect(
      value.create({ providerId: adapterId, modelId, reasoningEffort: "high" }, signal()),
    ).rejects.toMatchObject({ code: "CONFIGURATION", adapterId });
    handler = (response, _body, request) =>
      json(
        response,
        request.url?.includes("after_id")
          ? {
              data: [{ id: "custom-2", display_name: "Second" }],
              has_more: false,
              last_id: "custom-2",
              first_id: "custom-2",
            }
          : {
              data: [{ id: modelId, display_name: "Custom" }],
              has_more: true,
              last_id: modelId,
              first_id: modelId,
            },
      );
    await expect(value.discovery!.listModels(signal())).resolves.toEqual([
      { id: modelId, displayName: "Custom", supported: true },
      { id: "custom-2", displayName: "Second", supported: true },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1].path).toContain(`after_id=${modelId}`);
  });

  it("maps system, URL/base64 images, tool schemas and signed/redacted tool continuation losslessly", async () => {
    const rawContent = [
      { type: "thinking", thinking: "A public summary", signature: "opaque-signed-value" },
      { type: "redacted_thinking", data: "opaque-redacted-value" },
      { type: "text", text: "Checking" },
      { type: "tool_use", id: "call_1", name: "lookup", input: { query: "x" } },
    ];
    handler = (response) => json(response, message(rawContent, "tool_use"));
    const binding = await client();
    const request: ModelRequest = {
      messages: [
        { role: "system", content: [{ type: "text", text: "system instructions" }] },
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
            { type: "image", source: { type: "base64", mediaType: "image/png", data: "aW1hZ2U=" } },
            { type: "text", text: "inspect" },
          ],
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Look up a query",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
      maxOutputTokens: 1234,
    };
    const result = await binding.client.generate(request, signal());
    expect(result).toMatchObject({
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 7 },
      message: {
        content: [
          { type: "reasoning", text: "A public summary" },
          { type: "text", text: "Checking" },
          { type: "tool-call", callId: "call_1", name: "lookup", input: { query: "x" } },
        ],
      },
    });
    expect(JSON.stringify(result.message.content)).not.toContain("opaque-");
    expect(requests[0]).toMatchObject({
      path: "/v1/messages",
      key: "local-private-key",
      body: {
        model: modelId,
        max_tokens: 1234,
        system: [{ type: "text", text: "system instructions" }],
        tools: [{ name: "lookup", input_schema: { type: "object" } }],
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
              },
              { type: "text", text: "inspect" },
            ],
          },
        ],
      },
    });
    handler = (response) => json(response, message());
    const saved = JSON.parse(JSON.stringify(result.message)) as ModelAssistantMessage;
    await binding.client.generate(
      {
        messages: [
          request.messages[1],
          saved,
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                callId: "call_1",
                isError: true,
                content: [
                  { type: "text", text: "not found" },
                  { type: "image", source: { type: "url", url: "https://example.com/result.png" } },
                ],
              },
            ],
          },
        ],
      },
      signal(),
    );
    expect(requests[1].body).toMatchObject({
      max_tokens: 2048,
      messages: [
        { role: "user" },
        { role: "assistant", content: rawContent },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              is_error: true,
              content: [
                { type: "text", text: "not found" },
                { type: "image", source: { type: "url", url: "https://example.com/result.png" } },
              ],
            },
          ],
        },
      ],
    });
  });

  it("rejects replay identity/content mismatches and unsigned reasoning before transport", async () => {
    handler = (response) =>
      json(
        response,
        message([
          { type: "thinking", thinking: "summary", signature: "signature" },
          { type: "text", text: "answer" },
        ]),
      );
    const binding = await client();
    const result = await binding.client.generate(prompt, signal());
    const saved = result.message;
    const variants: ModelAssistantMessage[] = [
      { ...saved, replayState: { ...saved.replayState!, providerId: "other" } },
      { ...saved, replayState: { ...saved.replayState!, modelId: "other" } },
      { ...saved, replayState: { ...saved.replayState!, format: "other" } },
      { ...saved, replayState: { ...saved.replayState!, version: 2 } },
      {
        ...saved,
        replayState: {
          ...saved.replayState!,
          data: { ...(saved.replayState!.data as object), reasoningEffort: "high" },
        },
      },
      { ...saved, content: [{ type: "text", text: "edited" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "unsigned" }] },
    ];
    for (const variant of variants)
      await expect(
        binding.client.generate({ messages: [...prompt.messages, variant] }, signal()),
      ).rejects.toMatchObject({ code: "REPLAY_INCOMPATIBLE" });
    const other = await client({ connectionFingerprint: "connection-B" });
    await expect(
      other.client.generate({ messages: [...prompt.messages, saved] }, signal()),
    ).rejects.toMatchObject({ code: "REPLAY_INCOMPATIBLE" });
    const otherModel = await (await provider()).create(
      { providerId: adapterId, modelId: "another-model" },
      signal(),
    );
    await expect(
      otherModel.client.generate({ messages: [...prompt.messages, saved] }, signal()),
    ).rejects.toMatchObject({ code: "REPLAY_INCOMPATIBLE" });
    expect(requests).toHaveLength(1);
  });

  it("reconstructs signed streamed thinking and tool JSON only after message_stop", async () => {
    handler = (response) => {
      start(response);
      sse(response, {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      sse(response, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "summary" },
      });
      sse(response, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "stream-signature" },
      });
      sse(response, { type: "content_block_stop", index: 0 });
      sse(response, {
        type: "content_block_start",
        index: 1,
        content_block: { type: "redacted_thinking", data: "encrypted" },
      });
      sse(response, { type: "content_block_stop", index: 1 });
      sse(response, {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "call_stream", name: "lookup", input: {} },
      });
      sse(response, {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"query":' },
      });
      sse(response, {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '"x"}' },
      });
      sse(response, { type: "content_block_stop", index: 2 });
      sse(response, {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 11 },
      });
      sse(response, { type: "message_stop" });
      response.end();
    };
    const binding = await client();
    const events = await collect(binding.client.stream(prompt, signal()));
    expect(events.slice(0, 3)).toEqual([
      { type: "content-delta", index: 0, delta: { type: "reasoning", text: "summary" } },
      {
        type: "content-delta",
        index: 1,
        delta: {
          type: "tool-call",
          callId: "call_stream",
          name: "lookup",
          inputDelta: '{"query":',
        },
      },
      {
        type: "content-delta",
        index: 1,
        delta: { type: "tool-call", callId: "call_stream", name: "lookup", inputDelta: '"x"}' },
      },
    ]);
    expect(events).toHaveLength(4);
    const complete = events[3];
    expect(complete).toMatchObject({
      type: "completed",
      response: {
        finishReason: "tool-calls",
        usage: { outputTokens: 11 },
        message: {
          content: [
            { type: "reasoning", text: "summary" },
            { type: "tool-call", input: { query: "x" } },
          ],
        },
      },
    });
    if (complete.type !== "completed") throw new Error("Missing completion");
    handler = (response) => json(response, message());
    await binding.client.generate(
      {
        messages: [
          ...prompt.messages,
          complete.response.message,
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                callId: "call_stream",
                content: [{ type: "text", text: "done" }],
              },
            ],
          },
        ],
      },
      signal(),
    );
    expect(requests[1].body.messages).toEqual(
      expect.arrayContaining([
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "summary", signature: "stream-signature" },
            { type: "redacted_thinking", data: "encrypted" },
            { type: "tool_use", id: "call_stream", name: "lookup", input: { query: "x" } },
          ],
        },
      ]),
    );
  });

  it("emits exactly one authoritative text completion", async () => {
    handler = (response) => textStream(response);
    const binding = await client();
    await expect(collect(binding.client.stream(prompt, signal()))).resolves.toEqual([
      { type: "content-delta", index: 0, delta: { type: "text", text: "streamed" } },
      {
        type: "completed",
        response: expect.objectContaining({
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 9 },
          message: expect.objectContaining({ content: [{ type: "text", text: "streamed" }] }),
        }),
      },
    ]);
  });

  it.each([
    "missing-stop",
    "unclosed-block",
    "malformed-json",
    "wrong-index",
    "unsigned-thinking",
    "truncated-tool",
  ])("never completes %s streams", async (mode) => {
    handler = (response) => {
      if (mode === "malformed-json") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('event: message_start\ndata: {"private-secret":broken}\n\n');
        return;
      }
      start(response);
      const thinking = mode === "unsigned-thinking";
      const tool = mode === "truncated-tool";
      sse(response, {
        type: "content_block_start",
        index: 0,
        content_block: thinking
          ? { type: "thinking", thinking: "summary", signature: "" }
          : tool
            ? { type: "tool_use", id: "call", name: "lookup", input: {} }
            : { type: "text", text: "" },
      });
      if (tool)
        sse(response, {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"broken":' },
        });
      else if (!thinking)
        sse(response, {
          type: "content_block_delta",
          index: mode === "wrong-index" ? 4 : 0,
          delta: { type: "text_delta", text: "provisional" },
        });
      if (mode !== "unclosed-block") sse(response, { type: "content_block_stop", index: 0 });
      if (mode !== "missing-stop") {
        sse(response, {
          type: "message_delta",
          delta: { stop_reason: tool ? "max_tokens" : "end_turn" },
          usage: { output_tokens: 9 },
        });
        sse(response, { type: "message_stop" });
      }
      response.end();
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const binding = await client();
    const observed: ModelStreamEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of binding.client.stream(prompt, signal())) observed.push(event);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelProviderError);
    expect(caught).toMatchObject({
      adapterId,
      code:
        mode === "missing-stop"
          ? "INCOMPLETE_STREAM"
          : mode === "truncated-tool"
            ? "TRUNCATED"
            : "INVALID_RESPONSE",
    });
    expect(observed.some((event) => event.type === "completed")).toBe(false);
    expect(JSON.stringify(caught)).not.toMatch(/private-secret|local-private-key|cause/u);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([
    [401, "AUTHENTICATION"],
    [403, "ACCESS_DENIED"],
    [429, "RATE_LIMIT_OR_QUOTA"],
    [503, "SERVICE_UNAVAILABLE"],
  ])("sanitizes HTTP %s without retries", async (status, code) => {
    handler = (response) =>
      json(
        response,
        {
          type: "error",
          error: { type: "api_error", message: "private-server-detail local-private-key" },
        },
        status as number,
      );
    const binding = await client();
    let caught: unknown;
    try {
      await binding.client.generate(prompt, signal());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelProviderError);
    expect(caught).toMatchObject({ code, adapterId });
    expect(JSON.stringify(caught)).not.toMatch(/private-server-detail|local-private-key|cause/u);
    expect(String(caught)).not.toMatch(/private-server-detail|local-private-key/u);
    expect(requests).toHaveLength(1);
  });

  it("safely handles an SSE error after provisional content without logging its payload", async () => {
    handler = (response) => {
      textStream(response, false);
      sse(response, {
        type: "error",
        error: { type: "overloaded_error", message: "private-server-detail local-private-key" },
      });
      response.end();
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const binding = await client();
    const events: ModelStreamEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of binding.client.stream(prompt, signal())) events.push(event);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModelProviderError);
    expect(caught).toMatchObject({ code: "SERVICE_UNAVAILABLE", adapterId });
    expect(JSON.stringify(caught)).not.toMatch(/private-server-detail|local-private-key|cause/u);
    expect(events.some((event) => event.type === "completed")).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("rejects truncated generation before returning any executable tools", async () => {
    handler = (response) =>
      json(
        response,
        message(
          [{ type: "tool_use", id: "call", name: "lookup", input: { query: "x" } }],
          "max_tokens",
        ),
      );
    const binding = await client();
    await expect(binding.client.generate(prompt, signal())).rejects.toMatchObject({
      code: "TRUNCATED",
      adapterId,
    });
  });

  it("cancels request and times out stalled transport with safe terminal errors", async () => {
    const reached = Promise.withResolvers<void>();
    handler = () => reached.resolve();
    const binding = await client();
    const controller = new AbortController();
    const pending = binding.client.generate(prompt, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "CANCELLED", adapterId });
    await reached.promise;
    controller.abort(new Error("private-cancel-reason"));
    await rejected;
    const timed = await client({ timeoutMs: 40 });
    await expect(timed.client.generate(prompt, signal())).rejects.toMatchObject({
      code: "TIMEOUT",
      adapterId,
    });
  });

  it.each(["binding", "provider"])(
    "drains paused stream on %s disposal and prevents buffered success",
    async (scope) => {
      handler = (response) => textStream(response, false);
      const value = await provider();
      const binding = await value.create({ providerId: adapterId, modelId }, signal());
      const iterator = binding.client.stream(prompt, signal())[Symbol.asyncIterator]();
      expect(await iterator.next()).toMatchObject({
        value: { type: "content-delta" },
        done: false,
      });
      await (scope === "binding" ? binding.dispose() : value.dispose());
      await expect(iterator.next()).rejects.toMatchObject({ code: "CLOSED", adapterId });
      await expect(binding.client.generate(prompt, signal())).rejects.toMatchObject({
        code: "CLOSED",
      });
    },
  );
});
