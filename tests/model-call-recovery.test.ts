import { describe, expect, it, vi } from "vitest";
import type { AgentModelGateway, AgentModelMessage } from "../src/main/agent/gateway";
import {
  AgentGatewayError,
  classifyGatewayRecovery,
  isOutputTruncated,
  normalizeProviderError,
} from "../src/main/agent/gateway/errors";
import { computeBackoffDelayMs } from "../src/main/agent/runtime/model/with-retry";
import { callModelWithRecovery } from "../src/main/agent/runtime/turns/model-call-recovery";
import { compactTranscript } from "../src/main/agent/runtime/turns/transcript-compact";

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

function canonicalToolHistory(count: number): AgentModelMessage[] {
  return Array.from({ length: count }, (_, index): AgentModelMessage[] => [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `call-${index}`,
          name: "ReadFile",
          input: { path: `${index}.txt` },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: `call-${index}`,
          content: [{ type: "text", text: `result-${index}` }],
        },
      ],
    },
  ]).flat();
}

describe("computeBackoffDelayMs", () => {
  it("follows exponential backoff with cap", () => {
    expect(computeBackoffDelayMs(1, 0)).toBeGreaterThanOrEqual(500);
    expect(computeBackoffDelayMs(1, 0)).toBeLessThanOrEqual(625);
    expect(computeBackoffDelayMs(2, 0)).toBeGreaterThanOrEqual(1000);
    expect(computeBackoffDelayMs(2, 0)).toBeLessThanOrEqual(1250);
    expect(computeBackoffDelayMs(7, 0)).toBeGreaterThanOrEqual(32000);
    expect(computeBackoffDelayMs(7, 0)).toBeLessThanOrEqual(40000);
  });

  it("prefers Retry-After header when provided", () => {
    expect(computeBackoffDelayMs(3, 2500)).toBe(2500);
  });
});

describe("retryAfterMs on AgentGatewayError", () => {
  it("parses numeric seconds from headers and stores on error", () => {
    const raw = {
      status: 429,
      headers: {
        get: (name: string) => (name === "retry-after" ? "3" : null),
      },
      message: "rate limited",
    };
    const error = normalizeProviderError("anthropic", raw) as AgentGatewayError;
    expect(error.retryAfterMs).toBe(3000);
  });
});

describe("gateway recovery classification", () => {
  it("maps 529 to overloaded and retry-backoff", () => {
    const error = normalizeProviderError(
      "anthropic",
      Object.assign(new Error("overloaded"), { status: 529 }),
    );
    expect(error.code).toBe("overloaded");
    expect(classifyGatewayRecovery(error)).toBe("retry-backoff");
  });

  it("maps prompt too long messages", () => {
    const error = normalizeProviderError(
      "openai",
      Object.assign(new Error("maximum context length exceeded"), { status: 400 }),
    );
    expect(error.code).toBe("prompt-too-long");
    expect(classifyGatewayRecovery(error)).toBe("compact-context");
  });

  it.each([400, 404, 422])("does not retry a deterministic HTTP %s provider error", (status) => {
    const error = normalizeProviderError(
      "openai",
      Object.assign(new Error("invalid request"), { status }),
    );
    expect(classifyGatewayRecovery(error)).toBe("non-recoverable");
  });

  it.each([408, 429])("keeps recoverable HTTP %s errors on backoff", (status) => {
    const error = normalizeProviderError(
      "openai",
      Object.assign(new Error("retry later"), { status }),
    );
    expect(classifyGatewayRecovery(error)).toBe("retry-backoff");
  });

  it("detects output truncation stop reasons", () => {
    expect(isOutputTruncated("max_tokens")).toBe(true);
    expect(isOutputTruncated("end")).toBe(false);
    expect(isOutputTruncated("tool_use")).toBe(false);
  });

  it("rejects raw provider errors until Gateway normalizes them", () => {
    expect(classifyGatewayRecovery(Object.assign(new Error("rate limited"), { status: 429 }))).toBe(
      "non-recoverable",
    );
    expect(classifyGatewayRecovery(Object.assign(new Error("overloaded"), { status: 529 }))).toBe(
      "non-recoverable",
    );
    expect(classifyGatewayRecovery(new Error("prompt is too long"))).toBe("non-recoverable");
  });
});

