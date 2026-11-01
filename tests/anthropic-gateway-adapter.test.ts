import { beforeEach, describe, expect, it, vi } from "vitest";

const anthropicMock = vi.hoisted(() => ({
  constructorOptions: undefined as unknown,
  create: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { create: anthropicMock.create, stream: anthropicMock.stream };
    constructor(options: unknown) {
      anthropicMock.constructorOptions = options;
    }
  },
}));

import {
  generateStreamWithAnthropic,
  generateWithAnthropic,
} from "../app/main/agent/gateway/anthropic";
import type { PreparedAgentModelRequest } from "../app/main/agent/gateway/types";

const config = {
  provider: "anthropic" as const,
  model: "anthropic-test",
  apiKey: "secret",
  baseURL: "https://anthropic.example.test",
  callPath: "anthropic" as const,
  timeoutMs: 2345,
  maxOutputTokens: 654,
};

function preparedRequest(
  text: string,
  overrides: Partial<PreparedAgentModelRequest> = {},
): PreparedAgentModelRequest {
  return {
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    maxOutputTokens: config.maxOutputTokens,
    ...overrides,
  };
}

describe("Anthropic driver", () => {
  beforeEach(() => {
    anthropicMock.create.mockReset();
    anthropicMock.stream.mockReset();
    anthropicMock.constructorOptions = undefined;
  });

  it("maps a prepared request and provider response for one SDK attempt", async () => {
    anthropicMock.create.mockResolvedValue({
      content: [
        { type: "thinking", thinking: "hidden", signature: "sig" },
        { type: "text", text: "answer" },
      ],
      _request_id: "req-anthropic",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 25,
        cache_creation_input_tokens: 5,
      },
    });

    const response = await generateWithAnthropic(
      config,
      preparedRequest("User prompt", {
        systemPrompt: "System instruction",
      }),
    );

    expect(anthropicMock.constructorOptions).toEqual({
      apiKey: "secret",
      baseURL: "https://anthropic.example.test",
      timeout: 2345,
      maxRetries: 0,
    });
    expect(anthropicMock.create).toHaveBeenCalledWith(
      {
        model: "anthropic-test",
        max_tokens: 654,
        system: "System instruction",
        messages: [{ role: "user", content: [{ type: "text", text: "User prompt" }] }],
      },
      { signal: undefined },
    );
    expect(response).toEqual({
      provider: "anthropic",
      model: "anthropic-test",
      content: [
        { type: "thinking", thinking: "hidden", signature: "sig" },
        { type: "text", text: "answer" },
      ],
      requestId: "req-anthropic",
      stopReason: "end",
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 170,
        cachedInputTokens: 25,
        cacheCreationInputTokens: 5,
      },
    });
  });

  it("maps native tools, images, and paired tool results without repairing history", async () => {
    anthropicMock.create.mockResolvedValue({
      content: [{ type: "tool_use", id: "tool-2", name: "Read", input: { slide: 2 } }],
      stop_reason: "tool_use",
    });
    const response = await generateWithAnthropic(
      config,
      preparedRequest("", {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tool-1", name: "Preview", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "tool-1",
                content: [{ type: "image", mediaType: "image/png", data: "base64" }],
              },
            ],
          },
        ],
        tools: [{ name: "Read", description: "Read slide", inputSchema: { type: "object" } }],
      }),
    );

    expect(anthropicMock.create.mock.calls[0]?.[0]).toMatchObject({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1" }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: [{ type: "image", source: { media_type: "image/png", data: "base64" } }],
            },
          ],
        },
      ],
      tools: [{ name: "Read" }],
    });
    expect(response.content).toEqual([
      { type: "tool_use", id: "tool-2", name: "Read", input: { slide: 2 } },
    ]);
  });

  it("returns thinking-only truncation without retrying", async () => {
    anthropicMock.create.mockResolvedValue({
      content: [{ type: "thinking", thinking: "still reasoning", signature: "sig" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const response = await generateWithAnthropic(config, preparedRequest("User prompt"));

    expect(anthropicMock.create).toHaveBeenCalledTimes(1);
    expect(response.content).toEqual([
      { type: "thinking", thinking: "still reasoning", signature: "sig" },
    ]);
    expect(response.stopReason).toBe("max_tokens");
  });

  it("maps one stream and emits exactly one complete chunk", async () => {
    anthropicMock.stream.mockReturnValue(
      mockAnthropicStream(
        [
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "reasoning" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "answer" },
          },
        ],
        {
          content: [{ type: "text", text: "answer" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 4 },
        },
      ),
    );

    const chunks = [];
    for await (const chunk of generateStreamWithAnthropic(config, preparedRequest("prompt"))) {
      chunks.push(chunk);
    }

    expect(anthropicMock.stream).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual([
      { type: "thinking_delta", thinking: "reasoning", index: 0 },
      { type: "text_delta", text: "answer", index: 1 },
      {
        type: "complete",
        content: [{ type: "text", text: "answer" }],
        stopReason: "end",
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    ]);
  });

  it("leaves empty-response validation and error normalization to Gateway", async () => {
    anthropicMock.create.mockResolvedValueOnce({ content: [], stop_reason: "end_turn" });
    await expect(generateWithAnthropic(config, preparedRequest("prompt"))).resolves.toMatchObject({
      content: [],
    });

    const source = Object.assign(new Error("slow down"), { status: 429 });
    anthropicMock.create.mockRejectedValueOnce(source);
    await expect(generateWithAnthropic(config, preparedRequest("prompt"))).rejects.toBe(source);
  });

  it("keeps the narrow string-content compatibility fallback", async () => {
    anthropicMock.create.mockResolvedValue({
      content: "compatible response",
      _request_id: "req-compatible",
      stop_reason: "end_turn",
    });

    const response = await generateWithAnthropic(config, preparedRequest("prompt"));
    expect(response.content).toEqual([{ type: "text", text: "compatible response" }]);
  });
});

function mockAnthropicStream(events: unknown[], finalMessage: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    async finalMessage() {
      return finalMessage;
    },
  };
}
