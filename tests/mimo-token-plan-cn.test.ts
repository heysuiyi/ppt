import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfiguration, ExecutionPlan } from "@agent-harness/configuration/configuration";
import type {
  ModelAssistantMessage,
  ModelBinding,
  ModelRequest,
  ModelStreamEvent,
} from "@agent-harness/core/model/model-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import type { Logger, LogInput } from "@agent-harness/logs/log-contract";
import type { MimoTokenPlanCNOptions, ModelProvider } from "@agent-harness/models/model-contract";
import { ModelProviderError } from "@agent-harness/models/model-errors";
import { getModelProfile, getModelSupport } from "@agent-harness/models/model-profiles";
import { createModelProvider } from "@agent-harness/models/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareConfiguredModel } from "../cli/host/configured-model-factory.js";
import { createAgentHost } from "../cli/host/create-agent-host.js";
import { createSqliteAgentStores } from "../cli/host/sqlite-agent-stores.js";
import { createPreviewBuffer } from "../cli/terminal/preview-buffer.js";
import { terminalError } from "../cli/terminal/terminal-projection.js";

const adapterId = "mimo-token-plan-cn";
const profile = getModelProfile(adapterId)!;
const baseURL = profile.endpoint?.kind === "fixed" ? profile.endpoint.url : "";
const support = getModelSupport(adapterId, "mimo-v2.6-pro")!;
const reasoningEfforts = support.supported ? support.reasoningEfforts : [];
const selection = { providerId: adapterId, modelId: "mimo-v2.6-pro" };
const request: ModelRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "私有输入" }] }],
};
const signal = () => new AbortController().signal;
const message = (value = "答案") => ({
  id: "msg-1",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: value, annotations: [] }],
});
const reasoning = {
  id: "reason-1",
  type: "reasoning",
  status: "completed",
  summary: [],
  content: [{ type: "reasoning_text", text: "原始思考\n " }],
  encrypted_content: "opaque-vendor-value",
  vendor_extension: { keep: ["exact", " \n"] },
};
const call = (id = "call-1", args = '{ "path" : "a.txt" }') => ({
  id: `item-${id}`,
  type: "function_call",
  status: "completed",
  call_id: id,
  name: "Read",
  arguments: args,
});
const response = (output: unknown[] = [message()]) => ({
  id: "resp-1",
  object: "response",
  status: "completed",
  output,
  output_text: "禁止使用此聚合文本",
  usage: { input_tokens: 11, output_tokens: 17, output_tokens_details: { reasoning_tokens: 7 } },
});
type WireEvent = Record<string, unknown>;
function itemEvents(item: Record<string, unknown>, outputIndex: number): WireEvent[] {
  const initial = {
    ...item,
    status: "in_progress",
    ...(item.type === "function_call" ? { arguments: "" } : { content: [], summary: [] }),
  };
  const events: WireEvent[] = [
    { type: "response.output_item.added", output_index: outputIndex, item: initial },
  ];
  if (item.type === "function_call") {
    events.push({
      type: "response.function_call_arguments.delta",
      output_index: outputIndex,
      item_id: item.id,
      delta: item.arguments,
    });
    events.push({
      type: "response.function_call_arguments.done",
      output_index: outputIndex,
      item_id: item.id,
      arguments: item.arguments,
    });
  } else {
    const parts = item.content as { type: string; text: string }[];
    parts.forEach((part, contentIndex) => {
      const base = { output_index: outputIndex, content_index: contentIndex, item_id: item.id };
      events.push({ ...base, type: "response.content_part.added", part: { ...part, text: "" } });
      const prefix = part.type === "reasoning_text" ? "reasoning_text" : "output_text";
      events.push({ ...base, type: `response.${prefix}.delta`, delta: part.text.slice(0, 1) });
      events.push({ ...base, type: `response.${prefix}.delta`, delta: part.text.slice(1) });
      events.push({ ...base, type: `response.${prefix}.done`, text: part.text });
      events.push({ ...base, type: "response.content_part.done", part });
    });
  }
  events.push({ type: "response.output_item.done", output_index: outputIndex, item });
  return events;
}
function completedEvents(output: Record<string, unknown>[] = [message()]): WireEvent[] {
  return [
    { type: "response.created", response: { id: "resp-1", status: "in_progress", output: [] } },
    ...output.flatMap(itemEvents),
    { type: "response.completed", response: response(output) },
  ];
}
function sse(res: ServerResponse, events: WireEvent[], end = true) {
  res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req-service123" });
  for (const event of events) {
    const bytes = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    // SDK 必须处理跨网络块的 SSE，不用测试自制分帧器。
    res.write(bytes.slice(0, 9));
    res.write(bytes.slice(9));
  }
  if (end) res.end("data: [DONE]\n\n");
}
function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "x-request-id": "req-service123" });
  res.end(JSON.stringify(body));
}
async function collect(iterable: AsyncIterable<ModelStreamEvent>) {
  const events: ModelStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

interface ObservedRequest {
  path: string;
  method?: string;
  authorization?: string;
  body: Record<string, unknown>;
}
let server: Server;
let handlers: ((
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
) => void)[];
let observed: ObservedRequest[];
let publicURLs: string[];
let providers: ModelProvider[];
let hostCleanup: Array<() => Promise<unknown>>;
const nativeFetch = globalThis.fetch;

async function provider(overrides: Partial<MimoTokenPlanCNOptions> = {}) {
  const value = await createModelProvider(
    {
      adapterId,
      apiKey: "tp-synthetic-test-only",
      connectionFingerprint: "test-connection-v1",
      timeoutMs: 2000,
      maxOutputTokens: 321,
      ...overrides,
    },
    signal(),
  );
  providers.push(value);
  return value;
}
async function binding(
  value: ModelProvider | Promise<ModelProvider> = provider(),
  effort?: string,
): Promise<ModelBinding> {
  return (await value).create(
    { ...selection, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
    signal(),
  );
}

beforeEach(async () => {
  handlers = [];
  observed = [];
  publicURLs = [];
  providers = [];
  hostCleanup = [];
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    observed.push({
      path: req.url ?? "",
      method: req.method,
      authorization: req.headers.authorization,
      body: parsed,
    });
    const handler = handlers.shift();
    if (handler) handler(req, res, parsed);
    else json(res, response());
  });
  const ready = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  const port = (server.address() as AddressInfo).port;
  // 仅测试转发；生产公开选项仍不接受 endpoint 或 fetch。
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    publicURLs.push(url.href);
    if (!url.href.startsWith(`${baseURL}/`)) throw new Error("Unexpected public endpoint");
    return nativeFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  });
});
afterEach(async () => {
  for (const close of hostCleanup.reverse()) await close();
  await Promise.all(providers.map((value) => value.dispose()));
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  vi.unstubAllGlobals();
});

