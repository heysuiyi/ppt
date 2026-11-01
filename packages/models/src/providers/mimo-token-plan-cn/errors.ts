import OpenAI from "openai";
import type { ModelProviderError } from "../../model-errors.js";
import { knownMimoError, mimoError } from "./error-messages.js";

export { mimoError, outputBudget } from "./error-messages.js";

export function modelError(error: unknown, signal?: AbortSignal): ModelProviderError {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    const safeReason = knownMimoError(reason);
    if (safeReason) return safeReason;
    return mimoError("CANCELLED");
  }
  const safe = knownMimoError(error);
  if (safe) return safe;
  if (error instanceof OpenAI.APIConnectionTimeoutError) return mimoError("TIMEOUT");
  if (error instanceof OpenAI.APIConnectionError) return mimoError("NETWORK");
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    if (status === 401) return mimoError("AUTHENTICATION");
    if (status === 403 || status === 421) return mimoError("ACCESS_DENIED");
    if (status === 402) return mimoError("PAYMENT_REQUIRED");
    if (status === 408) return mimoError("TIMEOUT");
    if (status === 429) return mimoError("RATE_LIMIT_OR_QUOTA");
    if (status !== undefined && status >= 500) return mimoError("SERVICE_UNAVAILABLE");
    return mimoError("INVALID_RESPONSE");
  }
  return mimoError("INVALID_RESPONSE");
}

export function invalid(): never {
  throw mimoError("INVALID_RESPONSE");
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

export function text(value: unknown): string {
  if (typeof value !== "string") return invalid();
  return value;
}

export function nonempty(value: unknown): string {
  const result = text(value);
  if (!result.trim()) return invalid();
  return result;
}
