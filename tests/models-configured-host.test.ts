import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentConfiguration } from "@agent-harness/configuration/configuration";
import type { VendorConfiguration } from "@agent-harness/configuration/configuration-contract";
import { afterEach, describe, expect, it } from "vitest";
import { prepareConfiguredModel } from "../cli/host/configured-model-factory.js";
import { configuredModels } from "../cli/host/model-catalog.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;

// 只隔离操作系统加密；配置、凭据绑定、SDK 和 HTTP 均走实际实现。
async function fixture(protocol: "openai" | "anthropic", mode: "responses" | "chat-completions") {
  const root = await mkdtemp(join(tmpdir(), "models-configured-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const requests: { path: string; key: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push({
      path: request.url!,
      key:
        protocol === "anthropic"
          ? (request.headers["x-api-key"] as string | undefined)
          : request.headers.authorization,
      body: JSON.parse(raw) as Record<string, unknown>,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        protocol === "anthropic"
          ? {
              id: "msg_local",
              type: "message",
              role: "assistant",
              model: "compatible-model",
              content: [{ type: "text", text: "configured answer" }],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 2 },
            }
          : mode === "responses"
            ? {
                id: "resp_local",
                object: "response",
                status: "completed",
                model: "compatible-model",
                output: [
                  {
                    id: "msg_local",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "configured answer", annotations: [] }],
                  },
                ],
                usage: { input_tokens: 3, output_tokens: 2 },
              }
            : {
                id: "chatcmpl_local",
                object: "chat.completion",
                model: "compatible-model",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "configured answer" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 3, completion_tokens: 2 },
              },
      ),
    );
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
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const config = createAgentConfiguration({
    applicationDataRoot: root,
    defaultTemplateId: "none",
    environment: {},
    credentialProtection: {
      scheme: "windows-dpapi-current-user",
      inspect: async () => ({ state: "secure", backend: "windows-dpapi-current-user" }),
      encrypt: async (value) => Buffer.from(value),
      decrypt: async (value) => ({ result: Buffer.from(value).toString(), shouldReEncrypt: false }),
    },
  });
  await config.management.initialize();
  const vendor: VendorConfiguration = {
    id: "connection",
    kind: "custom",
    label: "Compatible endpoint",
    protocol,
    baseURL: `http://127.0.0.1:${address.port}${protocol === "anthropic" ? "" : "/v1"}`,
    enabled: true,
    models: [
      {
        id: "selected",
        name: "Selected",
        model: "compatible-model",
        enabled: true,
        openaiApiMode: mode,
      },
    ],
  };
  await config.management.saveVendor({
    vendor,
    credential: { type: "replace", apiKey: "local-key-one" },
  });
  return { config, vendor, requests };
}

describe("configured native protocol routing", () => {
  it.each([
    ["openai", "responses", "openai-responses", "/v1/responses"],
    ["openai", "chat-completions", "openai-chat-completions", "/v1/chat/completions"],
    ["anthropic", "responses", "anthropic-messages", "/v1/messages"],
  ] as const)(
    "executes saved %s/%s without the legacy gateway",
    async (protocol, mode, adapterId, path) => {
      const { config, requests } = await fixture(protocol, mode);
      const prepared = await prepareConfiguredModel(config.runtime, "selected", signal());
      cleanup.push(() => prepared.dispose());
      expect(prepared.selection).toEqual({ providerId: adapterId, modelId: "compatible-model" });
      const listed = configuredModels(await config.management.getSnapshot());
      expect(listed[0]).toMatchObject({
        status: "ready",
        connectionFingerprint: prepared.connectionFingerprint,
      });
      const binding = await prepared.models.create(prepared.selection, signal());
      cleanup.push(() => binding.dispose());
      const result = await binding.client.generate(
        { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
        signal(),
      );
      expect(result).toMatchObject({
        finishReason: "stop",
        message: { content: [{ type: "text", text: "configured answer" }] },
        usage: { inputTokens: 3, outputTokens: 2 },
      });
      expect(requests).toEqual([
        {
          path,
          key: protocol === "anthropic" ? "local-key-one" : "Bearer local-key-one",
          body: expect.objectContaining({ model: "compatible-model" }),
        },
      ]);
    },
  );

  it("keeps key rotation resumable but fences protocol and endpoint changes", async () => {
    const { config, vendor } = await fixture("openai", "responses");
    const fingerprint = async () => {
      const prepared = await prepareConfiguredModel(config.runtime, "selected", signal());
      cleanup.push(() => prepared.dispose());
      return prepared.connectionFingerprint;
    };
    const original = await fingerprint();
    await config.management.saveVendor({
      vendor,
      credential: { type: "replace", apiKey: "local-key-two" },
    });
    expect(await fingerprint()).toBe(original);
    await config.management.saveVendor({
      vendor: { ...vendor, models: [{ ...vendor.models[0]!, openaiApiMode: "chat-completions" }] },
      credential: { type: "keep" },
    });
    expect(await fingerprint()).not.toBe(original);
    await config.management.saveVendor({
      vendor: { ...vendor, baseURL: `${vendor.baseURL}/other` },
      credential: { type: "replace", apiKey: "local-key-two" },
    });
    expect(await fingerprint()).not.toBe(original);
  });
});
