import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ModelBinding,
  ModelRequest,
  ModelSelection,
  ModelStreamEvent,
} from "@agent-harness/core/model/model-contract";
import type { ModelProvider, OpenAIResponsesOptions } from "@agent-harness/models/model-contract";
import { ModelProviderError } from "@agent-harness/models/model-errors";
import { getModelSupport } from "@agent-harness/models/model-profiles";
import { createModelProvider } from "@agent-harness/models/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const adapterId = "openai-responses";
const signal = () => new AbortController().signal;
const selection: ModelSelection = {
  providerId: adapterId,
  modelId: "compatible/custom-model",
  reasoningEffort: "high",
};
const request: ModelRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};
const reasoning = {
  id: "rs_1",
  type: "reasoning",
  summary: [{ type: "summary_text", text: "Public summary" }],
  encrypted_content: "private-encrypted-reasoning",
};
const call = {
  id: "fc_1",
  type: "function_call",
  status: "completed",
  call_id: "call_1",
  name: "lookup",
  arguments: '{"query":"value"}',
};
const message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "answer", annotations: [] }],
};
const responseBody = (output: unknown[] = [message]) => ({
  id: "resp_1",
  object: "response",
  status: "completed",
  output,
  usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
});
type Body = Record<string, unknown>;
let server: Server;
let baseURL: string;
let providers: ModelProvider[];
let observed: { path: string; authorization?: string; body: Body }[];
let respond: (body: Body, response: ServerResponse) => void;

beforeEach(async () => {
  providers = [];
  observed = [];
  respond = (_body, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseBody()));
  };
  server = createServer(async (incoming, response) => {
    let raw = "";
    for await (const chunk of incoming) raw += chunk;
    const body = raw ? (JSON.parse(raw) as Body) : {};
    observed.push({
      path: incoming.url ?? "",
      authorization: incoming.headers.authorization,
      body,
    });
    response.setHeader("content-type", "application/json");
    respond(body, response);
  });
  const ready = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterEach(async () => {
  await Promise.all(providers.map((provider) => provider.dispose()));
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
});
async function provider(overrides: Partial<OpenAIResponsesOptions> = {}): Promise<ModelProvider> {
  const result = await createModelProvider(
    {
      adapterId,
      apiKey: "local-test-key",
      baseURL,
      connectionFingerprint: "connection-a",
      timeoutMs: 2000,
      maxOutputTokens: 321,
      ...overrides,
    },
    signal(),
  );
  providers.push(result);
  return result;
}
async function binding(
  options: Partial<OpenAIResponsesOptions> = {},
  selected: ModelSelection = selection,
): Promise<ModelBinding> {
  return (await provider(options)).create(selected, signal());
}
function sse(response: ServerResponse, events: unknown[], end = true): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  if (end) response.end();
}
function messageEvents(text = "answer"): unknown[] {
  const final = { ...message, content: [{ type: "output_text", text, annotations: [] }] };
  return [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      item_id: message.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: message.id,
      content_index: 0,
      delta: text.slice(0, 2),
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: message.id,
      content_index: 0,
      delta: text.slice(2),
    },
    {
      type: "response.output_text.done",
      output_index: 0,
      item_id: message.id,
      content_index: 0,
      text,
    },
    {
      type: "response.content_part.done",
      output_index: 0,
      item_id: message.id,
      content_index: 0,
      part: final.content[0],
    },
    { type: "response.output_item.done", output_index: 0, item: final },
    { type: "response.completed", response: responseBody([final]) },
  ];
}
async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const result: ModelStreamEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

