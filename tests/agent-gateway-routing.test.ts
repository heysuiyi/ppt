import { beforeEach, describe, expect, it, vi } from "vitest";

const providerMocks = vi.hoisted(() => ({
  openai: vi.fn(),
  anthropic: vi.fn(),
  openaiStream: vi.fn(),
  anthropicStream: vi.fn(),
}));

vi.mock("../app/main/agent/gateway/openai", () => ({
  chatDriver: {
    generate: providerMocks.openai,
    generateStream: providerMocks.openaiStream,
  },
  responsesDriver: {
    generate: providerMocks.openai,
    generateStream: providerMocks.openaiStream,
  },
}));

vi.mock("../app/main/agent/gateway/anthropic", () => ({
  generateWithAnthropic: providerMocks.anthropic,
  generateStreamWithAnthropic: providerMocks.anthropicStream,
  anthropicDriver: {
    generate: providerMocks.anthropic,
    generateStream: providerMocks.anthropicStream,
  },
}));

import { AgentGateway } from "../app/main/agent/gateway";
import { textFromContentBlocks } from "../app/main/agent/gateway/content-blocks";

describe("AgentGateway", () => {
  beforeEach(() => {
    providerMocks.openai.mockReset();
    providerMocks.anthropic.mockReset();
    providerMocks.openaiStream.mockReset();
    providerMocks.anthropicStream.mockReset();
  });

  it("preserves a declared 1M context capability in the model selection", () => {
    const gateway = new AgentGateway();

    const selection = gateway.configure({
      configurationId: "configured-model",
      provider: "openai",
      model: "extended-context-model",
      apiKey: "secret",
      supports1MContext: true,
    });

    expect(selection).toEqual({
      configurationId: "configured-model",
      provider: "openai",
      model: "extended-context-model",
      supports1MContext: true,
    });
    expect(selection).not.toHaveProperty("apiKey");
  });

  it("keeps the registered reasoning effort through narrow model selection copies", async () => {
    providerMocks.openai.mockResolvedValue({
      provider: "openai",
      model: "gpt-5-mini",
      content: [{ type: "text", text: "hello" }],
    });
    const gateway = new AgentGateway();
    const selection = gateway.configure({
      configurationId: "reasoning-model",
      provider: "openai",
      model: "gpt-5-mini",
      apiKey: "secret",
      openaiApiMode: "responses",
      reasoningEffort: "low",
    });
    expect(selection.reasoningEffort).toBe("low");
    await gateway.queryModel(
      { prompt: "test" },
      {
        configurationId: selection.configurationId,
        provider: selection.provider,
        model: selection.model,
      },
    );
    expect(providerMocks.openai).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: "low", callPath: "responses" }),
      expect.anything(),
    );
  });

  it.each([
    { provider: "openai" as const, model: "mimo-v2.5-pro", openaiApiMode: "responses" as const },
    {
      provider: "openai" as const,
      model: "gpt-5-mini",
      openaiApiMode: "chat-completions" as const,
    },
    { provider: "anthropic" as const, model: "claude-test" },
  ])("does not add reasoning effort to unsupported Gateway paths: %j", async (model) => {
    const response = {
      provider: model.provider,
      model: model.model,
      content: [{ type: "text", text: "hello" }],
    };
    providerMocks.openai.mockResolvedValue(response);
    providerMocks.anthropic.mockResolvedValue(response);
    const gateway = new AgentGateway();
    const selection = gateway.configure({ ...model, apiKey: "secret", reasoningEffort: "high" });
    await gateway.queryModel({ prompt: "test" }, selection);
    const driver = model.provider === "openai" ? providerMocks.openai : providerMocks.anthropic;
    expect(driver.mock.calls[0]![0]).not.toHaveProperty("reasoningEffort");
  });

  it("routes an OpenAI selection to the OpenAI adapter", async () => {
    providerMocks.openai.mockResolvedValue({
      provider: "openai",
      model: "openai-test",
      content: [{ type: "text", text: "hello" }],
    });
    const gateway = new AgentGateway();
    gateway.configure({ provider: "openai", model: "openai-test", apiKey: "secret" });

    const response = await gateway.queryModel(
      { prompt: "Hello" },
      { provider: "openai", model: "openai-test" },
    );

    expect(textFromContentBlocks(response.content)).toBe("hello");
    expect(providerMocks.openai).toHaveBeenCalledOnce();
    expect(providerMocks.anthropic).not.toHaveBeenCalled();
    expect(providerMocks.openai.mock.calls[0][0]).toMatchObject({
      provider: "openai",
      model: "openai-test",
      apiKey: "secret",
    });
    expect(providerMocks.openai.mock.calls[0][1]).toMatchObject({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
  });

  it("keeps identified same-provider primary and fallback credentials isolated", async () => {
    providerMocks.openai.mockImplementation(async (config: { model: string }) => ({
      provider: "openai",
      model: config.model,
      content: [{ type: "text", text: config.model }],
    }));
    providerMocks.openaiStream.mockImplementation(async function* (config: { model: string }) {
      yield { type: "complete", content: [{ type: "text", text: config.model }] };
    });
    const gateway = new AgentGateway();
    const primary = gateway.configure(
      {
        configurationId: "primary-openai",
        provider: "openai",
        model: "shared-model",
        apiKey: "primary-key",
        baseURL: "https://primary.example.test/v1",
        openaiApiMode: "responses",
      },
      {
        timeoutMs: 180_000,
        maxOutputTokens: 16_384,
        fallbackModel: {
          configurationId: "fallback-openai",
          provider: "openai",
          model: "shared-model",
          apiKey: "fallback-key",
          baseURL: "https://fallback.example.test/v1",
          openaiApiMode: "chat-completions",
        },
      },
    );
    const fallback = {
      configurationId: "fallback-openai",
      provider: "openai" as const,
      model: "shared-model",
    };

    await gateway.queryModel({ prompt: "primary" }, primary);
    await gateway.queryModel({ prompt: "fallback" }, fallback);
    for await (const _chunk of gateway.queryModelStream({ prompt: "stream" }, fallback)) {
      // Consume the stream to exercise the same identity lookup path.
    }

    expect(providerMocks.openai).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        configurationId: "primary-openai",
        model: "shared-model",
        apiKey: "primary-key",
        baseURL: "https://primary.example.test/v1",
        callPath: "responses",
      }),
      expect.anything(),
    );
    expect(providerMocks.openai).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        configurationId: "fallback-openai",
        model: "shared-model",
        apiKey: "fallback-key",
        baseURL: "https://fallback.example.test/v1",
        callPath: "chat",
      }),
      expect.anything(),
    );
    expect(providerMocks.openaiStream).toHaveBeenCalledWith(
      expect.objectContaining({
        configurationId: "fallback-openai",
        model: "shared-model",
        apiKey: "fallback-key",
        callPath: "chat",
      }),
      expect.anything(),
    );
  });

  it("routes an unlabelled fallback by provider and model", async () => {
    providerMocks.openai.mockImplementation(async (config: { model: string }) => ({
      provider: "openai",
      model: config.model,
      content: [{ type: "text", text: config.model }],
    }));
    const gateway = new AgentGateway();
    const primary = gateway.configure(
      {
        provider: "openai",
        model: "primary-model",
        apiKey: "primary-key",
      },
      {
        timeoutMs: 180_000,
        maxOutputTokens: 16_384,
        fallbackModel: {
          provider: "openai",
          model: "fallback-model",
          apiKey: "fallback-key",
        },
      },
    );

    await gateway.queryModel({ prompt: "primary" }, primary);
    await gateway.queryModel(
      { prompt: "fallback" },
      { provider: "openai", model: "fallback-model" },
    );

    expect(providerMocks.openai.mock.calls[0][0]).toMatchObject({
      model: "primary-model",
      apiKey: "primary-key",
    });
    expect(providerMocks.openai.mock.calls[1][0]).toMatchObject({
      model: "fallback-model",
      apiKey: "fallback-key",
    });
  });

  it.each([
    [
      "unknown identity",
      { configurationId: "unknown", provider: "openai" as const, model: "primary-model" },
    ],
    [
      "model mismatch",
      { configurationId: "primary-openai", provider: "openai" as const, model: "other-model" },
    ],
    [
      "provider mismatch",
      { configurationId: "primary-openai", provider: "anthropic" as const, model: "primary-model" },
    ],
  ])("fails closed for an explicit %s", async (_label, selection) => {
    const gateway = new AgentGateway();
    gateway.configure({
      configurationId: "primary-openai",
      provider: "openai",
      model: "primary-model",
      apiKey: "primary-key",
    });

    await expect(gateway.queryModel({ prompt: "Hello" }, selection)).rejects.toMatchObject({
      code: "configuration",
      provider: selection.provider,
    });
    expect(providerMocks.openai).not.toHaveBeenCalled();
    expect(providerMocks.anthropic).not.toHaveBeenCalled();
  });

  it("replaces and clears fallback identities when gateway config changes", async () => {
    providerMocks.openai.mockImplementation(async (config: { model: string }) => ({
      provider: "openai",
      model: config.model,
      content: [{ type: "text", text: config.model }],
    }));
    const gateway = new AgentGateway();
    gateway.configure(
      {
        configurationId: "primary-openai",
        provider: "openai",
        model: "primary-model",
        apiKey: "primary-key",
      },
      {
        timeoutMs: 180_000,
        maxOutputTokens: 16_384,
        fallbackModel: {
          configurationId: "old-fallback",
          provider: "openai",
          model: "old-model",
          apiKey: "old-key",
        },
      },
    );
    gateway.configure(
      {
        configurationId: "primary-openai",
        provider: "openai",
        model: "primary-model",
        apiKey: "primary-key",
      },
      {
        timeoutMs: 180_000,
        maxOutputTokens: 16_384,
        fallbackModel: {
          configurationId: "new-fallback",
          provider: "openai",
          model: "new-model",
          apiKey: "new-key",
        },
      },
    );

    await expect(
      gateway.queryModel(
        { prompt: "old" },
        {
          configurationId: "old-fallback",
          provider: "openai",
          model: "old-model",
        },
      ),
    ).rejects.toMatchObject({ code: "configuration" });
    await gateway.queryModel(
      { prompt: "new" },
      {
        configurationId: "new-fallback",
        provider: "openai",
        model: "new-model",
      },
    );
    expect(providerMocks.openai).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "new-key", model: "new-model" }),
      expect.anything(),
    );

    gateway.configure(
      {
        configurationId: "primary-openai",
        provider: "openai",
        model: "primary-model",
        apiKey: "primary-key",
      },
      { timeoutMs: 180_000, maxOutputTokens: 16_384 },
    );

    await expect(
      gateway.queryModel(
        { prompt: "new" },
        {
          configurationId: "new-fallback",
          provider: "openai",
          model: "new-model",
        },
      ),
    ).rejects.toMatchObject({ code: "configuration" });
  });

  it("routes an Anthropic selection to the Anthropic adapter", async () => {
    providerMocks.anthropic.mockResolvedValue({
      provider: "anthropic",
      model: "anthropic-test",
      content: [{ type: "text", text: "hello" }],
    });
    const gateway = new AgentGateway();
    const selection = gateway.configure({
      provider: "anthropic",
      model: "anthropic-test",
      apiKey: "secret",
    });

    await gateway.queryModel({ prompt: "Hello" }, selection);

    expect(selection).toEqual({ provider: "anthropic", model: "anthropic-test" });
    expect(selection).not.toHaveProperty("apiKey");
    expect(providerMocks.anthropic).toHaveBeenCalledOnce();
    expect(providerMocks.openai).not.toHaveBeenCalled();
  });

  it("routes an Anthropic stream through the registered driver", async () => {
    providerMocks.anthropicStream.mockImplementation(async function* () {
      yield { type: "text_delta", text: "hello" };
      yield { type: "complete", content: [{ type: "text", text: "hello" }] };
    });
    const gateway = new AgentGateway();
    const selection = gateway.configure({
      provider: "anthropic",
      model: "anthropic-test",
      apiKey: "secret",
    });
    const chunks = [];

    for await (const chunk of gateway.queryModelStream({ prompt: "Hello" }, selection)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "complete", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(providerMocks.anthropicStream).toHaveBeenCalledOnce();
    expect(providerMocks.openaiStream).not.toHaveBeenCalled();
  });

  it("passes resolved callPath to the registered driver", async () => {
    providerMocks.openai.mockResolvedValue({
      provider: "openai",
      model: "openai-test",
      content: [{ type: "text", text: "hello" }],
    });
    const gateway = new AgentGateway();
    gateway.configure({
      provider: "openai",
      model: "openai-test",
      apiKey: "secret",
      openaiApiMode: "chat-completions",
    });

    await gateway.queryModel({ prompt: "Hello" }, { provider: "openai", model: "openai-test" });

    expect(providerMocks.openai.mock.calls[0][0]).toMatchObject({
      callPath: "chat",
    });
  });

  it("records configuration IDs for regular and streaming usage", async () => {
    providerMocks.openai.mockResolvedValue({
      provider: "openai",
      model: "priced-model",
      content: [{ type: "text", text: "hello" }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    providerMocks.openaiStream.mockImplementation(async function* () {
      yield {
        type: "complete",
        content: [{ type: "text", text: "streamed" }],
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      };
    });
    const gateway = new AgentGateway();
    const recorder = vi.fn().mockResolvedValue(undefined);
    gateway.setUsageRecorder(recorder);
    const selection = gateway.configure({
      configurationId: "price-config",
      provider: "openai",
      model: "priced-model",
      apiKey: "secret",
    });

    await gateway.queryModel({ prompt: "Hello" }, selection);
    for await (const _chunk of gateway.queryModelStream({ prompt: "Hello" }, selection)) {
      // Consume the stream so the completion usage is recorded.
    }

    expect(recorder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        configurationId: "price-config",
        totalTokens: 15,
      }),
    );
    expect(recorder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        configurationId: "price-config",
        totalTokens: 30,
      }),
    );
  });

  it("prepares response contracts, pairing, and ephemeral context once before dispatch", async () => {
    providerMocks.anthropic.mockResolvedValue({
      provider: "anthropic",
      model: "anthropic-test",
      content: [{ type: "text", text: "ok" }],
    });
    const gateway = new AgentGateway();
    const selection = gateway.configure({
      provider: "anthropic",
      model: "anthropic-test",
      apiKey: "secret",
    });
    const messages = [
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: "call-1", name: "Read", input: {} }],
      },
    ];
    const original = structuredClone(messages);

    await gateway.queryModel(
      {
        prompt: "request context",
        systemPrompt: "system",
        responseContract: "markdown",
        messages,
      },
      selection,
    );

    const prepared = providerMocks.anthropic.mock.calls[0][1];
    expect(prepared.systemPrompt).toContain("<!-- RESPONSE_CONTRACT:markdown -->");
    expect(prepared.messages).toEqual([
      messages[0],
      {
        role: "user",
        content: [expect.objectContaining({ type: "tool_result", toolUseId: "call-1" })],
      },
      { role: "user", content: [{ type: "text", text: "request context" }] },
    ]);
    expect(messages).toEqual(original);
  });

  it("rejects empty and malformed driver responses at the Gateway boundary", async () => {
    const gateway = new AgentGateway();
    const selection = gateway.configure({
      provider: "openai",
      model: "openai-test",
      apiKey: "secret",
    });
    providerMocks.openai.mockResolvedValueOnce({
      provider: "openai",
      model: "openai-test",
      content: [],
    });
    await expect(gateway.queryModel({ prompt: "Hello" }, selection)).rejects.toMatchObject({
      code: "empty-response",
      provider: "openai",
    });

    providerMocks.openai.mockResolvedValueOnce({
      provider: "openai",
      model: "openai-test",
      content: [{ type: "text", text: "   " }],
    });
    await expect(gateway.queryModel({ prompt: "Hello" }, selection)).rejects.toMatchObject({
      code: "empty-response",
      provider: "openai",
    });

    providerMocks.openai.mockResolvedValueOnce({
      provider: "openai",
      model: "openai-test",
      content: [{ type: "tool_use", id: "", name: "Read", input: {} }],
    });
    await expect(gateway.queryModel({ prompt: "Hello" }, selection)).rejects.toMatchObject({
      code: "provider-error",
      provider: "openai",
    });

    providerMocks.openai.mockResolvedValueOnce({
      provider: "openai",
      model: "openai-test",
      content: [{ type: "text", text: "hello" }],
      usage: { inputTokens: 1, outputTokens: -1, totalTokens: 0 },
    });
    await expect(gateway.queryModel({ prompt: "Hello" }, selection)).rejects.toMatchObject({
      code: "provider-error",
      provider: "openai",
    });

    providerMocks.openai.mockResolvedValueOnce({
      provider: "openai",
      model: "openai-test",
      content: [{ type: "text", text: "hello" }],
      stopReason: "length",
    });
    await expect(gateway.queryModel({ prompt: "Hello" }, selection)).rejects.toMatchObject({
      code: "provider-error",
      provider: "openai",
    });
  });

  it("normalizes driver errors and enforces one terminal stream event", async () => {
    const gateway = new AgentGateway();
    const selection = gateway.configure({
      provider: "openai",
      model: "openai-test",
      apiKey: "secret",
    });
    providerMocks.openai.mockRejectedValueOnce(
      Object.assign(new Error("slow down"), { status: 429 }),
    );
    await expect(gateway.queryModel({ prompt: "Hello" }, selection)).rejects.toMatchObject({
      code: "rate-limit",
      provider: "openai",
    });

    providerMocks.openaiStream.mockImplementationOnce(async function* () {
      yield { type: "complete", content: [{ type: "text", text: "done" }], stopReason: "length" };
    });
    const consume = async () => {
      for await (const _chunk of gateway.queryModelStream({ prompt: "Hello" }, selection)) {
        // consume
      }
    };
    await expect(consume()).rejects.toMatchObject({
      code: "provider-error",
      provider: "openai",
    });

    providerMocks.openaiStream.mockImplementationOnce(async function* () {
      yield { type: "complete", content: [{ type: "text", text: "done" }] };
      yield { type: "text_delta", text: "late" };
    });
    await expect(consume()).rejects.toMatchObject({
      code: "provider-error",
      provider: "openai",
    });

    providerMocks.openaiStream.mockImplementationOnce(async function* () {
      yield { type: "unexpected", content: [] };
    });
    await expect(consume()).rejects.toMatchObject({
      code: "provider-error",
      provider: "openai",
    });
  });
});
