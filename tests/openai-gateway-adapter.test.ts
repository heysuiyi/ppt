import { beforeEach, describe, expect, it, vi } from "vitest";

const openAIMock = vi.hoisted(() => ({
  constructorOptions: undefined as unknown,
  chatCreate: vi.fn(),
  chatStream: vi.fn(),
  responsesCreate: vi.fn(),
  responsesStream: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class OpenAI {
    chat = {
      completions: {
        create: openAIMock.chatCreate,
        stream: openAIMock.chatStream,
      },
    };
    responses = {
      create: openAIMock.responsesCreate,
      stream: openAIMock.responsesStream,
    };
    constructor(options: unknown) {
      openAIMock.constructorOptions = options;
    }
  },
}));

import { chatDriver, responsesDriver } from "../app/main/agent/gateway/openai";
import type { PreparedAgentModelRequest } from "../app/main/agent/gateway/types";

const baseConfig = {
  provider: "openai" as const,
  model: "openai-test",
  apiKey: "secret",
  baseURL: "https://openai.example.test",
  callPath: "responses" as const,
  timeoutMs: 2345,
  maxOutputTokens: 321,
};

function preparedRequest(
  text: string,
  overrides: Partial<PreparedAgentModelRequest> = {},
): PreparedAgentModelRequest {
  return {
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    maxOutputTokens: baseConfig.maxOutputTokens,
    ...overrides,
  };
}