describe("OpenAI Responses public adapter", () => {
  it("accepts compatible model IDs and advertises protocol support without inventing model limits", async () => {
    expect(getModelSupport(adapterId, selection.modelId)).toMatchObject({
      supported: true,
      capabilities: { streaming: true, images: true, toolCalls: true, reasoning: true },
      reasoningEfforts: expect.arrayContaining([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
    });
    const p = await provider();
    await expect(
      p.create({ ...selection, reasoningEffort: "ultra" }, signal()),
    ).rejects.toMatchObject({ code: "CONFIGURATION", adapterId });
    expect(observed).toEqual([]);
    const b = await p.create({ ...selection, reasoningEffort: "max" }, signal());
    await b.client.generate(request, signal());
    expect(observed[0].body.reasoning).toEqual({ effort: "max" });
  });

  it("generates ordered content, translates images/tools, and keeps encrypted reasoning private", async () => {
    respond = (_body, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody([reasoning, message, call])));
    };
    const b = await binding();
    const result = await b.client.generate(
      {
        messages: [
          { role: "system", content: [{ type: "text", text: "system" }] },
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              {
                type: "image",
                source: { type: "base64", mediaType: "image/png", data: "aW1hZ2U=" },
              },
              {
                type: "image",
                source: { type: "url", url: "https://images.example.test/image.png" },
              },
            ],
          },
        ],
        tools: [
          {
            name: "lookup",
            description: "Find value",
            inputSchema: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
        maxOutputTokens: 111,
      },
      signal(),
    );
    expect(observed[0]).toMatchObject({
      path: "/v1/responses",
      authorization: "Bearer local-test-key",
      body: {
        model: selection.modelId,
        store: false,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: 111,
        reasoning: { effort: "high" },
        tools: [{ type: "function", name: "lookup", strict: false }],
        input: [
          { role: "system", content: [{ type: "input_text", text: "system" }] },
          {
            role: "user",
            content: [
              { type: "input_text", text: "look" },
              { type: "input_image", detail: "auto", image_url: "data:image/png;base64,aW1hZ2U=" },
              {
                type: "input_image",
                detail: "auto",
                image_url: "https://images.example.test/image.png",
              },
            ],
          },
        ],
      },
    });
    expect(result).toMatchObject({
      finishReason: "tool-calls",
      usage: { inputTokens: 12, outputTokens: 7 },
      message: {
        content: [
          { type: "reasoning", text: "Public summary" },
          { type: "text", text: "answer" },
          { type: "tool-call", callId: "call_1", name: "lookup", input: { query: "value" } },
        ],
        replayState: {
          providerId: adapterId,
          modelId: selection.modelId,
          data: { output: [reasoning, message, call] },
        },
      },
    });
    expect(JSON.stringify(result.message.content)).not.toContain("private-encrypted");
  });

  it("replays original ordered reasoning and tools through serialized continuation with image tool results", async () => {
    let turn = 0;
    respond = (_body, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody(turn++ === 0 ? [reasoning, call] : [message])));
    };
    const b = await binding();
    const first = await b.client.generate(request, signal());
    const persisted = JSON.parse(JSON.stringify(first.message)) as typeof first.message;
    const result = await b.client.generate(
      {
        messages: [
          ...request.messages,
          persisted,
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                callId: "call_1",
                isError: true,
                content: [
                  { type: "text", text: "tool failed" },
                  {
                    type: "image",
                    source: { type: "url", url: "https://images.example.test/tool.png" },
                  },
                  { type: "text", text: "trailing text" },
                ],
              },
            ],
          },
        ],
      },
      signal(),
    );
    expect(observed[1].body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      reasoning,
      call,
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "[tool_error]" },
          { type: "input_text", text: "tool failed" },
          {
            type: "input_image",
            detail: "auto",
            image_url: "https://images.example.test/tool.png",
          },
          { type: "input_text", text: "trailing text" },
        ],
      },
    ]);
    expect(result.finishReason).toBe("stop");
  });

  it.each(["model", "connection", "effort", "provider", "content", "output"])(
    "rejects incompatible %s replay before sending HTTP",
    async (kind) => {
      const b = await binding();
      const first = await b.client.generate(request, signal());
      let selected = selection;
      let options: Partial<OpenAIResponsesOptions> = {};
      const assistant = JSON.parse(JSON.stringify(first.message)) as typeof first.message;
      if (kind === "model") selected = { ...selection, modelId: "other-model" };
      if (kind === "connection") options = { connectionFingerprint: "connection-b" };
      if (kind === "effort") selected = { ...selection, reasoningEffort: "low" };
      if (kind === "provider")
        Object.assign(assistant.replayState!, { providerId: "openai-chat-completions" });
      if (kind === "content")
        Object.assign(assistant, { content: [{ type: "text", text: "changed" }] });
      if (kind === "output")
        Object.assign(assistant.replayState!.data as object, {
          output: [{ ...message, content: [{ type: "output_text", text: "changed" }] }],
        });
      const other = await binding(options, selected);
      await expect(
        other.client.generate({ messages: [assistant] }, signal()),
      ).rejects.toMatchObject({ code: "REPLAY_INCOMPATIBLE", adapterId });
      expect(observed).toHaveLength(1);
    },
  );

  it("accepts portable text and function history but never fabricates missing private reasoning", async () => {
    const b = await binding();
    await b.client.generate(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "portable" },
              { type: "tool-call", callId: "prior", name: "lookup", input: { a: 1 } },
            ],
          },
        ],
      },
      signal(),
    );
    expect(observed[0].body.input).toEqual([
      { role: "assistant", content: [{ type: "input_text", text: "portable" }] },
      { type: "function_call", call_id: "prior", name: "lookup", arguments: '{"a":1}' },
    ]);
    await expect(
      b.client.generate(
        {
          messages: [
            { role: "assistant", content: [{ type: "reasoning", text: "not replayable" }] },
          ],
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "REPLAY_INCOMPATIBLE" });
    expect(observed).toHaveLength(1);
  });

  it("streams provisional deltas and exactly one authoritative terminal response", async () => {
    respond = (_body, response) => sse(response, messageEvents());
    const b = await binding();
    const events = await collect(b.client.stream(request, signal()));
    expect(events).toEqual([
      { type: "content-delta", index: 0, delta: { type: "text", text: "an" } },
      { type: "content-delta", index: 0, delta: { type: "text", text: "swer" } },
      {
        type: "completed",
        response: expect.objectContaining({
          finishReason: "stop",
          usage: { inputTokens: 12, outputTokens: 7 },
          message: expect.objectContaining({
            content: [{ type: "text", text: "answer" }],
            replayState: expect.any(Object),
          }),
        }),
      },
    ]);
    expect(observed[0].body.stream).toBe(true);
  });

  it("retains streamed encrypted reasoning and complete tool arguments for continuation", async () => {
    const streamEvents = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...reasoning, summary: [], encrypted_content: null },
      },
      {
        type: "response.reasoning_summary_part.added",
        output_index: 0,
        item_id: reasoning.id,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        item_id: reasoning.id,
        summary_index: 0,
        delta: "Public summary",
      },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...call, status: "in_progress", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: call.id,
        delta: '{"query":',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: call.id,
        delta: '"value"}',
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 1,
        item_id: call.id,
        arguments: call.arguments,
      },
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.completed", response: responseBody([reasoning, call]) },
    ];
    respond = (body, response) =>
      body.stream ? sse(response, streamEvents) : response.end(JSON.stringify(responseBody()));
    const b = await binding();
    const events = await collect(b.client.stream(request, signal()));
    expect(events.filter((event) => event.type === "content-delta")).toEqual([
      { type: "content-delta", index: 0, delta: { type: "reasoning", text: "Public summary" } },
      {
        type: "content-delta",
        index: 1,
        delta: { type: "tool-call", callId: "call_1", name: "lookup", inputDelta: '{"query":' },
      },
      {
        type: "content-delta",
        index: 1,
        delta: { type: "tool-call", callId: "call_1", name: "lookup", inputDelta: '"value"}' },
      },
    ]);
    const terminal = events.at(-1);
    if (terminal?.type !== "completed") throw new Error("Missing terminal response");
    await b.client.generate(
      {
        messages: [
          terminal.response.message,
          {
            role: "tool",
            content: [
              { type: "tool-result", callId: "call_1", content: [{ type: "text", text: "found" }] },
            ],
          },
        ],
      },
      signal(),
    );
    expect((observed[1].body.input as unknown[]).slice(0, 2)).toEqual([reasoning, call]);
  });

  it.each([
    "missing-terminal",
    "failed",
    "content-filter",
    "conflicting-terminal",
    "malformed-sse",
  ])("fails %s streams without publishing completed", async (kind) => {
    respond = (_body, response) => {
      const events = messageEvents().slice(0, -1);
      if (kind === "failed")
        events.push({
          type: "response.failed",
          response: { status: "failed", error: { message: "secret remote detail" } },
        });
      if (kind === "content-filter")
        events.push({
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
        });
      if (kind === "conflicting-terminal")
        events.push({
          type: "response.completed",
          response: responseBody([
            { ...message, content: [{ type: "output_text", text: "conflict" }] },
          ]),
        });
      if (kind === "malformed-sse") {
        sse(response, events, false);
        response.end("data: not-json-secret\n\n");
      } else sse(response, events);
    };
    const b = await binding();
    const events: ModelStreamEvent[] = [];
    let failure: unknown;
    try {
      for await (const event of b.client.stream(request, signal())) events.push(event);
    } catch (value) {
      failure = value;
    }
    expect(failure).toBeInstanceOf(ModelProviderError);
    expect(failure).toMatchObject({
      adapterId,
      code: kind === "missing-terminal" ? "INCOMPLETE_STREAM" : "INVALID_RESPONSE",
    });
    expect(JSON.stringify(failure)).not.toMatch(/secret|cause/u);
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it.each([false, true])(
    "reports length without executable tools or replay (stream=%s)",
    async (stream) => {
      const incomplete = {
        ...responseBody([{ ...call, status: "incomplete", arguments: '{"query":' }]),
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      };
      respond = (_body, response) => {
        if (stream)
          sse(response, [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...call, status: "in_progress", arguments: "" },
            },
            {
              type: "response.function_call_arguments.delta",
              output_index: 0,
              item_id: call.id,
              delta: '{"query":',
            },
            { type: "response.incomplete", response: incomplete },
          ]);
        else response.end(JSON.stringify(incomplete));
      };
      const b = await binding();
      const result = stream
        ? (await collect(b.client.stream(request, signal()))).at(-1)
        : undefined;
      const terminal =
        stream && result?.type === "completed"
          ? result.response
          : stream
            ? undefined
            : await b.client.generate(request, signal());
      expect(terminal).toEqual({
        finishReason: "length",
        message: { role: "assistant", content: [] },
        usage: { inputTokens: 12, outputTokens: 7 },
      });
    },
  );

  it("rejects malformed completed function arguments instead of exposing an executable call", async () => {
    respond = (_body, response) =>
      response.end(JSON.stringify(responseBody([{ ...call, arguments: '{"query":' }])));
    const b = await binding();
    await expect(b.client.generate(request, signal())).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      adapterId,
    });
  });

  it("sanitizes HTTP errors without SDK causes or remote secrets", async () => {
    respond = (_body, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "secret credential local-test-key", type: "authentication_error" },
        }),
      );
    };
    const b = await binding();
    const failure = await b.client.generate(request, signal()).catch((value: unknown) => value);
    expect(failure).toBeInstanceOf(ModelProviderError);
    expect(failure).toMatchObject({ code: "AUTHENTICATION", adapterId });
    expect(JSON.stringify(failure)).not.toMatch(/secret|local-test-key|cause/u);
    expect(observed).toHaveLength(1);
  });

  it.each(["binding", "provider", "cancel"])(
    "drains a paused stream when %s closes",
    async (kind) => {
      const disconnected = Promise.withResolvers<void>();
      respond = (_body, response) => {
        response.once("close", disconnected.resolve);
        sse(response, messageEvents().slice(0, 4), false);
      };
      const p = await provider();
      const b = await p.create(selection, signal());
      const controller = new AbortController();
      const iterator = b.client.stream(request, controller.signal)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: "content-delta" });
      if (kind === "binding") await b.dispose();
      else if (kind === "provider") await p.dispose();
      else controller.abort(new Error("secret cancellation reason"));
      await disconnected.promise;
      await expect(iterator.next()).rejects.toMatchObject({
        code: kind === "cancel" ? "CANCELLED" : "CLOSED",
        adapterId,
      });
    },
  );

  it("enforces timeout independently of a paused consumer", async () => {
    const disconnected = Promise.withResolvers<void>();
    respond = (_body, response) => {
      response.once("close", disconnected.resolve);
      sse(response, messageEvents().slice(0, 4), false);
    };
    const b = await binding({ timeoutMs: 200 });
    const iterator = b.client.stream(request, signal())[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "content-delta" });
    await disconnected.promise;
    await expect(iterator.next()).rejects.toMatchObject({ code: "TIMEOUT", adapterId });
  });

  it("returns discovery IDs through its public provider boundary", async () => {
    respond = (_body, response) =>
      response.end(
        JSON.stringify({ data: [{ id: "custom/a" }, { id: "custom/a" }, { id: "custom/b" }] }),
      );
    const p = await provider();
    expect(await p.discovery!.listModels(signal())).toEqual([
      { id: "custom/a", supported: true },
      { id: "custom/b", supported: true },
    ]);
    expect(observed[0].path).toBe("/v1/models");
  });
});
