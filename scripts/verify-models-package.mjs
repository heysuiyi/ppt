import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = ["models", "model-contract", "model-profiles", "model-errors"];
const privateEntries = [
  "@agent-harness/models",
  "@agent-harness/models/package.json",
  "@agent-harness/models/providers/mimo-token-plan-cn/provider",
  "@agent-harness/models/mimo-token-plan-cn",
  "@agent-harness/models/internal/create-provider",
  "@agent-harness/models/dist/models.js",
  "@agent-harness/models/dist/providers/mimo-token-plan-cn/provider.js",
  "@agent-harness/models/src/models.ts",
  "@agent-harness/models/src/providers/mimo-token-plan-cn/provider.ts",
];
const oldEntries = [
  "./src/models/mimo-token-plan-cn.js",
  "./src/models/mimo-token-plan-cn-contract.js",
];
let stage = "initialize";

// Invoke npm's JS entry without a Windows shell or inherited repository resolution hooks.
async function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .flatMap((directory) => [
        path.join(directory, "node_modules/npm/bin/npm-cli.js"),
        path.resolve(directory, "../lib/node_modules/npm/bin/npm-cli.js"),
      ]),
  ];
  if (process.platform !== "win32")
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      try {
        candidates.push(await realpath(path.join(directory, "npm")));
      } catch {
        /* Not npm. */
      }
    }
  for (const candidate of candidates) {
    if (!candidate || path.basename(candidate).toLowerCase() !== "npm-cli.js") continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try next location. */
    }
  }
  throw new Error("npm-cli unavailable");
}
const childEnvironment = { ...process.env };
for (const key of Object.keys(childEnvironment))
  if (["node_path", "node_options"].includes(key.toLowerCase())) delete childEnvironment[key];
async function runNode(args, cwd, label, { allowFailure = false } = {}) {
  stage = label;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 120_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not start child"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut || (code !== 0 && !allowFailure))
        reject(new Error("Child failed; diagnostics withheld"));
      else resolve({ code, stdout, stderr });
    });
  });
}
function within(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
async function rejectLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const stat = await lstat(file);
    assert(!stat.isSymbolicLink(), "Installed closure contains links");
    if (stat.isDirectory()) await rejectLinks(file);
  }
}

const genericConsumer = `
import { getModelProfile, getModelSupport } from '@agent-harness/models/model-profiles';
import type { ModelAdapterProfile, ModelEndpointPolicy, ModelSupport } from '@agent-harness/models/model-profiles';
import type { ModelAdapterId, ModelProviderConnectionOptions, MimoTokenPlanCNOptions, OpenAIChatOptions, OpenAIResponsesOptions, AnthropicMessagesOptions, ModelProviderOptions, ModelProvider, ModelDiscovery, DiscoveredModel } from '@agent-harness/models/model-contract';
import { ModelProviderError } from '@agent-harness/models/model-errors';
import type { ModelProviderErrorCode } from '@agent-harness/models/model-errors';
import type { ModelClientFactory } from '@agent-harness/core/model/model-contract';
import type { Disposable } from '@agent-harness/core/protocol-values';
import type { Logger } from '@agent-harness/logs/log-contract';
const id: ModelAdapterId = 'mimo-token-plan-cn';
const profile: ModelAdapterProfile | undefined = getModelProfile(id);
const support: ModelSupport | undefined = getModelSupport(id, 'mimo-v2.6-pro');
const endpoint: ModelEndpointPolicy | undefined = profile?.endpoint;
const title: string = support?.supported ? support.reasoningEfforts.join(',') : support?.unsupportedReason ?? document.title;
const connection: ModelProviderConnectionOptions = { connectionFingerprint: title, timeoutMs: 2000, maxOutputTokens: 321 };
const mimo: MimoTokenPlanCNOptions = { ...connection, adapterId: id, apiKey: 'type-only' };
const options: ModelProviderOptions = mimo;
const chat: OpenAIChatOptions = { ...connection, adapterId: 'openai-chat-completions', apiKey: 'type-only', baseURL: 'https://compatible.example/v1' };
const responses: OpenAIResponsesOptions = { ...connection, adapterId: 'openai-responses', apiKey: 'type-only' };
const anthropic: AnthropicMessagesOptions = { ...connection, adapterId: 'anthropic-messages', apiKey: 'type-only' };
const protocols: readonly ModelProviderOptions[] = [options, chat, responses, anthropic];
const code: ModelProviderErrorCode = 'ADAPTER_UNSUPPORTED';
const error: Error = new ModelProviderError(code, 'safe message', id);
const ports = (provider: ModelProvider, logger: Logger): readonly [ModelClientFactory, Disposable, ModelDiscovery | undefined, Logger] => [provider, provider, provider.discovery, logger];
const discovered = (model: DiscoveredModel): boolean => model.supported;
void endpoint; void options; void protocols; void error; void ports; void discovered;
`;
const nodeConsumer = `
import { createModelProvider } from '@agent-harness/models/models';
import type { ModelProvider, ModelProviderOptions } from '@agent-harness/models/model-contract';
import type { ModelBinding } from '@agent-harness/core/model/model-contract';
const options: ModelProviderOptions = { adapterId: 'mimo-token-plan-cn', apiKey: 'type-only', connectionFingerprint: 'consumer', timeoutMs: 2000, maxOutputTokens: 321 };
const provider: ModelProvider = await createModelProvider(options, new AbortController().signal);
const binding: ModelBinding = await provider.create({ providerId: provider.adapterId, modelId: 'mimo-v2.6-pro' }, new AbortController().signal);
await binding.dispose(); await provider.dispose();
`;