describe("OpenAI driver", () => {
  beforeEach(() => {
    openAIMock.chatCreate.mockReset();
    openAIMock.chatStream.mockReset();
    openAIMock.responsesCreate.mockReset();
    openAIMock.responsesStream.mockReset();
    openAIMock.constructorOptions = undefined;
  });

  it("maps a prepared Chat Completions request and usage", async () => {
    openAIMock.chatCreate.mockResolvedValue({
      choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
      _request_id: "req-chat",
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    const config = { ...baseConfig, callPath: "chat" as const };

    const response = await chatDriver.generate(
      config,
      preparedRequest("prompt", {
        systemPrompt: "system",
      }),
    );

    expect(openAIMock.constructorOptions).toEqual({
      apiKey: "secret",
      baseURL: "https://openai.example.test",
      timeout: 2345,
      maxRetries: 0,
    });
    expect(openAIMock.chatCreate).toHaveBeenCalledWith(
      {
        model: "openai-test",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "prompt" },
        ],
        max_tokens: 321,
      },
      { signal: undefined },
    );
    expect(response).toEqual({
      provider: "openai",
      model: "openai-test",
      content: [{ type: "text", text: "answer" }],
      requestId: "req-chat",
      stopReason: "end",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
  });

  it("omits Chat Completions image_url parts from tool-result thumbnails", async () => {
    openAIMock.chatCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });

    await chatDriver.generate(
      { ...baseConfig, callPath: "chat" },
      preparedRequest("", {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call-1", name: "PreviewSvgPage", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "call-1",
                content: [
                  { type: "text", text: '{"previewGatePassed":true}' },
                  { type: "image", mediaType: "image/png", data: "aaa" },
                ],
              },
            ],
          },
        ],
      }),
    );

    const request = openAIMock.chatCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(JSON.stringify(request.messages)).not.toContain("image_url");
    expect(request.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining(
            "Image omitted for Chat Completions compatibility: image/png, 3 base64 characters",
          ),
        }),
      ]),
    );
  });

  it("enables MiMo thinking and streams reasoning_content as thinking deltas", async () => {
    const finalChatCompletion = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            reasoning_content: "plan the next tool",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "Read", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    openAIMock.chatStream.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            {
              delta: { reasoning_content: "plan " },
              finish_reason: null,
            },
          ],
        };
        yield {
          choices: [
            {
              delta: { reasoning_content: "the next tool" },
              finish_reason: null,
            },
          ],
        };
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "Read", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        };
      },
      finalChatCompletion,
    });

    const chunks = [];
    for await (const chunk of chatDriver.generateStream(
      { ...baseConfig, callPath: "chat", model: "mimo-v2.5-pro" },
      preparedRequest("prompt", {
        tools: [{ name: "Read", description: "Read", inputSchema: { type: "object" } }],
      }),
    )) {
      chunks.push(chunk);
    }

    expect(openAIMock.chatStream.mock.calls[0]?.[0]).toMatchObject({
      model: "mimo-v2.5-pro",
      thinking: { type: "enabled" },
    });
    expect(chunks).toEqual([
      { type: "thinking_delta", thinking: "plan " },
      { type: "thinking_delta", thinking: "the next tool" },
      {
        type: "complete",
        content: [
          {
            type: "thinking",
            thinking: "plan the next tool",
            signature: "chat-reasoning",
          },
          { type: "tool_use", id: "call-1", name: "Read", input: {} },
        ],
        stopReason: "tool_use",
      },
    ]);
  });

  it("round-trips assistant reasoning_content for MiMo tool turns", async () => {
    openAIMock.chatCreate.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });

    await chatDriver.generate(
      { ...baseConfig, callPath: "chat", model: "mimo-v2.5-pro" },
      preparedRequest("", {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "need Read",
                signature: "chat-reasoning",
              },
              { type: "tool_use", id: "call-1", name: "Read", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "call-1",
                content: [{ type: "text", text: "done" }],
              },
            ],
          },
        ],
      }),
    );

    expect(openAIMock.chatCreate.mock.calls[0]?.[0]).toMatchObject({
      thinking: { type: "enabled" },
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          reasoning_content: "need Read",
          tool_calls: [expect.objectContaining({ id: "call-1" })],
        }),
      ]),
    });
  });

  it("maps Responses input, native tool calls, and cached usage", async () => {
    openAIMock.responsesCreate.mockResolvedValue({
      output_text: "Inspecting",
      output: [
        {
          type: "reasoning",
          id: "reasoning-1",
          summary: [{ type: "summary_text", text: "I should inspect slide 2." }],
        },
        {
          type: "function_call",
          call_id: "call-2",
          name: "Read",
          arguments: '{"slide":2}',
        },
      ],
      status: "completed",
      _request_id: "req-response",
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        total_tokens: 25,
        input_tokens_details: { cached_tokens: 7 },
      },
    });

    const response = await responsesDriver.generate(
      baseConfig,
      preparedRequest("", {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call-1", name: "Preview", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "call-1",
                content: [{ type: "text", text: "done" }],
              },
            ],
          },
        ],
        tools: [{ name: "Read", description: "Read", inputSchema: { type: "object" } }],
      }),
    );

    expect(openAIMock.responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      instructions: undefined,
      input: [
        { type: "function_call", call_id: "call-1", name: "Preview", arguments: "{}" },
        { type: "function_call_output", call_id: "call-1", output: "done" },
      ],
      max_output_tokens: 321,
      reasoning: { effort: "medium", summary: "auto" },
      tools: [{ type: "function", name: "Read" }],
    });
    expect(response.content).toEqual([
      {
        type: "thinking",
        thinking: "I should inspect slide 2.",
        signature: "reasoning-1",
      },
      { type: "text", text: "Inspecting" },
      { type: "tool_use", id: "call-2", name: "Read", input: { slide: 2 } },
    ]);
    expect(response.stopReason).toBe("tool_use");
    expect(response.usage).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      cachedInputTokens: 7,
    });
  });

  it.each(["none", "minimal", "low", "medium", "high", "xhigh"])(
    "sends explicit Responses reasoning effort %s instead of medium",
    async (reasoningEffort) => {
      openAIMock.responsesCreate.mockResolvedValue({
        output_text: "answer",
        output: [],
        status: "completed",
      });
      await responsesDriver.generate({ ...baseConfig, reasoningEffort }, preparedRequest("prompt"));
      expect(openAIMock.responsesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ reasoning: { effort: reasoningEffort, summary: "auto" } }),
        expect.anything(),
      );
    },
  );

  it("preserves malformed Chat tool arguments as a non-executable block", async () => {
    openAIMock.chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "Read", arguments: "{" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    const response = await chatDriver.generate(
      { ...baseConfig, callPath: "chat" },
      preparedRequest("prompt"),
    );

    expect(response.content).toEqual([
      {
        type: "tool_use",
        id: "call-1",
        name: "Read",
        input: {},
        parseError: expect.stringContaining("Invalid tool argument JSON"),
      },
    ]);
    expect(response.stopReason).toBe("tool_use");
  });

  it("maps Chat length finish_reason to max_tokens", async () => {
    openAIMock.chatCreate.mockResolvedValue({
      choices: [{ message: { content: "partial" }, finish_reason: "length" }],
    });

    const response = await chatDriver.generate(
      { ...baseConfig, callPath: "chat" },
      preparedRequest("prompt"),
    );

    expect(response.stopReason).toBe("max_tokens");
    expect(response.content).toEqual([{ type: "text", text: "partial" }]);
  });

  it("maps Responses incomplete max_output_tokens to max_tokens", async () => {
    openAIMock.responsesCreate.mockResolvedValue({
      output_text: "partial",
      output: [],
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });

    const response = await responsesDriver.generate(baseConfig, preparedRequest("prompt"));

    expect(response.stopReason).toBe("max_tokens");
    expect(response.content).toEqual([{ type: "text", text: "partial" }]);
  });

  it("streams Chat text and reports one complete chunk", async () => {
    const finalChatCompletion = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    openAIMock.chatStream.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "hel" }, finish_reason: null }] };
        yield { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] };
      },
      finalChatCompletion,
    });
    const controller = new AbortController();

    const chunks = [];
    for await (const chunk of chatDriver.generateStream(
      { ...baseConfig, callPath: "chat" },
      preparedRequest("prompt", { signal: controller.signal }),
    )) {
      chunks.push(chunk);
    }

    expect(openAIMock.chatCreate).not.toHaveBeenCalled();
    expect(openAIMock.chatStream).toHaveBeenCalledTimes(1);
    expect(openAIMock.chatStream).toHaveBeenCalledWith(
      {
        model: "openai-test",
        messages: [{ role: "user", content: "prompt" }],
        max_tokens: 321,
        stream_options: { include_usage: true },
      },
      { signal: controller.signal },
    );
    expect(finalChatCompletion).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual([
      { type: "text_delta", text: "hel" },
      { type: "text_delta", text: "lo" },
      {
        type: "complete",
        content: [{ type: "text", text: "hello" }],
        stopReason: "end",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      },
    ]);
  });

  it("streams Chat requests with tools and uses the final accumulated tool call", async () => {
    const finalChatCompletion = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "Read", arguments: '{"slide":2}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    openAIMock.chatStream.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "Read", arguments: '{"slide":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
        yield {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: "2}" } }] },
              finish_reason: "tool_calls",
            },
          ],
        };
      },
      finalChatCompletion,
    });

    const chunks = [];
    for await (const chunk of chatDriver.generateStream(
      { ...baseConfig, callPath: "chat" },
      preparedRequest("prompt", {
        tools: [{ name: "Read", description: "Read", inputSchema: { type: "object" } }],
      }),
    )) {
      chunks.push(chunk);
    }

    expect(openAIMock.chatCreate).not.toHaveBeenCalled();
    expect(openAIMock.chatStream).toHaveBeenCalledTimes(1);
    expect(openAIMock.chatStream.mock.calls[0]?.[0]).toMatchObject({
      stream_options: { include_usage: true },
      tools: [
        {
          type: "function",
          function: {
            name: "Read",
            description: "Read",
            parameters: { type: "object" },
            strict: true,
          },
        },
      ],
    });
    expect(chunks).toEqual([
      {
        type: "complete",
        content: [{ type: "tool_use", id: "call-1", name: "Read", input: { slide: 2 } }],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      },
    ]);
  });

  it("streams Responses text and uses finalResponse for complete content", async () => {
    const finalResponse = vi.fn().mockResolvedValue({
      output_text: "answer",
      output: [
        {
          type: "reasoning",
          id: "reasoning-2",
          summary: [{ type: "summary_text", text: "Inspect the requested slide." }],
        },
        {
          type: "function_call",
          call_id: "call-2",
          name: "Read",
          arguments: '{"slide":2}',
        },
      ],
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    openAIMock.responsesStream.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "response.reasoning_summary_text.delta",
          delta: "Inspect the requested slide.",
          output_index: 0,
        };
        yield { type: "response.output_text.delta", delta: "ans" };
        yield { type: "response.function_call_arguments.delta", delta: '{"slide":' };
        yield { type: "response.output_text.delta", delta: "wer" };
      },
      finalResponse,
    });
    const controller = new AbortController();

    const chunks = [];
    for await (const chunk of responsesDriver.generateStream(
      { ...baseConfig, reasoningEffort: "high" },
      preparedRequest("prompt", {
        signal: controller.signal,
        tools: [{ name: "Read", description: "Read", inputSchema: { type: "object" } }],
      }),
    )) {
      chunks.push(chunk);
    }

    expect(openAIMock.responsesCreate).not.toHaveBeenCalled();
    expect(openAIMock.responsesStream).toHaveBeenCalledTimes(1);
    expect(openAIMock.responsesStream).toHaveBeenCalledWith(
      {
        model: "openai-test",
        instructions: undefined,
        input: [{ role: "user", content: "prompt" }],
        max_output_tokens: 321,
        reasoning: { effort: "high", summary: "auto" },
        tools: [
          {
            type: "function",
            name: "Read",
            description: "Read",
            parameters: { type: "object" },
            strict: true,
          },
        ],
      },
      { signal: controller.signal },
    );
    expect(finalResponse).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual([
      {
        type: "thinking_delta",
        thinking: "Inspect the requested slide.",
        index: 0,
      },
      { type: "text_delta", text: "ans" },
      { type: "text_delta", text: "wer" },
      {
        type: "complete",
        content: [
          {
            type: "thinking",
            thinking: "Inspect the requested slide.",
            signature: "reasoning-2",
          },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "call-2", name: "Read", input: { slide: 2 } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    ]);
  });

  it("maps an incomplete final Responses stream to max_tokens", async () => {
    const finalResponse = vi.fn().mockResolvedValue({
      output_text: "partial",
      output: [],
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    openAIMock.responsesStream.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: "response.output_text.delta", delta: "partial" };
      },
      finalResponse,
    });

    const chunks = [];
    for await (const chunk of responsesDriver.generateStream(
      baseConfig,
      preparedRequest("prompt"),
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: "text_delta", text: "partial" },
      {
        type: "complete",
        content: [{ type: "text", text: "partial" }],
        stopReason: "max_tokens",
      },
    ]);
  });

  it("preserves raw streaming SDK errors without issuing another request", async () => {
    const source = Object.assign(new Error("rate limited"), { status: 429 });
    const finalResponse = vi.fn();
    openAIMock.responsesStream.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        throw source;
      },
      finalResponse,
    });

    const collect = async () => {
      for await (const _chunk of responsesDriver.generateStream(
        baseConfig,
        preparedRequest("prompt"),
      )) {
        // Consume the attempt so the SDK error crosses the adapter boundary.
      }
    };

    await expect(collect()).rejects.toBe(source);
    expect(openAIMock.responsesStream).toHaveBeenCalledTimes(1);
    expect(openAIMock.responsesCreate).not.toHaveBeenCalled();
    expect(finalResponse).not.toHaveBeenCalled();
  });

  it("leaves empty-response validation and error normalization to Gateway", async () => {
    openAIMock.responsesCreate.mockResolvedValueOnce({
      output_text: "",
      output: [],
      status: "completed",
    });
    await expect(
      responsesDriver.generate(baseConfig, preparedRequest("prompt")),
    ).resolves.toMatchObject({
      content: [],
      stopReason: "end",
    });

    const source = Object.assign(new Error("rate limited"), { status: 429 });
    openAIMock.responsesCreate.mockRejectedValueOnce(source);
    await expect(responsesDriver.generate(baseConfig, preparedRequest("prompt"))).rejects.toBe(
      source,
    );
  });
});
