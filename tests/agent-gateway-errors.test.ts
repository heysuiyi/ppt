import { describe, expect, it } from "vitest";
import { AgentGatewayError, normalizeProviderError } from "../app/main/agent/gateway/errors";

describe("normalizeProviderError", () => {
  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [429, "rate-limit"],
    [529, "overloaded"],
    [408, "timeout"],
    [500, "provider-error"],
  ] as const)("maps HTTP %s to %s", (status, code) => {
    const source = Object.assign(new Error("provider message"), { status });
    const error = normalizeProviderError("openai", source);

    expect(error).toBeInstanceOf(AgentGatewayError);
    expect(error.code).toBe(code);
    expect(error.provider).toBe("openai");
    expect(error.cause).toBe(source);
  });

  it("recognizes timeout errors without an HTTP status", () => {
    const source = Object.assign(new Error("socket timed out"), { name: "ConnectionTimeoutError" });
    const error = normalizeProviderError("anthropic", source);

    expect(error.code).toBe("timeout");
    expect(error.provider).toBe("anthropic");
    expect(error.message).toContain("Settings");
  });

  it("does not wrap an existing gateway error", () => {
    const source = new AgentGatewayError("empty", "empty-response", "openai");

    expect(normalizeProviderError("openai", source)).toBe(source);
  });

  it("maps terminated stream errors to connection guidance", () => {
    const source = Object.assign(new Error("terminated"), { name: "AnthropicError" });
    const error = normalizeProviderError("anthropic", source);

    expect(error.code).toBe("provider-error");
    expect(error.message).toContain("connection terminated");
  });

  it("maps abort-like errors when the run signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const error = normalizeProviderError(
      "anthropic",
      Object.assign(new Error("terminated"), { name: "AnthropicError" }),
      controller.signal,
    );

    expect(error).toBeInstanceOf(AgentGatewayError);
    expect(error.code).toBe("aborted");
    expect(error.message).toBe("Run aborted by user.");
  });

  it("attaches retryAfterMs from numeric Retry-After headers", () => {
    const source = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: { get: (name: string) => (name === "retry-after" ? "3" : null) },
    });
    const error = normalizeProviderError("openai", source);

    expect(error.code).toBe("rate-limit");
    expect(error.retryAfterMs).toBe(3000);
  });
});
