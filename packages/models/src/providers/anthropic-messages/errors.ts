import Anthropic from "@anthropic-ai/sdk";
import { ModelProviderError, type ModelProviderErrorCode } from "../../model-errors.js";
import { adapterId } from "./profile.js";

const messages: Record<ModelProviderErrorCode, string> = {
  ADAPTER_UNSUPPORTED: "The requested model adapter is unavailable.",
  CONFIGURATION: "The Anthropic Messages configuration or request is invalid.",
  MODEL_CAPABILITY: "The requested capability is not supported by Anthropic Messages.",
  AUTHENTICATION: "Anthropic Messages authentication failed.",
  ACCESS_DENIED: "Anthropic Messages access was denied.",
  PAYMENT_REQUIRED: "Anthropic Messages requires payment.",
  RATE_LIMIT_OR_QUOTA: "Anthropic Messages rate limit or quota was exceeded.",
  SERVICE_UNAVAILABLE: "Anthropic Messages is temporarily unavailable.",
  TIMEOUT: "The Anthropic Messages operation timed out.",
  NETWORK: "The Anthropic Messages connection failed.",
  INCOMPLETE_STREAM: "The Anthropic Messages stream ended before authoritative completion.",
  TRUNCATED: "Anthropic Messages output was truncated and cannot be committed.",
  INVALID_RESPONSE: "Anthropic Messages returned an invalid response.",
  REPLAY_INCOMPATIBLE: "The saved Anthropic Messages state cannot be replayed on this connection.",
  CANCELLED: "The Anthropic Messages operation was cancelled.",
  CLOSED: "The Anthropic Messages provider or binding is closed.",
};
const issued = new WeakSet<ModelProviderError>();
export function failure(code: ModelProviderErrorCode): ModelProviderError {
  const result = new ModelProviderError(code, messages[code], adapterId);
  issued.add(result);
  return result;
}
export function safeError(error: unknown, signal?: AbortSignal): ModelProviderError {
  if (signal?.aborted) {
    return signal.reason instanceof ModelProviderError && issued.has(signal.reason)
      ? signal.reason
      : failure("CANCELLED");
  }
  if (error instanceof ModelProviderError && issued.has(error)) return error;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return failure("TIMEOUT");
  if (error instanceof Anthropic.APIConnectionError) return failure("NETWORK");
  if (error instanceof Anthropic.APIError) {
    if (error.status === 401) return failure("AUTHENTICATION");
    if (error.status === 403) return failure("ACCESS_DENIED");
    if (error.status === 402) return failure("PAYMENT_REQUIRED");
    if (error.status === 408 || error.status === 504) return failure("TIMEOUT");
    if (error.status === 429) return failure("RATE_LIMIT_OR_QUOTA");
    if (error.status !== undefined && error.status >= 500) return failure("SERVICE_UNAVAILABLE");
  }
  return failure("INVALID_RESPONSE");
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failure("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
export function text(value: unknown, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && !value.trim())) throw failure("INVALID_RESPONSE");
  return value;
}
export function budget(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw failure("CONFIGURATION");
  return value;
}
