import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelProvider, ModelProviderOptions } from "@agent-harness/models/model-contract";
import { ModelProviderError } from "@agent-harness/models/model-errors";
import { createModelProvider } from "@agent-harness/models/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeFetch = globalThis.fetch;
const adapterId = "mimo-token-plan-cn";
const options = (): ModelProviderOptions => ({
  adapterId,
  apiKey: "tp-creation-original",
  connectionFingerprint: "original-connection",
  timeoutMs: 2000,
  maxOutputTokens: 321,
});
const signal = () => new AbortController().signal;
let server: Server;
let providers: ModelProvider[];
let observed: { authorization?: string; body: Record<string, unknown> }[];
let transport: typeof fetch;

beforeEach(async () => {
  providers = [];
  observed = [];
  server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    observed.push({
      authorization: request.headers.authorization,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "response-creation",
        object: "response",
        status: "completed",
        output: [
          {
            id: "message-creation",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "created", annotations: [] }],
          },
        ],
      }),
    );
  });
  const ready = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  const port = (server.address() as AddressInfo).port;
  transport = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://token-plan-cn.xiaomimimo.com") {
      throw new Error("Unexpected creation-test endpoint");
    }
    return nativeFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  };
  vi.stubGlobal("fetch", transport);
});

afterEach(async () => {
  await Promise.all(providers.map((provider) => provider.dispose()));
  server.closeAllConnections();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  vi.unstubAllGlobals();
});

describe("model provider creation ownership", () => {
  it("safely rejects an unknown adapter without echoing configuration", async () => {
    const unsafe = { ...options(), adapterId: "private-unknown-adapter", apiKey: "private-key" };
    let failure: unknown;
    try {
      const provider = await createModelProvider(
        unsafe as unknown as ModelProviderOptions,
        signal(),
      );
      providers.push(provider);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProviderError);
    expect(failure).toMatchObject({ code: "ADAPTER_UNSUPPORTED" });
    expect(String(failure)).not.toMatch(/private/u);
    expect(JSON.stringify(failure)).not.toMatch(/private|cause/u);
    expect(observed).toEqual([]);
  });

  it("rejects pre-aborted creation without exposing its reason or sending requests", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private cancellation reason"));
    await expect(createModelProvider(options(), controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
      adapterId,
    });
    expect(observed).toEqual([]);
  });

  it("snapshots options before lazy loading and does not retain the creation signal", async () => {
    const mutable = options();
    const controller = new AbortController();
    const pending = createModelProvider(mutable, controller.signal);
    Object.assign(mutable, {
      adapterId: "private-mutated-adapter",
      apiKey: "tp-mutated",
      connectionFingerprint: "mutated-connection",
      timeoutMs: 0,
      maxOutputTokens: 0,
    });
    const provider = await pending;
    providers.push(provider);
    expect(observed).toEqual([]);
    controller.abort();
    const binding = await provider.create(
      { providerId: adapterId, modelId: "mimo-v2.6-pro" },
      signal(),
    );
    try {
      const result = await binding.client.generate(
        {
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        },
        signal(),
      );
      expect(observed).toEqual([
        {
          authorization: "Bearer tp-creation-original",
          body: expect.objectContaining({ max_output_tokens: 321 }),
        },
      ]);
      expect(result.message.replayState?.data).toMatchObject({
        connectionFingerprint: "original-connection",
      });
    } finally {
      await binding.dispose();
    }
  });

  it("rejects cancellation while the selected adapter is loading", async () => {
    const controller = new AbortController();
    const pending = createModelProvider(options(), controller.signal);
    controller.abort(new Error("private cancellation reason"));
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(observed).toEqual([]);
  });

  it("does not publish a provider cancelled during actual SDK acquisition", async () => {
    const controller = new AbortController();
    // The real SDK reads global fetch during construction, after its lazy import.
    // Abort there without mocking the provider factory or exposing private hooks.
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      get() {
        controller.abort(new Error("private acquisition cancellation"));
        return transport;
      },
    });
    await expect(createModelProvider(options(), controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(observed).toEqual([]);
  });
});