describe("MiMo 原生独立消费者：真实 OpenAI SDK / HTTP / SSE", () => {
  it.each([undefined, ...reasoningEfforts])(
    "保留 effort %s 和固定地址、Bearer、预算与非严格工具",
    async (effort) => {
      const selected = await binding(provider(), effort);
      await selected.client.generate(
        {
          ...request,
          tools: [
            {
              name: "Read",
              description: "读取",
              inputSchema: { type: "object", properties: { path: { type: "string" } } },
            },
          ],
        },
        signal(),
      );
      expect(publicURLs).toEqual([`${baseURL}/responses`]);
      expect(observed[0]).toMatchObject({
        path: "/v1/responses",
        method: "POST",
        authorization: "Bearer tp-synthetic-test-only",
      });
      const body = observed[0].body;
      expect(body.max_output_tokens).toBe(321);
      expect(body.tools).toEqual([
        {
          type: "function",
          name: "Read",
          description: "读取",
          parameters: { type: "object", properties: { path: { type: "string" } } },
          strict: false,
        },
      ]);
      expect(body.tool_choice).toBe("auto");
      if (effort === undefined) expect(body).not.toHaveProperty("reasoning");
      else expect(body.reasoning).toEqual({ effort });
      for (const key of ["previous_response_id", "background", "context_management", "thinking"])
        expect(body).not.toHaveProperty(key);
    },
  );

  it("按 output 顺序投影、原字符串无损重放，usage 不重复计算 reasoning", async () => {
    const output = [message("前"), reasoning, call(), { ...message("后"), id: "msg-last" }];
    handlers.push((_req, res) => json(res, response(output)));
    const selected = await binding(provider(), "high");
    const result = await selected.client.generate(request, signal());
    expect(result.message.content).toEqual([
      { type: "text", text: "前" },
      { type: "reasoning", text: "原始思考\n " },
      { type: "tool-call", callId: "call-1", name: "Read", input: { path: "a.txt" } },
      { type: "text", text: "后" },
    ]);
    expect(result.finishReason).toBe("tool-calls");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 17 });
    await selected.client.generate(
      {
        messages: [
          { role: "system", content: [{ type: "text", text: "系统一" }] },
          { role: "system", content: [{ type: "text", text: "系统二" }] },
          request.messages[0],
          result.message,
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                callId: "call-1",
                isError: true,
                content: [
                  { type: "text", text: "错误一" },
                  { type: "text", text: " 错误二\n" },
                ],
              },
            ],
          },
        ],
        maxOutputTokens: 17,
      },
      signal(),
    );
    const input = observed[1].body.input as unknown[];
    expect(input.slice(3, 7)).toEqual(output);
    expect(input[7]).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: [
        { type: "input_text", text: "[tool_error]" },
        { type: "input_text", text: "错误一" },
        { type: "input_text", text: " 错误二\n" },
      ],
    });
    expect(observed[1].body.max_output_tokens).toBe(17);
  });

  it("允许无私有状态的纯文本历史，不从公开推理/工具文本伪造状态", async () => {
    const selected = await binding();
    await selected.client.generate(
      { messages: [{ role: "assistant", content: [{ type: "text", text: "旧文本" }] }] },
      signal(),
    );
    expect(observed[0].body.input).toEqual([
      { role: "assistant", content: [{ type: "input_text", text: "旧文本" }] },
    ]);
    await expect(
      selected.client.generate(
        { messages: [{ role: "assistant", content: [{ type: "reasoning", text: "不可重建" }] }] },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "REPLAY_INCOMPATIBLE" });
    expect(observed).toHaveLength(1);
  });

  it("校验 provider/model/effort/连接/版本/规范内容，不静默降级重放", async () => {
    handlers.push((_req, res) => json(res, response([reasoning, call()])));
    const value = await provider();
    const selected = await binding(value, "high");
    const generated = await selected.client.generate(request, signal());
    const original = generated.message;
    const state = original.replayState!;
    const data = state.data as Record<string, unknown>;
    const cases: ModelAssistantMessage[] = [
      { ...original, replayState: { ...state, providerId: "other" } },
      { ...original, replayState: { ...state, modelId: "mimo-v2.6-flash" } },
      { ...original, replayState: { ...state, version: 2 } },
      { ...original, replayState: { ...state, format: "other" } },
      { ...original, content: [{ type: "text", text: "被篡改" }] },
      {
        ...original,
        replayState: { ...state, data: { ...data, connectionFingerprint: "other" } as never },
      },
      {
        ...original,
        replayState: { ...state, data: { ...data, reasoningEffort: "low" } as never },
      },
    ];
    for (const history of cases)
      await expect(
        selected.client.generate({ messages: [history] }, signal()),
      ).rejects.toMatchObject({ code: "REPLAY_INCOMPATIBLE" });
    const other = await binding(value, "low");
    await expect(other.client.generate({ messages: [original] }, signal())).rejects.toMatchObject({
      code: "REPLAY_INCOMPATIBLE",
    });
    const rotated = await binding(
      provider({ apiKey: "ttp-synthetic-rotated", connectionFingerprint: "test-connection-v1" }),
      "high",
    );
    await expect(
      rotated.client.generate({ messages: [original] }, signal()),
    ).resolves.toHaveProperty("finishReason", "stop");
    expect(observed).toHaveLength(2);
  });

  it("真实流对多个文本/推理片段、交错工具参数保持稳定位置和权威终态", async () => {
    const multi = {
      ...message("甲"),
      content: [
        { type: "output_text", text: "甲", annotations: [] },
        { type: "output_text", text: "乙", annotations: [] },
      ],
    };
    const a = call("a", '{ "path": "a" }');
    const b = call("b", '{ "path": "b" }');
    const output = [reasoning, multi, a, b];
    const earlier = [...itemEvents(reasoning, 0), ...itemEvents(multi, 1)];
    const tools: WireEvent[] = [
      {
        type: "response.output_item.added",
        output_index: 2,
        item: { ...a, arguments: "", status: "in_progress" },
      },
      {
        type: "response.output_item.added",
        output_index: 3,
        item: { ...b, arguments: "", status: "in_progress" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 3,
        item_id: b.id,
        delta: '{ "path":',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 2,
        item_id: a.id,
        delta: '{ "path":',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 3,
        item_id: b.id,
        delta: ' "b" }',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 2,
        item_id: a.id,
        delta: ' "a" }',
      },
      { type: "response.output_item.done", output_index: 3, item: b },
      { type: "response.output_item.done", output_index: 2, item: a },
    ];
    handlers.push((_req, res) =>
      sse(res, [...earlier, ...tools, { type: "response.completed", response: response(output) }]),
    );
    const selected = await binding();
    const events = await collect(selected.client.stream(request, signal()));
    const completed = events.filter((event) => event.type === "completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].response.message.content).toEqual([
      { type: "reasoning", text: "原始思考\n " },
      { type: "text", text: "甲" },
      { type: "text", text: "乙" },
      { type: "tool-call", callId: "a", name: "Read", input: { path: "a" } },
      { type: "tool-call", callId: "b", name: "Read", input: { path: "b" } },
    ]);
    const positions = new Map<number, string>();
    for (const event of events)
      if (event.type === "content-delta") {
        const delta = event.delta;
        positions.set(
          event.index,
          (positions.get(event.index) ?? "") +
            (delta.type === "tool-call" ? delta.inputDelta : delta.text),
        );
      }
    expect([...positions]).toEqual([
      [0, "原始思考\n "],
      [1, "甲"],
      [2, "乙"],
      [3, a.arguments],
      [4, b.arguments],
    ]);
    expect(observed[0].body.stream).toBe(true);
  });

  it("在较早项结构未知时缓冲后到项，仍保留最终位置", async () => {
    const first = message("先");
    const second = { ...message("后"), id: "msg-2" };
    handlers.push((_req, res) =>
      sse(res, [
        ...itemEvents(second, 1),
        ...itemEvents(first, 0),
        { type: "response.completed", response: response([first, second]) },
      ]),
    );
    const selected = await binding();
    const events = await collect(selected.client.stream(request, signal()));
    expect(events.filter((event) => event.type === "content-delta")).toEqual([
      { type: "content-delta", index: 0, delta: { type: "text", text: "先" } },
      { type: "content-delta", index: 1, delta: { type: "text", text: "后" } },
    ]);
  });

  it("公开 summary 与厂商 reasoning.content 同时存在时保留各片段和私有字段", async () => {
    const mixed = {
      ...reasoning,
      summary: [{ type: "summary_text", text: "概述" }],
      content: [
        { type: "reasoning_text", text: "推理一" },
        { type: "reasoning_text", text: "推理二" },
      ],
    };
    handlers.push((_req, res) =>
      sse(res, [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...mixed, summary: [], content: [], status: "in_progress" },
        },
        {
          type: "response.reasoning_text.delta",
          output_index: 0,
          content_index: 1,
          item_id: mixed.id,
          delta: "推理二",
        },
        {
          type: "response.reasoning_summary_text.delta",
          output_index: 0,
          summary_index: 0,
          item_id: mixed.id,
          delta: "概述",
        },
        {
          type: "response.reasoning_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: mixed.id,
          delta: "推理一",
        },
        { type: "response.output_item.done", output_index: 0, item: mixed },
        { type: "response.completed", response: response([mixed]) },
      ]),
    );
    const selected = await binding();
    const events = await collect(selected.client.stream(request, signal()));
    const last = events.at(-1);
    expect(last?.type).toBe("completed");
    if (last?.type !== "completed") throw new Error("Missing completed");
    expect(last.response.message.content).toEqual([
      { type: "reasoning", text: "概述" },
      { type: "reasoning", text: "推理一" },
      { type: "reasoning", text: "推理二" },
    ]);
    await selected.client.generate({ messages: [last.response.message] }, signal());
    expect(observed[1].body.input).toEqual([mixed]);
  });

  it("调用前取消和消费者提前退出均取消网络，不生成完成事件", async () => {
    const value = await provider();
    const selected = await binding(value);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(value.discovery!.listModels(cancelled.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(selected.client.generate(request, cancelled.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(observed).toHaveLength(0);
    handlers.push((_req, res) => sse(res, completedEvents().slice(0, 4), false));
    const iterator = selected.client.stream(request, signal())[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    await selected.dispose();
    expect(observed).toHaveLength(1);
  });

  it.each(["eof", "failed", "incomplete", "duplicate", "after", "mismatch", "missing-item-done"])(
    "拒绝 %s 流而不提交 completed",
    async (mode) => {
      let events = completedEvents();
      if (mode === "eof") events.pop();
      if (mode === "failed")
        events[events.length - 1] = { type: "response.failed", response: { status: "failed" } };
      if (mode === "incomplete")
        events[events.length - 1] = {
          type: "response.incomplete",
          response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        };
      if (mode === "duplicate") events.push(events[events.length - 1]);
      if (mode === "after")
        events.push({
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: "msg-1",
          delta: "额外",
        });
      if (mode === "mismatch")
        events[events.length - 1] = {
          type: "response.completed",
          response: response([message("不一致")]),
        };
      if (mode === "missing-item-done")
        events = events.filter((event) => event.type !== "response.output_item.done");
      handlers.push((_req, res) => sse(res, events));
      const selected = await binding();
      const received: ModelStreamEvent[] = [];
      await expect(
        (async () => {
          for await (const event of selected.client.stream(request, signal())) received.push(event);
        })(),
      ).rejects.toBeInstanceOf(ModelProviderError);
      expect(received.some((event) => event.type === "completed")).toBe(false);
    },
  );

  it("流在网络仍开放时及时产出 delta，取消不伪造最终完成", async () => {
    handlers.push((_req, res) => sse(res, completedEvents().slice(0, 4), false));
    const selected = await binding();
    const controller = new AbortController();
    const iterator = selected.client.stream(request, controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: "text-preview",
      previewId: expect.any(String),
      delta: { type: "text", text: "答" },
    });
    controller.abort();
    await expect(collect({ [Symbol.asyncIterator]: () => iterator })).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("binding 关闭排空暂停消费者且不影响其他绑定；provider 关闭排空所有请求", async () => {
    const value = await provider();
    const a = await binding(value);
    const b = await binding(value);
    handlers.push((_req, res) => sse(res, completedEvents().slice(0, 4), false));
    const iterator = a.client.stream(request, signal())[Symbol.asyncIterator]();
    await iterator.next();
    await a.dispose();
    await expect(collect({ [Symbol.asyncIterator]: () => iterator })).rejects.toMatchObject({
      code: "CLOSED",
    });
    await expect(b.client.generate(request, signal())).resolves.toHaveProperty(
      "finishReason",
      "stop",
    );
    const started = Promise.withResolvers<void>();
    handlers.push(() => {
      started.resolve();
    });
    const pending = b.client.generate(request, signal());
    const caught = expect(pending).rejects.toMatchObject({ code: "CLOSED" });
    await started.promise;
    await value.dispose();
    await caught;
    await expect(value.create(selection, signal())).rejects.toMatchObject({ code: "CLOSED" });
    await expect(value.discovery!.listModels(signal())).rejects.toMatchObject({ code: "CLOSED" });
    await value.dispose();
  });

  it("发现校验 ID、去重、空列表和未知能力，不启用或伪造候选", async () => {
    const value = await provider();
    handlers.push((_req, res) =>
      json(res, {
        object: "list",
        data: [
          { id: selection.modelId },
          { id: selection.modelId },
          { id: "future-dialogue" },
          { id: "mimo-tts" },
        ],
      }),
    );
    const models = await value.discovery!.listModels(signal());
    expect(models).toEqual([
      { id: selection.modelId, supported: true },
      { id: "future-dialogue", supported: false, unsupportedReason: expect.any(String) },
      { id: "mimo-tts", supported: false, unsupportedReason: expect.any(String) },
    ]);
    expect(observed[0]).toMatchObject({
      path: "/v1/models",
      method: "GET",
      authorization: "Bearer tp-synthetic-test-only",
    });
    handlers.push((_req, res) => json(res, { object: "list", data: [] }));
    await expect(value.discovery!.listModels(signal())).resolves.toEqual([]);
    await expect(
      value.create({ ...selection, modelId: "future-dialogue" }, signal()),
    ).rejects.toMatchObject({ code: "MODEL_CAPABILITY" });
  });

  it.each(["", "has space", " x", "x\n", "x".repeat(257)])("拒绝非法发现 ID %j", async (id) => {
    handlers.push((_req, res) => json(res, { data: [{ id }] }));
    await expect((await provider()).discovery!.listModels(signal())).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
  it("拒绝超量和缺失 data 的发现响应", async () => {
    const value = await provider();
    handlers.push((_req, res) =>
      json(res, { data: Array.from({ length: 2001 }, (_, i) => ({ id: `id-${i}` })) }),
    );
    handlers.push((_req, res) => json(res, { object: "list" }));
    await expect(value.discovery!.listModels(signal())).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(value.discovery!.listModels(signal())).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it.each([
    [401, "AUTHENTICATION"],
    [403, "ACCESS_DENIED"],
    [402, "PAYMENT_REQUIRED"],
    [429, "RATE_LIMIT_OR_QUOTA"],
    [500, "SERVICE_UNAVAILABLE"],
  ] as const)("安全分类 HTTP %s，不重试/不回退/不暴露正文", async (status, code) => {
    handlers.push((_req, res) =>
      json(
        res,
        { error: { message: "tp-private-key 私有输入 工具参数", code: "sensitive" } },
        status,
      ),
    );
    const value = await provider();
    await expect(value.discovery!.listModels(signal())).rejects.toMatchObject({ code });
    expect(observed).toHaveLength(1);
    expect(publicURLs).toEqual([`${baseURL}/models`]);
  });

  it("SDK fetch 边界的原始 421 被安全分类，SDK 不再次请求", async () => {
    // WHATWG Fetch 对 HTTP 421 有内部重传；这里直接覆盖 SDK 所见的原始状态，
    // 不让 Node 的内部重传把分类测试变成另一条网络响应。
    const intercepted = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            error: { message: "tp-private-key 私有输入 工具参数", code: "sensitive" },
          }),
          { status: 421, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", intercepted);
    await expect((await provider()).discovery!.listModels(signal())).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect(intercepted).toHaveBeenCalledTimes(1);
    expect(String(intercepted.mock.calls[0]?.[0])).toBe(`${baseURL}/models`);
    expect(observed).toHaveLength(0);
  });

  it("真实 HTTP 421 的 Fetch 规范内部重传不伪称为 SDK 重试或空列表成功", async () => {
    const rejected = (_req: IncomingMessage, res: ServerResponse) =>
      json(
        res,
        {
          error: { message: "misdirected", code: "misdirected" },
        },
        421,
      );
    handlers.push(rejected, rejected);
    await expect((await provider()).discovery!.listModels(signal())).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
    // Node Fetch 按规范重新建连一次，但 SDK fetch 只被调用一次；不做业务重试或换域名。
    expect(observed).toHaveLength(2);
    expect(publicURLs).toEqual([`${baseURL}/models`]);
    expect(observed.every((entry) => entry.path === "/v1/models")).toBe(true);
  });

  it("模型与发现超时覆盖读取阶段，无重试；错误不包含 SDK 内容", async () => {
    const value = await provider({ timeoutMs: 150 });
    handlers.push(() => {});
    await expect(value.discovery!.listModels(signal())).rejects.toMatchObject({ code: "TIMEOUT" });
    handlers.push((_req, res) => sse(res, completedEvents().slice(0, 4), false));
    const selected = await binding(value);
    await expect(collect(selected.client.stream(request, signal()))).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(observed).toHaveLength(2);
  });

  it("网络断开和畸形 SSE 不暴露厂商正文、凭据或 SDK cause", async () => {
    handlers.push((req) => req.socket.destroy());
    const value = await provider();
    await expect(value.discovery!.listModels(signal())).rejects.toMatchObject({ code: "NETWORK" });
    handlers.push((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: tp-sensitive-malformed\n\n");
    });
    const consoleError = vi.spyOn(console, "error");
    const selected = await binding(value);
    try {
      await collect(selected.client.stream(request, signal()));
      throw new Error("Expected invalid response");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelProviderError);
      expect(JSON.stringify(error)).not.toMatch(/sensitive|private|cause|headers/u);
    } finally {
      expect(consoleError).not.toHaveBeenCalled();
      consoleError.mockRestore();
    }
  });

  it.each([
    { output: [call("a", "{")] },
    { output: [call("a", "[]")] },
    { output: [call("a", "null")] },
    { output: [call("a"), { ...call("a"), id: "different-item" }] },
    { output: [{ ...call(), name: "" }] },
    { output: [{ ...call(), call_id: "" }] },
    { output: [{ type: "custom_tool_call", call_id: "x", input: "raw" }] },
    { output: [{ ...message(), content: [{ type: "refusal", refusal: "blocked" }] }] },
  ])("拒绝非法函数调用或不支持 output %#", async ({ output }) => {
    handlers.push((_req, res) => json(res, response(output)));
    const selected = await binding();
    await expect(selected.client.generate(request, signal())).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("截断不交付半个调用；失败、内容拦截、其他非成功状态安全失败", async () => {
    const selected = await binding();
    handlers.push((_req, res) =>
      json(res, {
        ...response([call("a", "{")]),
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    );
    await expect(selected.client.generate(request, signal())).resolves.toMatchObject({
      finishReason: "length",
      message: { content: [] },
    });
    for (const status of ["failed", "cancelled", "in_progress"]) {
      handlers.push((_req, res) => json(res, { ...response(), status }));
      await expect(selected.client.generate(request, signal())).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    }
  });

  it("创建即拒绝无效配置/effort，图片显式拒绝且不发请求", async () => {
    for (const overrides of [
      { apiKey: " " },
      { timeoutMs: 0 },
      { timeoutMs: Number.POSITIVE_INFINITY },
      { maxOutputTokens: 0 },
      { maxOutputTokens: 131073 },
      { maxOutputTokens: 1.5 },
      { connectionFingerprint: "" },
    ]) {
      await expect(provider(overrides)).rejects.toBeInstanceOf(ModelProviderError);
    }
    const value = await provider();
    for (const invalid of [
      { ...selection, providerId: "other" },
      { ...selection, reasoningEffort: "default" },
      { ...selection, modelId: "unknown" },
    ]) {
      await expect(value.create(invalid, signal())).rejects.toBeInstanceOf(ModelProviderError);
    }
    const selected = await binding(value);
    await expect(
      selected.client.generate(
        {
          messages: [
            {
              role: "user",
              content: [{ type: "image", source: { type: "url", url: "https://private/image" } }],
            },
          ],
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "MODEL_CAPABILITY" });
    await expect(
      selected.client.generate({ ...request, maxOutputTokens: 131073 }, signal()),
    ).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(observed).toHaveLength(0);
  });

  it("绑定冻结选择，诊断只关联上下文和计数，不持有或关闭 Logger", async () => {
    const records: { event: string; data?: LogInput }[] = [];
    const contexts: unknown[] = [];
    const logger: Logger = {
      child(context) {
        contexts.push(context);
        return this;
      },
      isEnabled: () => true,
      debug() {},
      info(event, data) {
        records.push({ event, data });
      },
      warn() {},
      error() {},
    };
    const value = await provider({ logger });
    const mutable = { ...selection, reasoningEffort: "high" };
    const selected = await value.create(mutable, signal());
    mutable.reasoningEffort = "low";
    const context = {
      identity: { agentId: "a", threadId: "t", queryId: "q", runId: "r" },
      requestId: "local-request",
      step: 2,
    };
    await selected.client.generate(request, signal(), context);
    expect(observed[0].body.reasoning).toEqual({ effort: "high" });
    expect(observed[0].body).not.toHaveProperty("requestId");
    expect(contexts).toEqual([{ ...context.identity, requestId: "local-request", step: 2 }]);
    expect(records.map((record) => record.event)).toEqual(["request.started", "request.completed"]);
    expect(records[1].data).toMatchObject({
      providerId: selection.providerId,
      modelId: selection.modelId,
      reasoningEffort: "high",
      inputTokens: 11,
      outputTokens: 17,
      serverRequestId: "req-service123",
    });
    expect(JSON.stringify(records)).not.toMatch(
      /私有输入|答案|tp-synthetic|replayState|arguments/u,
    );
    await selected.dispose();
    logger.info("still.borrowed");
    expect(records.at(-1)?.event).toBe("still.borrowed");
  });
});

function configuredRuntime(
  maxOutputTokens = 321,
  modelId = selection.modelId,
  reasoningEffort?: string,
): AgentConfiguration["runtime"] {
  const plan: ExecutionPlan = {
    modelAdapter: adapterId,
    model: {
      provider: "openai",
      model: modelId,
      baseURL: baseURL,
      openaiApiMode: "responses",
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
    services: { timeoutMs: 2000, maxOutputTokens },
    stepLimits: { enabled: true, mainMaxSteps: 4, subMaxSteps: 2 },
    executionStrategy: "REQUEST_APPROVAL",
    defaultTemplateId: "builtin/swiss-minimal",
  };
  return {
    async loadExecutionPlan() {
      return plan;
    },
    async resolveRuntime() {
      return {
        modelAdapter: plan.modelAdapter,
        primary: { ...plan.model, apiKey: "tp-synthetic-test-only" },
        gateway: plan.services,
        search: {},
      };
    },
  };
}

describe("MiMo configured host error boundary", () => {
  it.each(["completed", "mismatch", "cancelled"] as const)(
    "previews body before an earlier reasoning item is done without committing provisional text (%s)",
    async (ending) => {
      const textEvents = itemEvents(message(), 1);
      const reasoningEvents = itemEvents(reasoning, 0);
      const finalReasoning = {
        ...reasoning,
        summary: [{ type: "summary_text", text: "late summary" }],
      };
      const connected = Promise.withResolvers<ServerResponse>();
      handlers.push((_req, res) => {
        sse(res, [...reasoningEvents.slice(0, -1), ...textEvents.slice(0, 3)], false);
        connected.resolve(res);
      });
      const directory = await mkdtemp(join(tmpdir(), "mimo-host-stream-"));
      hostCleanup.push(() => rm(directory, { recursive: true, force: true }));
      const host = await createAgentHost({
        configuration: configuredRuntime(321, selection.modelId, "high"),
        applicationDataRoot: directory,
        workspaceRoot: directory,
        modelId: "configured-mimo",
        threadId: "thread",
      });
      hostCleanup.push(() => host.close());
      const handle = await host.run({
        queryId: "query",
        runId: "run",
        input: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      });
      const preview = createPreviewBuffer(handle.identity);
      const iterator = handle.events[Symbol.asyncIterator]();
      const nextDelta = async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done) throw new Error("Run ended before the next streamed delta");
          preview.update(next.value);
          if (next.value.kind === "stream") return next.value;
        }
      };
      let settled = false;
      void handle.completed.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      expect(await nextDelta()).toMatchObject({
        type: "model.preview",
        previewId: expect.any(String),
        delta: { type: "text", text: "答" },
      });
      const previewId = preview.previews[0]?.previewId;
      expect(previewId).toEqual(expect.any(String));
      expect(preview.previews).toMatchObject([{ previewId, text: "答" }]);
      expect(settled).toBe(false);
      expect(observed[0].body.stream).toBe(true);

      const connection = await connected.promise;
      const send = (events: WireEvent[]) => {
        for (const event of events)
          connection.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      // The server cannot send the second chunk until the consumer saw the first;
      // no sleeps or terminal-side typing animation can satisfy this boundary.
      send(textEvents.slice(3, 4));
      expect(await nextDelta()).toMatchObject({
        type: "model.preview",
        previewId,
        delta: { type: "text", text: "案" },
      });
      expect(preview.previews).toMatchObject([{ text: "答案" }]);
      expect(settled).toBe(false);

      if (ending === "cancelled") {
        handle.cancel("cancel before the authoritative response");
      } else {
        send([
          ...textEvents.slice(4),
          {
            type: "response.reasoning_summary_text.delta",
            output_index: 0,
            item_id: reasoning.id,
            summary_index: 0,
            delta: "late summary",
          },
          { type: "response.output_item.done", output_index: 0, item: finalReasoning },
          {
            type: "response.completed",
            response: response([
              finalReasoning,
              message(ending === "mismatch" ? "不一致" : "答案"),
            ]),
          },
        ]);
        connection.end("data: [DONE]\n\n");
      }
      const canonicalText: Array<{ contentIndex: number; text: string }> = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        preview.update(next.value);
        if (next.value.type === "model.delta" && next.value.delta.type === "text") {
          canonicalText.push({
            contentIndex: next.value.contentIndex,
            text: next.value.delta.text,
          });
          expect(preview.previews).toMatchObject([{ previewId, text: "答案" }]);
        }
      }
      const result = await handle.completed;
      expect(result.status).toBe(ending === "mismatch" ? "failed" : ending);
      expect(preview.previews).toEqual([]);
      expect(canonicalText).toEqual(
        ending === "cancelled" ? [] : [{ contentIndex: 2, text: "答案" }],
      );
      await host.close();
      const stores = createSqliteAgentStores(join(directory, "sessions.sqlite"));
      hostCleanup.push(() => stores.dispose());
      const history = await stores.history.read(handle.identity.threadId);
      const assistant = history.messages.filter((entry) => entry.role === "assistant");
      if (ending === "completed") {
        expect(assistant).toMatchObject([
          {
            content: [
              { type: "reasoning", text: "late summary" },
              { type: "reasoning", text: reasoning.content[0].text },
              { type: "text", text: "答案" },
            ],
          },
        ]);
      } else {
        expect(assistant).toEqual([]);
      }
    },
  );

  it.each([
    [401, "AUTHENTICATION", "MiMo 身份认证失败。"],
    [429, "RATE_LIMIT_OR_QUOTA", "MiMo 限流或额度受限。"],
  ] as const)(
    "retains HTTP %s classification in the run result and durable checkpoint",
    async (status, code, message) => {
      handlers.push((_req, res) =>
        json(res, { error: { message: "private SDK diagnostic tp-synthetic-test-only" } }, status),
      );
      const directory = await mkdtemp(join(tmpdir(), "mimo-host-error-"));
      hostCleanup.push(() => rm(directory, { recursive: true, force: true }));
      const host = await createAgentHost({
        configuration: configuredRuntime(),
        applicationDataRoot: directory,
        workspaceRoot: directory,
        modelId: "configured-mimo",
        threadId: "thread",
      });
      hostCleanup.push(() => host.close());
      const handle = await host.run({
        queryId: "query",
        runId: "run",
        input: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      });
      const result = await handle.completed;
      expect(result).toMatchObject({ status: "failed", error: { code, message } });
      expect(JSON.stringify(result)).not.toMatch(/private SDK|tp-synthetic/u);
      await host.close();
      const stores = createSqliteAgentStores(join(directory, "sessions.sqlite"));
      hostCleanup.push(() => stores.dispose());
      const { agentId, threadId, queryId } = handle.identity;
      const saved = await stores.checkpoints.acquire({ agentId, threadId, queryId }, "inspector");
      if (saved.status !== "acquired") throw new Error("Expected released execution lease");
      expect(saved.checkpoint).toMatchObject({ status: "failed", error: { code, message } });
      await stores.checkpoints.release(saved.lease);
    },
  );

  it("retains safe non-streaming model errors at the configured factory boundary", async () => {
    handlers.push((_req, res) => json(res, { error: { message: "private SDK diagnostic" } }, 401));
    const prepared = await prepareConfiguredModel(configuredRuntime(), "configured-mimo", signal());
    hostCleanup.push(() => prepared.dispose());
    const selected = await prepared.models.create(prepared.selection, signal());
    await expect(selected.client.generate(request, signal())).rejects.toEqual(
      new AgentError("AUTHENTICATION", "MiMo 身份认证失败。"),
    );
    await selected.dispose();
  });

  it.each([
    [131_073, selection.modelId, "CONFIGURATION"],
    [321, "mimo-v2.5-tts", "MODEL_CAPABILITY"],
  ] as const)(
    "keeps preparation/binding errors safe and rejects before HTTP (%s, %s)",
    async (budget, modelId, code) => {
      let failure: unknown;
      try {
        const prepared = await prepareConfiguredModel(
          configuredRuntime(budget, modelId),
          "configured-mimo",
          signal(),
        );
        hostCleanup.push(() => prepared.dispose());
        await prepared.models.create(prepared.selection, signal());
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AgentError);
      expect(terminalError(failure)).toMatchObject({ code });
      expect(JSON.stringify(terminalError(failure))).not.toContain("tp-synthetic");
      expect(observed).toHaveLength(0);
    },
  );
});