describe("compactTranscript", () => {
  it("keeps recent entries and adds compact boundary", () => {
    const transcript = Array.from({ length: 10 }, (_, index) => ({
      role: "tool",
      toolName: `tool-${index}`,
      result: `result-${index}`,
    }));
    const compacted = compactTranscript(transcript, 3);
    expect(compacted).toHaveLength(4);
    expect(compacted[0]).toMatchObject({ kind: "compact_boundary" });
    expect(compacted.at(-1)).toMatchObject({ toolName: "tool-9" });
  });
});

describe("callModelWithRecovery", () => {
  it("projects provider-neutral content blocks into the compatibility result", async () => {
    const gateway: AgentModelGateway = {
      async queryModel() {
        return {
          provider: "anthropic",
          model: "test",
          content: [
            {
              type: "tool_use",
              id: "call-from-block",
              name: "ReadPresentationSnapshot",
              input: {},
            },
          ],
        };
      },
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };

    const result = await callModelWithRecovery({
      gateway,
      systemPrompt: "system",
      promptPayload: { transcript: [], request: "hello" },
    });

    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "call-from-block",
        name: "ReadPresentationSnapshot",
        input: {},
      },
    ]);
  });

  it("retries the same request on 429 without appending partial output", async () => {
    vi.useFakeTimers();
    const rateLimit = new AgentGatewayError(
      "openai rate limit exceeded: rate limited",
      "rate-limit",
      "openai",
    );
    const queryModel = vi
      .fn()
      .mockRejectedValueOnce(rateLimit)
      .mockResolvedValueOnce({ provider: "openai", model: "gpt", content: textContent("ok") });

    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };
    const progress: string[] = [];

    const promise = callModelWithRecovery({
      gateway,
      systemPrompt: "system",
      promptPayload: { transcript: [], request: "hello" },
      onRecovery: (message) => progress.push(message),
    });

    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.content).toEqual(textContent("ok"));
    expect(queryModel).toHaveBeenCalledTimes(2);
    expect(JSON.parse(queryModel.mock.calls[0][0].prompt)).toEqual({
      transcript: [],
      request: "hello",
    });
    expect(JSON.parse(queryModel.mock.calls[1][0].prompt)).toEqual({
      transcript: [],
      request: "hello",
    });
    expect(progress).toEqual(["服务暂时繁忙，正在重试…"]);
    expect(result.recoveryNotes[0]).toMatch(/临时故障|Retry-After|指数退避/);
    vi.useRealTimers();
  });

  it.each([400, 404])("fails fast on HTTP %s without entering backoff", async (status) => {
    const source = Object.assign(new Error("invalid request"), { status });
    const error = normalizeProviderError("openai", source);
    const queryModel = vi.fn().mockRejectedValue(error);
    const progress: string[] = [];
    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };

    await expect(
      callModelWithRecovery({
        gateway,
        systemPrompt: "system",
        promptPayload: { transcript: [], request: "hello" },
        onRecovery: (message) => progress.push(message),
      }),
    ).rejects.toBe(error);

    expect(queryModel).toHaveBeenCalledTimes(1);
    expect(progress).toEqual([]);
  });

  it("fails fast on raw 429 that bypassed Gateway normalization", async () => {
    const error = Object.assign(new Error("rate limited"), { status: 429 });
    const queryModel = vi.fn().mockRejectedValue(error);
    const progress: string[] = [];
    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };

    await expect(
      callModelWithRecovery({
        gateway,
        systemPrompt: "system",
        promptPayload: { transcript: [], request: "hello" },
        onRecovery: (message) => progress.push(message),
      }),
    ).rejects.toBe(error);

    expect(queryModel).toHaveBeenCalledTimes(1);
    expect(progress).toEqual([]);
  });

  it("does not notify or wait for another retry after the final failed attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const error = new AgentGatewayError(
      "openai rate limit exceeded: rate limited",
      "rate-limit",
      "openai",
      undefined,
      1_000,
    );
    const queryModel = vi.fn().mockRejectedValue(error);
    const progress: string[] = [];
    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };

    const startedAt = Date.now();
    const promise = callModelWithRecovery({
      gateway,
      systemPrompt: "system",
      promptPayload: { transcript: [], request: "hello" },
      onRecovery: (message) => progress.push(message),
    });
    const rejection = expect(promise).rejects.toBe(error);

    await vi.runAllTimersAsync();
    await rejection;
    expect(queryModel).toHaveBeenCalledTimes(8);
    expect(progress).toHaveLength(7);
    expect(Date.now() - startedAt).toBe(7_000);
    vi.useRealTimers();
  });

  it("honors AgentGatewayError.retryAfterMs when backing off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const rateLimit = new AgentGatewayError(
      "anthropic rate limit exceeded: rate limited",
      "rate-limit",
      "anthropic",
      undefined,
      2_500,
    );
    const queryModel = vi
      .fn()
      .mockRejectedValueOnce(rateLimit)
      .mockResolvedValueOnce({ provider: "anthropic", model: "test", content: textContent("ok") });
    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };
    const notes: string[] = [];

    const startedAt = Date.now();
    const promise = callModelWithRecovery({
      gateway,
      systemPrompt: "system",
      promptPayload: { transcript: [], request: "hello" },
      onRecovery: (message) => notes.push(message),
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.content).toEqual(textContent("ok"));
    expect(queryModel).toHaveBeenCalledTimes(2);
    expect(Date.now() - startedAt).toBe(2_500);
    expect(result.recoveryNotes[0]).toMatch(/Retry-After/);
    expect(notes).toEqual(["服务暂时繁忙，正在重试…"]);
    vi.useRealTimers();
  });

  it("emergency-trims transcript on prompt-too-long before retrying", async () => {
    const queryModel = vi
      .fn()
      .mockRejectedValueOnce(
        new AgentGatewayError(
          "openai prompt too long: prompt is too long",
          "prompt-too-long",
          "openai",
        ),
      )
      .mockResolvedValueOnce({ provider: "openai", model: "gpt", content: textContent("ok") });

    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };

    const transcript = Array.from({ length: 10 }, (_, index) => ({
      role: "tool",
      toolName: `tool-${index}`,
      result: `result-${index}`,
    }));

    const result = await callModelWithRecovery({
      gateway,
      systemPrompt: "system",
      promptPayload: { transcript, request: "hello" },
    });

    expect(result.content).toEqual(textContent("ok"));
    expect(result.hasAttemptedReactiveCompact).toBe(true);
    const retriedPrompt = JSON.parse(queryModel.mock.calls[1][0].prompt);
    expect(retriedPrompt.transcript[0]).toMatchObject({ kind: "compact_boundary" });
    expect(retriedPrompt.transcript.length).toBeLessThanOrEqual(5);
  });

  it("emergency-trims canonical native messages and keeps the caller history immutable", async () => {
    const queryModel = vi
      .fn()
      .mockRejectedValueOnce(
        new AgentGatewayError(
          "openai prompt too long: maximum context length exceeded",
          "prompt-too-long",
          "openai",
        ),
      )
      .mockResolvedValueOnce({
        provider: "openai",
        model: "gpt",
        content: textContent("ok"),
      });
    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };
    const messages = canonicalToolHistory(8);
    const original = structuredClone(messages);
    const preparedSnapshots: AgentModelMessage[][] = [];

    const result = await callModelWithRecovery({
      gateway,
      systemPrompt: "system",
      promptPayload: { transcript: [], request: "hello" },
      messages,
      onContextPrepared: (_payload, _notes, prepared) => {
        if (prepared) preparedSnapshots.push(prepared);
      },
    });

    expect(result.content).toEqual(textContent("ok"));
    expect(queryModel.mock.calls[1][0].messages.length).toBeLessThan(messages.length);
    expect(preparedSnapshots.some((snapshot) => snapshot.length < messages.length)).toBe(true);
    expect(messages).toEqual(original);
  });

  it("upgrades max tokens before using continuation prompt", async () => {
    const queryModel = vi
      .fn()
      .mockResolvedValueOnce({
        provider: "anthropic",
        model: "claude",
        content: textContent("partial response"),
        stopReason: "max_tokens",
      })
      .mockResolvedValueOnce({
        provider: "anthropic",
        model: "claude",
        content: textContent("done"),
        stopReason: "end",
      });

    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };
    const progress: string[] = [];

    const result = await callModelWithRecovery({
      gateway,
      systemPrompt: "system",
      promptPayload: { transcript: [], request: "hello" },
      model: { provider: "anthropic", model: "claude" },
      onRecovery: (message) => progress.push(message),
    });

    expect(result.content).toEqual(textContent("done"));
    expect(queryModel.mock.calls[0][0].maxOutputTokens).toBeUndefined();
    expect(queryModel.mock.calls[1][0].maxOutputTokens).toBe(65536);
    expect(JSON.parse(queryModel.mock.calls[1][0].prompt)).toEqual({
      transcript: [],
      request: "hello",
    });
    expect(progress).toEqual(["回复内容较长，正在继续生成…"]);
    expect(result.recoveryNotes[0]).toContain("max_tokens");
    expect(result.maxOutputTokensOverride).toBe(65536);
    expect(result.maxOutputTokensRecoveryCount).toBe(1);
  });

  it("retries thinking-only exhaustion once with a concrete action and unchanged budget", async () => {
    const queryModel = vi
      .fn()
      .mockResolvedValueOnce({
        provider: "anthropic",
        model: "claude",
        content: [{ type: "thinking", thinking: "still reasoning", signature: "sig" }],
        stopReason: "max_tokens",
      })
      .mockResolvedValueOnce({
        provider: "anthropic",
        model: "claude",
        content: textContent("answer"),
        stopReason: "end",
      });
    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };

    const result = await callModelWithRecovery({
      gateway,
      systemPrompt: "system",
      promptPayload: { transcript: [], request: "hello" },
      model: { provider: "anthropic", model: "claude" },
    });

    expect(queryModel).toHaveBeenCalledTimes(2);
    expect(queryModel.mock.calls[0][0].maxOutputTokens).toBeUndefined();
    expect(queryModel.mock.calls[1][0].maxOutputTokens).toBeUndefined();
    expect(queryModel.mock.calls[1][0].systemPrompt).toContain("write only the next page");
    expect(result.content).toEqual(textContent("answer"));
    expect(result.maxOutputTokensRecoveryCount).toBe(0);
  });

  it("stops repeated reasoning-only exhaustion without budget escalation or backoff", async () => {
    const queryModel = vi.fn().mockResolvedValue({
      provider: "anthropic",
      model: "claude",
      content: [{ type: "thinking", thinking: "still reasoning", signature: "sig" }],
      stopReason: "max_tokens",
    });
    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };
    await expect(
      callModelWithRecovery({
        gateway,
        systemPrompt: "system",
        promptPayload: { transcript: [], request: "create" },
        maxOutputTokensOverride: 16384,
      }),
    ).rejects.toThrow("twice without text or tool calls");
    expect(queryModel).toHaveBeenCalledTimes(2);
    expect(queryModel.mock.calls.map(([request]) => request.maxOutputTokens)).toEqual([
      16384, 16384,
    ]);
  });

  it("merges every max-output continuation and keeps detecting repeated truncation", async () => {
    const queryModel = vi
      .fn()
      .mockResolvedValueOnce({
        provider: "anthropic",
        model: "claude",
        content: textContent("alpha"),
        stopReason: "max_tokens",
      })
      .mockResolvedValueOnce({
        provider: "anthropic",
        model: "claude",
        content: textContent("beta"),
        stopReason: "max_tokens",
      })
      .mockResolvedValueOnce({
        provider: "anthropic",
        model: "claude",
        content: textContent("gamma"),
        stopReason: "end",
      });
    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };

    const result = await callModelWithRecovery({
      gateway,
      systemPrompt: "system",
      promptPayload: { transcript: [], request: "hello" },
      maxOutputTokensOverride: 65_536,
    });

    expect(result.content).toEqual(textContent("alphabetagamma"));
    expect(queryModel).toHaveBeenCalledTimes(3);
    expect(JSON.parse(queryModel.mock.calls[1][0].prompt).continuation.partialOutput).toBe("alpha");
    expect(JSON.parse(queryModel.mock.calls[2][0].prompt).continuation.partialOutput).toBe(
      "alphabeta",
    );
    expect(result.stopReason).toBe("end");
  });

  it("continues native history from an ephemeral assistant partial", async () => {
    const queryModel = vi
      .fn()
      .mockResolvedValueOnce({
        provider: "anthropic",
        model: "claude",
        content: textContent("first-half"),
        stopReason: "max_tokens",
      })
      .mockResolvedValueOnce({
        provider: "anthropic",
        model: "claude",
        content: textContent("-second-half"),
        stopReason: "end",
      });
    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };
    const messages: AgentModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "canonical request" }],
      },
    ];
    const original = structuredClone(messages);

    const result = await callModelWithRecovery({
      gateway,
      systemPrompt: "system",
      promptPayload: {
        transcript: [],
        queryContext: {
          source: "user",
          user: { locale: "zh-CN" },
          system: { surface: "desktop" },
        },
      },
      messages,
      maxOutputTokensOverride: 65_536,
    });

    expect(result.content).toEqual(textContent("first-half-second-half"));
    expect(queryModel.mock.calls[1][0].prompt).toBe("");
    expect(queryModel.mock.calls[1][0].messages.at(-2)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "first-half" }],
    });
    const continuationContext = JSON.parse(
      queryModel.mock.calls[1][0].messages.at(-3).content[0].text,
    );
    expect(continuationContext.queryContext.user.locale).toBe("zh-CN");
    expect(messages).toEqual(original);
  });

  it("never reports success while every continuation remains truncated", async () => {
    const gateway: AgentModelGateway = {
      async queryModel() {
        return {
          provider: "anthropic",
          model: "claude",
          content: textContent("partial"),
          stopReason: "max_tokens",
        };
      },
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };

    await expect(
      callModelWithRecovery({
        gateway,
        systemPrompt: "system",
        promptPayload: { transcript: [], request: "hello" },
        maxOutputTokensOverride: 65_536,
      }),
    ).rejects.toThrow("remained truncated");
  });

  it("uses the query fallback model after consecutive overloads", async () => {
    vi.useFakeTimers();
    const queryModel = vi
      .fn()
      .mockRejectedValueOnce(
        normalizeProviderError("openai", Object.assign(new Error("overloaded"), { status: 529 })),
      )
      .mockRejectedValueOnce(
        normalizeProviderError("openai", Object.assign(new Error("overloaded"), { status: 529 })),
      )
      .mockResolvedValueOnce({
        provider: "anthropic",
        model: "fallback",
        content: textContent("ok"),
      });
    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };

    const promise = callModelWithRecovery({
      gateway,
      systemPrompt: "system",
      promptPayload: { transcript: [] },
      model: { provider: "openai", model: "primary" },
      fallbackModel: { provider: "anthropic", model: "fallback" },
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(queryModel.mock.calls.map((call) => call[1])).toEqual([
      { provider: "openai", model: "primary" },
      { provider: "openai", model: "primary" },
      { provider: "anthropic", model: "fallback" },
    ]);
    expect(result.modelUsed).toEqual({ provider: "anthropic", model: "fallback" });
    vi.useRealTimers();
  });
});