// Executed in a fresh native Node process against only the installed tarballs.
// These are wire fixtures, not provider/SDK mocks: the real SDK does all HTTP and SSE parsing.
async function runtimeAcceptance(configuration) {
  const { default: assert } = await import("node:assert/strict");
  const { createServer } = await import("node:http");
  const { fileURLToPath } = await import("node:url");
  const { default: path } = await import("node:path");
  const { createModelProvider } = await import("@agent-harness/models/models");
  const { getModelProfile, getModelSupport } = await import("@agent-harness/models/model-profiles");
  const { ModelProviderError } = await import("@agent-harness/models/model-errors");
  const { createLogs } = await import("@agent-harness/logs/logs");
  const id = "mimo-token-plan-cn";
  const key = "tp-packed-local-only";
  const privateValue = "private-wire-body-not-for-diagnostics";
  const signal = () => new AbortController().signal;
  const selection = { providerId: id, modelId: "mimo-v2.6-pro", reasoningEffort: "high" };
  const request = {
    messages: [{ role: "user", content: [{ type: "text", text: privateValue }] }],
    tools: [
      {
        name: "Read",
        description: "Read file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  };
  const message = (text = "answer", itemId = "msg-1") => ({
    id: itemId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });
  const reasoning = {
    id: "reason-1",
    type: "reasoning",
    status: "completed",
    summary: [],
    content: [{ type: "reasoning_text", text: "reasoning\n " }],
    encrypted_content: "opaque-vendor-value",
    vendor_extension: { preserve: ["exact", " \n"] },
  };
  const call = (callId, value) => ({
    id: `item-${callId}`,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name: "Read",
    arguments: value,
  });
  const output = [
    message("before"),
    reasoning,
    call("call-1", '{ "path" : "a.txt" }'),
    call("call-2", '{"path":"b.txt"}'),
    message("after", "msg-last"),
  ];
  const response = (items = [message()]) => ({
    id: "resp-1",
    object: "response",
    status: "completed",
    output: items,
    output_text: "must-not-use-aggregate",
    usage: { input_tokens: 11, output_tokens: 17, output_tokens_details: { reasoning_tokens: 7 } },
  });
  function itemEvents(item, outputIndex) {
    const initial = {
      ...item,
      status: "in_progress",
      ...(item.type === "function_call" ? { arguments: "" } : { content: [], summary: [] }),
    };
    const events = [
      { type: "response.output_item.added", output_index: outputIndex, item: initial },
    ];
    if (item.type === "function_call") {
      events.push(
        {
          type: "response.function_call_arguments.delta",
          output_index: outputIndex,
          item_id: item.id,
          delta: item.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          output_index: outputIndex,
          item_id: item.id,
          arguments: item.arguments,
        },
      );
    } else
      for (const [contentIndex, part] of item.content.entries()) {
        const base = { output_index: outputIndex, content_index: contentIndex, item_id: item.id };
        const prefix = part.type === "reasoning_text" ? "reasoning_text" : "output_text";
        events.push(
          { ...base, type: "response.content_part.added", part: { ...part, text: "" } },
          { ...base, type: `response.${prefix}.delta`, delta: part.text.slice(0, 1) },
          { ...base, type: `response.${prefix}.delta`, delta: part.text.slice(1) },
          { ...base, type: `response.${prefix}.done`, text: part.text },
          { ...base, type: "response.content_part.done", part },
        );
      }
    events.push({ type: "response.output_item.done", output_index: outputIndex, item });
    return events;
  }
  const eventsFor = (items = output) => [
    { type: "response.created", response: { id: "resp-1", status: "in_progress", output: [] } },
    ...items.flatMap(itemEvents),
    { type: "response.completed", response: response(items) },
  ];
  function json(res, value, status = 200) {
    res.writeHead(status, { "content-type": "application/json", "x-request-id": "req-packed123" });
    res.end(JSON.stringify(value));
  }
  function sse(res, events, end = true) {
    res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req-packed123" });
    for (const event of events) {
      const bytes = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      res.write(bytes.slice(0, 9));
      res.write(bytes.slice(9));
    }
    if (end) res.end("data: [DONE]\n\n");
  }
  const observed = [],
    publicURLs = [],
    handlers = [],
    failures = [],
    providers = [],
    records = [];
  let loggerClosed = 0;
  const logs = createLogs({
    outputs: [
      {
        id: "capture",
        minimumLevel: "debug",
        exporter: {
          export(record) {
            records.push(record);
          },
          async close() {
            loggerClosed++;
          },
        },
      },
    ],
  });
  const borrowedLogger = logs.getLogger("packed-models");
  const originalFetch = globalThis.fetch;
  const originalConsole = {
    error: console.error,
    warn: console.warn,
    debug: console.debug,
    info: console.info,
  };
  let sdkConsoleWrites = 0;
  const server = createServer(async (req, res) => {
    try {
      let bytes = "";
      for await (const chunk of req) bytes += chunk;
      const body = bytes ? JSON.parse(bytes) : {};
      observed.push({ method: req.method, path: req.url, body });
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      const handler = handlers.shift();
      assert(handler, "Unexpected request (including unwanted retry)");
      await handler(req, res, body);
    } catch (error) {
      failures.push(error);
      if (!res.headersSent) json(res, { error: { message: "fixture assertion failed" } }, 500);
      else res.end();
    }
  });
  server.requestTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  let runtimeStage = "public entries";
  const safe = (code) => (error) => {
    assert(error instanceof ModelProviderError);
    assert.equal(error.code, code);
    assert.equal(error.adapterId, id);
    assert.equal(Object.hasOwn(error, "cause"), false);
    for (const field of ["headers", "response", "request", "error"])
      assert.equal(field in error, false);
    const serialized = JSON.stringify(error) + error.message + error.stack;
    for (const secret of [key, privateValue, "opaque-vendor-value"])
      assert(!serialized.includes(secret));
    return true;
  };
  async function collect(stream) {
    const result = [];
    for await (const event of stream) result.push(event);
    return result;
  }
  async function provider(extra = {}) {
    const value = await createModelProvider(
      {
        adapterId: id,
        apiKey: key,
        connectionFingerprint: "packed-fingerprint-v1",
        timeoutMs: 3000,
        maxOutputTokens: 321,
        logger: borrowedLogger,
        ...extra,
      },
      signal(),
    );
    providers.push(value);
    return value;
  }
  function checkWire(req, body, streaming = false) {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/responses");
    assert.equal(body.model, selection.modelId);
    assert.equal(body.max_output_tokens, 321);
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.equal(body.stream ?? false, streaming);
    assert.deepEqual(body.tools, [
      {
        type: "function",
        name: "Read",
        description: "Read file",
        parameters: request.tools[0].inputSchema,
        strict: false,
      },
    ]);
    assert.deepEqual(body.input[0], {
      role: "user",
      content: [{ type: "input_text", text: privateValue }],
    });
  }
  try {
    for (const entry of configuration.entries) {
      const specifier = `@agent-harness/models/${entry}`;
      assert.equal(
        fileURLToPath(import.meta.resolve(specifier)),
        path.join(process.cwd(), "node_modules/@agent-harness/models/dist", `${entry}.js`),
      );
      await import(specifier);
    }
    for (const entry of configuration.privateEntries)
      await assert.rejects(() => import(entry), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    for (const entry of configuration.oldEntries)
      await assert.rejects(() => import(entry), { code: "ERR_MODULE_NOT_FOUND" });
    const profile = getModelProfile(id);
    assert.equal(profile.adapterId, id);
    assert.equal(profile.protocol, "openai-responses");
    assert.deepEqual(profile.endpoint, {
      kind: "fixed",
      url: "https://token-plan-cn.xiaomimimo.com/v1",
    });
    assert.equal(profile.maxOutputTokens, 131072);
    const support = getModelSupport(id, selection.modelId);
    assert.equal(support.supported, true);
    assert.deepEqual(support.capabilities, {
      streaming: true,
      toolCalls: true,
      images: false,
      reasoning: true,
    });
    assert.deepEqual(support.reasoningEfforts, [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    assert.equal(getModelProfile("unknown"), undefined);
    assert.equal(getModelSupport("unknown", "any"), undefined);
    assert.equal(getModelSupport(id, "remote-unknown").supported, false);
    assert.equal(typeof getModelSupport(id, "remote-unknown").unsupportedReason, "string");
    await assert.rejects(
      createModelProvider({ adapterId: privateValue, apiKey: key }, signal()),
      (error) => {
        assert(error instanceof ModelProviderError);
        assert.equal(error.code, "ADAPTER_UNSUPPORTED");
        assert(!(error.message + JSON.stringify(error)).includes(privateValue));
        return true;
      },
    );
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      createModelProvider(
        {
          adapterId: id,
          apiKey: key,
          connectionFingerprint: "f",
          timeoutMs: 3000,
          maxOutputTokens: 321,
        },
        aborted.signal,
      ),
      safe("CANCELLED"),
    );
    const duringLoad = new AbortController();
    const loading = createModelProvider(
      {
        adapterId: id,
        apiKey: key,
        connectionFingerprint: "f",
        timeoutMs: 3000,
        maxOutputTokens: 321,
      },
      duringLoad.signal,
    );
    duringLoad.abort();
    await assert.rejects(loading, safe("CANCELLED"));

    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, "https://token-plan-cn.xiaomimimo.com");
      assert(url.pathname.startsWith("/v1/"));
      publicURLs.push(url.href);
      // The only test transport hook: do not modify the production provider URL/options.
      if (input instanceof Request)
        return originalFetch(
          new Request(`http://127.0.0.1:${port}${url.pathname}${url.search}`, input),
          init,
        );
      return originalFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
    };
    for (const method of Object.keys(originalConsole))
      console[method] = () => {
        sdkConsoleWrites++;
      };
    runtimeStage = "snapshot and discovery";
    const options = {
      adapterId: id,
      apiKey: key,
      connectionFingerprint: "packed-fingerprint-v1",
      timeoutMs: 3000,
      maxOutputTokens: 321,
      logger: borrowedLogger,
    };
    const creating = createModelProvider(options, signal());
    options.apiKey = "mutated-credential";
    options.maxOutputTokens = 1;
    options.connectionFingerprint = "mutated-fingerprint";
    const value = await creating;
    providers.push(value);
    assert.equal(value.adapterId, profile.adapterId);
    assert.equal(observed.length, 0);
    assert(value.discovery);
    handlers.push((req, res) => {
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/v1/models");
      json(res, {
        object: "list",
        data: [{ id: selection.modelId }, { id: "remote-unknown" }, { id: selection.modelId }],
      });
    });
    const discovered = await value.discovery.listModels(signal());
    assert.deepEqual(
      discovered.map(({ id, supported }) => ({ id, supported })),
      [
        { id: selection.modelId, supported: true },
        { id: "remote-unknown", supported: false },
      ],
    );
    assert.equal(
      discovered[1].unsupportedReason,
      getModelSupport(id, "remote-unknown").unsupportedReason,
    );
    handlers.push((_req, res) => json(res, { object: "list", data: [] }));
    assert.deepEqual(await value.discovery.listModels(signal()), []);
    await assert.rejects(
      value.create({ ...selection, modelId: "remote-unknown" }, signal()),
      safe("MODEL_CAPABILITY"),
    );
    const binding = await value.create(selection, signal());
    assert.deepEqual(binding.client.selection, selection);
    assert.deepEqual(binding.client.capabilities, support.capabilities);

    runtimeStage = "generate replay and ordered tools";
    handlers.push((req, res, body) => {
      checkWire(req, body);
      json(res, response(output));
    });
    const generated = await binding.client.generate(request, signal());
    assert.equal(generated.finishReason, "tool-calls");
    assert.deepEqual(generated.usage, { inputTokens: 11, outputTokens: 17 });
    assert.deepEqual(JSON.parse(JSON.stringify(generated.message.content)), [
      { type: "text", text: "before" },
      { type: "reasoning", text: "reasoning\n " },
      { type: "tool-call", callId: "call-1", name: "Read", input: { path: "a.txt" } },
      { type: "tool-call", callId: "call-2", name: "Read", input: { path: "b.txt" } },
      { type: "text", text: "after" },
    ]);
    assert.equal(generated.message.replayState.providerId, id);
    assert.equal(generated.message.replayState.format, "mimo-token-plan-cn/responses-output");
    assert.equal(generated.message.replayState.version, 1);
    handlers.push((req, res, body) => {
      assert.equal(req.url, "/v1/responses");
      assert.equal(body.max_output_tokens, 17);
      assert.deepEqual(body.input.slice(1, 1 + output.length), output);
      assert.deepEqual(body.input.slice(1 + output.length), [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: [{ type: "input_text", text: "first-result" }],
        },
        {
          type: "function_call_output",
          call_id: "call-2",
          output: [
            { type: "input_text", text: "[tool_error]" },
            { type: "input_text", text: "second-result\n" },
          ],
        },
      ]);
      json(res, response([message("roundtrip-answer")]));
    });
    const roundtrip = await binding.client.generate(
      {
        messages: [
          request.messages[0],
          generated.message,
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                callId: "call-1",
                content: [{ type: "text", text: "first-result" }],
              },
              {
                type: "tool-result",
                callId: "call-2",
                isError: true,
                content: [{ type: "text", text: "second-result\n" }],
              },
            ],
          },
        ],
        maxOutputTokens: 17,
      },
      signal(),
    );
    assert.deepEqual(roundtrip.message.content, [{ type: "text", text: "roundtrip-answer" }]);
    const serialized = JSON.parse(JSON.stringify(generated.message));
    serialized.replayState.version = 2;
    await assert.rejects(
      binding.client.generate({ messages: [serialized] }, signal()),
      safe("REPLAY_INCOMPATIBLE"),
    );

    runtimeStage = "real SDK SSE completion";
    handlers.push((req, res, body) => {
      checkWire(req, body, true);
      sse(res, eventsFor());
    });
    const streamed = await collect(binding.client.stream(request, signal()));
    assert(streamed.some((event) => event.type === "content-delta"));
    assert.equal(streamed.filter((event) => event.type === "completed").length, 1);
    assert.deepEqual(streamed.at(-1).response, generated);
    handlers.push((_req, res) => sse(res, eventsFor().slice(0, -1)));
    const incompleteEvents = [];
    await assert.rejects(
      (async () => {
        for await (const event of binding.client.stream(request, signal()))
          incompleteEvents.push(event);
      })(),
      safe("INCOMPLETE_STREAM"),
    );
    assert(!incompleteEvents.some((event) => event.type === "completed"));
    handlers.push((_req, res) =>
      sse(res, [
        {
          type: "response.incomplete",
          response: {
            ...response(),
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ]),
    );
    const truncatedEvents = [];
    await assert.rejects(
      (async () => {
        for await (const event of binding.client.stream(request, signal()))
          truncatedEvents.push(event);
      })(),
      safe("TRUNCATED"),
    );
    assert(!truncatedEvents.some((event) => event.type === "completed"));
    handlers.push((_req, res) =>
      json(res, {
        ...response([call("partial", "{")]),
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    );
    assert.deepEqual(await binding.client.generate(request, signal()), {
      message: { role: "assistant", content: [] },
      finishReason: "length",
    });

    runtimeStage = "safe SDK errors and no retries";
    for (const [status, code, message] of [
      [401, "AUTHENTICATION", "MiMo 身份认证失败。"],
      [403, "ACCESS_DENIED", "MiMo 拒绝访问当前资源。"],
      [402, "PAYMENT_REQUIRED", "MiMo 服务要求处理付费或额度状态。"],
      [429, "RATE_LIMIT_OR_QUOTA", "MiMo 限流或额度受限。"],
      [408, "TIMEOUT", "MiMo 请求超时。"],
      [500, "SERVICE_UNAVAILABLE", "MiMo 服务暂时不可用。"],
    ]) {
      const before = observed.length;
      handlers.push((_req, res) =>
        json(res, { error: { message: `${privateValue} ${key}`, code: "sensitive" } }, status),
      );
      await assert.rejects(binding.client.generate(request, signal()), (error) => {
        safe(code)(error);
        assert.equal(error.message, message);
        return true;
      });
      assert.equal(observed.length, before + 1);
    }
    handlers.push((_req, res) => json(res, { invalid: privateValue }));
    await assert.rejects(binding.client.generate(request, signal()), safe("INVALID_RESPONSE"));
    handlers.push((req, _res) => req.socket.destroy());
    await assert.rejects(binding.client.generate(request, signal()), safe("NETWORK"));
    const shortTimeout = await provider({ timeoutMs: 100 });
    const timedBinding = await shortTimeout.create(selection, signal());
    handlers.push((_req, _res) => {});
    await assert.rejects(timedBinding.client.generate(request, signal()), safe("TIMEOUT"));
    await shortTimeout.dispose();

    runtimeStage = "cancellation independent binding and provider close";
    const beforeCancelled = observed.length;
    await assert.rejects(binding.client.generate(request, aborted.signal), safe("CANCELLED"));
    assert.equal(observed.length, beforeCancelled);
    const cancel = new AbortController();
    handlers.push((_req, res) => sse(res, eventsFor([message()]).slice(0, 4), false));
    const iterator = binding.client.stream(request, cancel.signal)[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type, "content-delta");
    cancel.abort();
    await assert.rejects(collect({ [Symbol.asyncIterator]: () => iterator }), safe("CANCELLED"));
    const independent = await value.create(selection, signal());
    await binding.dispose();
    await assert.rejects(binding.client.generate(request, signal()), safe("CLOSED"));
    handlers.push((_req, res) => json(res, response([message("independent")])));
    assert.equal(
      (await independent.client.generate(request, signal())).message.content[0].text,
      "independent",
    );
    const started = Promise.withResolvers();
    handlers.push((_req, _res) => {
      started.resolve();
    });
    const pending = independent.client.generate(request, signal());
    const rejectedPending = assert.rejects(pending, safe("CLOSED"));
    await started.promise;
    await value.dispose();
    await rejectedPending;
    await value.dispose();
    await assert.rejects(value.create(selection, signal()), safe("CLOSED"));
    await assert.rejects(value.discovery.listModels(signal()), safe("CLOSED"));
    assert.equal(loggerClosed, 0);
    borrowedLogger.info("borrowed.after-provider-close");
    assert(records.some((record) => record.event === "borrowed.after-provider-close"));
    const serializedLogs = JSON.stringify(records);
    for (const secret of [privateValue, key, "opaque-vendor-value", "first-result", "a.txt"])
      assert(!serializedLogs.includes(secret));
    assert.equal(sdkConsoleWrites, 0);
    assert.equal(failures.length, 0);
    assert.equal(handlers.length, 0);
    assert(
      publicURLs.some((url) => url.endsWith("/models")) &&
        publicURLs.some((url) => url.endsWith("/responses")),
    );
    return {
      publicEntries: "resolved",
      privateAndProviderEntries: "rejected",
      oldSourcePaths: "absent",
      realOpenAISDK: true,
      fixedProductionURLWithLocalFetchRewrite: true,
      profileFactoryBindingGenerateStreamDiscovery: true,
      privateReplayAndOrderedToolRoundtrip: true,
      unifiedSafeErrorIdentityAndCodes: true,
      unknownAdapterAndModelRejected: true,
      inputSnapshotAndCreationCancellation: true,
      incompleteAndTruncatedStreamsNeverCompleted: true,
      cancellationAndCloseDrain: true,
      independentBindings: true,
      borrowedLoggerNotClosed: true,
      sdkRetries: 0,
      sdkConsoleWrites,
      localHTTPRequests: observed.length,
      remoteVendorAcceptance: false,
    };
  } catch (error) {
    const location = /runtime\.mjs:(\d+):/.exec(error?.stack ?? "");
    throw new Error(
      `Native packed models acceptance failed: ${runtimeStage}${location ? ` at line ${location[1]}` : ""}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(console, originalConsole);
    try {
      await Promise.allSettled(providers.map((value) => value.dispose()));
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await logs.close();
    }
    assert.equal(loggerClosed, 1);
  }
}

async function main() {
  assert(Number(process.versions.node.split(".")[0]) >= 24, "Node 24 required");
  const npmCli = await findNpmCli();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-harness-models-package-"));
  try {
    assert(!within(await realpath(repositoryRoot), await realpath(temporaryRoot)));
    const project = path.join(temporaryRoot, "consumer");
    const cache = path.join(temporaryRoot, "npm-cache");
    await mkdir(project);
    const npm = (args, cwd, label) => runNode([npmCli, ...args, "--cache", cache], cwd, label);
    const workspaceDirectories = ["packages/harness", "packages/logs", "packages/models"];
    const workspaces = new Map();
    for (const directory of workspaceDirectories) {
      const absolute = path.join(repositoryRoot, directory);
      const manifest = JSON.parse(await readFile(path.join(absolute, "package.json"), "utf8"));
      workspaces.set(manifest.name, { directory: absolute, manifest });
    }
    const closure = new Map();
    const omittedOptionalPeers = new Set();
    async function installedDependency(name, from) {
      for (let current = from; ; current = path.dirname(current)) {
        const directory = path.join(current, "node_modules", name);
        try {
          const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
          return { directory: await realpath(directory), manifest };
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        }
        if (path.dirname(current) === current)
          throw new Error("Required installed runtime dependency unavailable");
      }
    }
    async function visit(item) {
      const { name, version } = item.manifest;
      const previous = closure.get(name);
      if (previous) {
        assert.equal(
          previous.manifest.version,
          version,
          "Multiple installed versions require an explicit isolated lock closure",
        );
        return;
      }
      closure.set(name, item);
      const required = new Set(Object.keys(item.manifest.dependencies ?? {}));
      for (const peer of Object.keys(item.manifest.peerDependencies ?? {})) {
        if (item.manifest.peerDependenciesMeta?.[peer]?.optional)
          omittedOptionalPeers.add(`${name}:${peer}`);
        else required.add(peer);
      }
      for (const dependency of required)
        await visit(
          workspaces.get(dependency) ?? (await installedDependency(dependency, item.directory)),
        );
      for (const dependency of Object.keys(item.manifest.optionalDependencies ?? {})) {
        try {
          await visit(await installedDependency(dependency, item.directory));
        } catch (error) {
          if (error.message !== "Required installed runtime dependency unavailable") throw error;
          throw new Error("Installed optional runtime closure incomplete");
        }
      }
    }
    for (const workspace of workspaces.values()) await visit(workspace);
    assert(closure.has("openai"), "Real SDK missing from runtime closure");
    assert(closure.has("@anthropic-ai/sdk"), "Real Anthropic SDK missing from runtime closure");
    const tarballs = [];
    for (const item of closure.values()) {
      const packed = JSON.parse(
        (
          await npm(
            [
              "pack",
              item.directory,
              "--offline",
              "--ignore-scripts",
              "--json",
              "--pack-destination",
              temporaryRoot,
            ],
            temporaryRoot,
            `Pack ${item.manifest.name}`,
          )
        ).stdout,
      );
      assert.equal(packed.length, 1);
      const tarball = path.resolve(temporaryRoot, packed[0].filename);
      assert(within(temporaryRoot, tarball));
      await access(tarball);
      if (workspaces.has(item.manifest.name)) {
        assert(
          !packed[0].files.some(
            ({ path: file }) => file.startsWith("src/") || file.includes("node_modules/"),
          ),
        );
        assert(
          packed[0].files.some(
            ({ path: file }) => file.startsWith("dist/") && file.endsWith(".js"),
          ),
        );
        assert(
          packed[0].files.some(
            ({ path: file }) => file.startsWith("dist/") && file.endsWith(".d.ts"),
          ),
        );
      }
      tarballs.push(tarball);
      // Seed only our private cache; no registry, global cache, lifecycle scripts or source links.
      await npm(
        ["cache", "add", tarball, "--offline", "--ignore-scripts"],
        temporaryRoot,
        `Cache packed ${item.manifest.name}`,
      );
    }
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify({
        name: "models-packed-consumer",
        version: "1.0.0",
        private: true,
        type: "module",
      }),
    );
    // Every real required dependency is an explicit local tarball, so npm needs no registry metadata.
    // Optional SDK peer integrations (websockets/helpers) are not this Responses transport closure.
    await npm(
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--bin-links=false",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        ...tarballs,
      ],
      project,
      "Install complete offline tarball closure",
    );
    await rejectLinks(path.join(project, "node_modules"));
    for (const [name, item] of closure) {
      const installed = path.join(project, "node_modules", name);
      assert(within(await realpath(temporaryRoot), await realpath(installed)));
      const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
      assert.equal(manifest.name, name);
      assert.equal(manifest.version, item.manifest.version);
    }
    const tree = JSON.parse(
      (await npm(["ls", "--all", "--json"], project, "Inspect installed dependency closure"))
        .stdout,
    );
    assert(!tree.problems?.length);
    const installedModels = path.join(project, "node_modules/@agent-harness/models");
    const manifest = JSON.parse(await readFile(path.join(installedModels, "package.json"), "utf8"));
    assert.equal(manifest.name, "@agent-harness/models");
    assert.equal(manifest.version, "0.1.0");
    assert.equal(manifest.private, true);
    assert.equal(manifest.type, "module");
    assert.equal(manifest.engines?.node, ">=24");
    assert.deepEqual(
      Object.keys(manifest.exports).sort(),
      entries.map((entry) => `./${entry}`).sort(),
    );
    for (const entry of entries) {
      assert.deepEqual(manifest.exports[`./${entry}`], {
        types: `./dist/${entry}.d.ts`,
        import: `./dist/${entry}.js`,
      });
      await access(path.join(installedModels, "dist", `${entry}.js`));
      await access(path.join(installedModels, "dist", `${entry}.d.ts`));
    }
    const compiler = path.join(repositoryRoot, "node_modules/typescript/bin/tsc");
    await access(compiler);
    await writeFile(path.join(project, "generic.ts"), genericConsumer);
    await writeFile(path.join(project, "node.ts"), nodeConsumer);
    const forbidden = [...privateEntries, ...oldEntries];
    await writeFile(
      path.join(project, "private.ts"),
      forbidden
        .map(
          (entry, index) =>
            `import type * as Private${index} from ${JSON.stringify(entry)}; export type Rejected${index} = typeof Private${index};`,
        )
        .join("\n"),
    );
    const base = {
      target: "ES2024",
      lib: ["ES2024", "DOM", "DOM.Iterable"],
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      types: [],
      forceConsistentCasingInFileNames: true,
    };
    for (const [name, module, moduleResolution, file, extra] of [
      ["bundler-dom", "ESNext", "Bundler", "generic.ts", {}],
      ["nodenext-dom", "NodeNext", "NodeNext", "generic.ts", {}],
      [
        "nodenext-factory",
        "NodeNext",
        "NodeNext",
        "node.ts",
        { types: ["node"], typeRoots: [path.join(repositoryRoot, "node_modules/@types")] },
      ],
    ]) {
      const config = `tsconfig.${name}.json`;
      const compilerOptions = { ...base, module, moduleResolution, ...extra };
      await writeFile(
        path.join(project, config),
        JSON.stringify({ compilerOptions, files: [file] }),
      );
      await runNode(
        [compiler, "-p", config, "--pretty", "false"],
        project,
        `Compile isolated ${name}`,
      );
      const negative = `tsconfig.${name}.private.json`;
      await writeFile(
        path.join(project, negative),
        JSON.stringify({ compilerOptions, files: ["private.ts"] }),
      );
      const rejected = await runNode(
        [compiler, "-p", negative, "--pretty", "false"],
        project,
        `Reject isolated ${name} private paths`,
        { allowFailure: true },
      );
      assert.notEqual(rejected.code, 0);
      for (const entry of forbidden) assert(rejected.stdout.includes(`'${entry}'`));
      const codes = [...rejected.stdout.matchAll(/error TS(\d+):/g)].map((match) => match[1]);
      assert(codes.length > 0 && codes.every((code) => code === "2307"));
    }
    await writeFile(
      path.join(project, "runtime.mjs"),
      `const configuration = ${JSON.stringify({ entries, privateEntries, oldEntries })};\ntry { console.log(JSON.stringify(await (${runtimeAcceptance.toString()})(configuration))); } catch (error) { console.error(JSON.stringify({ ok: false, stage: error.message })); process.exitCode = 1; }\n`,
    );
    const runtime = await runNode(
      ["runtime.mjs"],
      project,
      "Native Node real SDK local HTTP/SSE acceptance",
      { allowFailure: true },
    );
    if (runtime.code !== 0) {
      // Child exports only controlled stage labels, never assertion payloads, credentials or SDK errors.
      try {
        const failure = JSON.parse(runtime.stderr);
        if (
          typeof failure.stage === "string" &&
          /^Native packed models acceptance failed: [a-zA-Z /]+(?: at line \d+)?$/.test(
            failure.stage,
          )
        )
          stage = failure.stage;
      } catch {
        /* Keep the safe parent stage. */
      }
      throw new Error("Native acceptance failed");
    }
    return {
      package: "@agent-harness/models@0.1.0",
      packedAlreadyBuiltPackages: [...workspaces.keys()],
      isolatedOfflineInstall: true,
      isolatedNpmCache: true,
      installationScripts: false,
      symlinks: false,
      runtimeDependencyClosure: [...closure.values()]
        .map(({ manifest }) => `${manifest.name}@${manifest.version}`)
        .sort(),
      sdkDependencyClosureMethod:
        "Recursively resolve installed required runtime dependencies/nonoptional peers and installed optional dependencies; npm pack --offline --ignore-scripts each real directory; seed isolated npm cache; install every exact local tarball offline without links.",
      limitations: [
        "Only the installed single-version-per-name runtime closure is accepted; version conflicts fail closed.",
        "Optional SDK peer integrations are not auto-installed; only real Responses HTTP/SSE is exercised.",
        "Local HTTP/SSE is not remote vendor acceptance; browser bundle and Electron acceptance are separate.",
      ],
      omittedOptionalPeerIntegrations: [...omittedOptionalPeers]
        .filter((entry) => !closure.has(entry.slice(entry.lastIndexOf(":") + 1)))
        .sort(),
      declarationConsumers: ["NodeNext DOM types:[]", "Bundler DOM types:[]", "NodeNext factory"],
      skipLibCheck: false,
      compilerSideNodeTypes:
        "Repository @types/node only for the Node factory consumer; no repository runtime resolution.",
      ...JSON.parse(runtime.stdout),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
try {
  console.log(JSON.stringify({ ...(await main()), temporaryArtifactsRemoved: true }));
} catch {
  console.error(
    JSON.stringify({
      ok: false,
      stage,
      error: "Models package verification failed; raw child diagnostics intentionally withheld.",
    }),
  );
  process.exitCode = 1;
}
