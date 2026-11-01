import type { AgentProvider } from "@shared/agent";
import type { StopReason } from "./types";

export type AgentGatewayErrorCode =
  | "configuration"
  | "authentication"
  | "rate-limit"
  | "overloaded"
  | "prompt-too-long"
  | "timeout"
  | "empty-response"
  | "aborted"
  | "provider-error";

export type GatewayRecoveryKind =
  | "retry-backoff"
  | "compact-context"
  | "upgrade-output-tokens"
  | "continue-output"
  | "switch-fallback-model"
  | "non-recoverable";

export class AgentGatewayError extends Error {
  constructor(
    message: string,
    readonly code: AgentGatewayErrorCode,
    readonly provider?: AgentProvider,
    readonly cause?: unknown,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AgentGatewayError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
  return (error as { name?: string }).name ?? "";
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") return status;
  if (error instanceof AgentGatewayError && error.cause !== error) {
    return errorStatus(error.cause);
  }
  return undefined;
}

function isDeterministicClientError(error: unknown): boolean {
  const status = errorStatus(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const name = errorName(error);
  const message = errorMessage(error);
  return (
    name === "APIUserAbortError" ||
    name === "AbortError" ||
    /aborted/i.test(message) ||
    /Request was aborted/i.test(message)
  );
}

function isConnectionTerminated(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message === "terminated" ||
    /connection (?:closed|reset|terminated)/i.test(message) ||
    /socket hang up/i.test(message)
  );
}

function parseRetryAfterHeader(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.ceil(value * 1000);
  }
  if (typeof value === "string") {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
    const dateMs = Date.parse(value);
    if (Number.isFinite(dateMs)) {
      const delay = dateMs - Date.now();
      return delay > 0 ? delay : undefined;
    }
  }
  return undefined;
}

function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;

  const headers = (error as { headers?: unknown }).headers;
  if (headers && typeof headers === "object") {
    const get = (headers as { get?: (name: string) => string | null }).get;
    if (typeof get === "function") {
      const value = get.call(headers, "retry-after");
      const parsed = parseRetryAfterHeader(value);
      if (parsed !== undefined) return parsed;
    }
    const retryAfter = (headers as { "retry-after"?: unknown })["retry-after"];
    const parsed = parseRetryAfterHeader(retryAfter);
    if (parsed !== undefined) return parsed;
  }

  const retryAfter = (error as { retryAfter?: unknown }).retryAfter;
  return parseRetryAfterHeader(retryAfter);
}

export function normalizeProviderError(
  provider: AgentProvider,
  error: unknown,
  signal?: AbortSignal,
): AgentGatewayError {
  if (error instanceof AgentGatewayError) return error;

  const retryAfterMs = extractRetryAfterMs(error);

  if (isAbortLike(error, signal)) {
    return new AgentGatewayError("Run aborted by user.", "aborted", provider, error, retryAfterMs);
  }

  const status = (error as { status?: number }).status;
  const name = errorName(error);
  const message = errorMessage(error);

  if (status === 401 || status === 403) {
    return new AgentGatewayError(
      `${provider} authentication failed: ${message}`,
      "authentication",
      provider,
      error,
      retryAfterMs,
    );
  }
  if (status === 429) {
    return new AgentGatewayError(
      `${provider} rate limit exceeded: ${message}`,
      "rate-limit",
      provider,
      error,
      retryAfterMs,
    );
  }
  if (status === 529) {
    return new AgentGatewayError(
      `${provider} service overloaded: ${message}`,
      "overloaded",
      provider,
      error,
      retryAfterMs,
    );
  }
  if (status === 400 && isPromptTooLongMessage(message)) {
    return new AgentGatewayError(
      `${provider} prompt too long: ${message}`,
      "prompt-too-long",
      provider,
      error,
      retryAfterMs,
    );
  }
  if (status === 408 || /timeout/i.test(name) || /timed out/i.test(message)) {
    return new AgentGatewayError(
      `${provider} request timed out: ${message}. Increase the request timeout in Settings → 工作流 if this model needs more time.`,
      "timeout",
      provider,
      error,
      retryAfterMs,
    );
  }
  if (isConnectionTerminated(error)) {
    return new AgentGatewayError(
      `${provider} connection terminated: ${message}. This often happens during long thinking with no stream output, proxy idle timeouts, or unstable networks.`,
      "provider-error",
      provider,
      error,
      retryAfterMs,
    );
  }
  if (isPromptTooLongMessage(message)) {
    return new AgentGatewayError(
      `${provider} prompt too long: ${message}`,
      "prompt-too-long",
      provider,
      error,
      retryAfterMs,
    );
  }
  return new AgentGatewayError(
    `${provider} request failed: ${message}`,
    "provider-error",
    provider,
    error,
    retryAfterMs,
  );
}

function isPromptTooLongMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("prompt is too long") ||
    normalized.includes("prompt_too_long") ||
    normalized.includes("context length") ||
    normalized.includes("context_length") ||
    normalized.includes("maximum context") ||
    normalized.includes("too many tokens") ||
    normalized.includes("token limit") ||
    normalized.includes("exceeds the maximum")
  );
}

export function isOutputTruncated(stopReason?: StopReason): boolean {
  return stopReason === "max_tokens";
}

/**
 * Classify recovery for Runtime. Only AgentGatewayError is accepted — raw
 * provider/HTTP errors must be normalized by AgentGateway first.
 */
export function classifyGatewayRecovery(error: unknown): GatewayRecoveryKind {
  if (!(error instanceof AgentGatewayError)) return "non-recoverable";

  switch (error.code) {
    case "rate-limit":
    case "overloaded":
      return "retry-backoff";
    case "prompt-too-long":
      return "compact-context";
    case "timeout":
      return errorStatus(error) === 408 ? "retry-backoff" : "non-recoverable";
    case "provider-error":
      return isDeterministicClientError(error) ? "non-recoverable" : "retry-backoff";
    default:
      return "non-recoverable";
  }
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof AgentGatewayError && error.code === "aborted") return true;
  if (errorMessage(error) === "Run aborted by user.") return true;
  return isAbortLike(error, signal);
}
