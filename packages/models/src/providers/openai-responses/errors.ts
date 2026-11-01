import OpenAI from "openai";
import { ModelProviderError, type ModelProviderErrorCode } from "../../model-errors.js";
import { ADAPTER_ID } from "./profile.js";

type Code = Exclude<ModelProviderErrorCode, "ADAPTER_UNSUPPORTED">;
const messages: Record<Code, string> = {
  CONFIGURATION: "OpenAI Responses 配置无效。",
  MODEL_CAPABILITY: "OpenAI Responses 不支持该模型或输入能力。",
  AUTHENTICATION: "OpenAI Responses 身份认证失败。",
  ACCESS_DENIED: "OpenAI Responses 拒绝访问。",
  PAYMENT_REQUIRED: "OpenAI Responses 要求处理付费或额度状态。",
  RATE_LIMIT_OR_QUOTA: "OpenAI Responses 限流或额度受限。",
  SERVICE_UNAVAILABLE: "OpenAI Responses 服务暂时不可用。",
  TIMEOUT: "OpenAI Responses 请求超时。",
  NETWORK: "OpenAI Responses 网络请求失败。",
  INCOMPLETE_STREAM: "OpenAI Responses 流未完整结算。",
  TRUNCATED: "OpenAI Responses 输出达到长度上限。",
  INVALID_RESPONSE: "OpenAI Responses 返回了无效或不支持的响应。",
  REPLAY_INCOMPATIBLE: "OpenAI Responses 历史与当前模型、连接、推理力度或内容不兼容。",
  CANCELLED: "OpenAI Responses 请求已取消。",
  CLOSED: "OpenAI Responses 提供方或模型绑定已关闭。",
};
export function error(code: Code): ModelProviderError {
  return new ModelProviderError(code, messages[code], ADAPTER_ID);
}
function known(value: unknown): ModelProviderError | undefined {
  if (
    value instanceof ModelProviderError &&
    value.adapterId === ADAPTER_ID &&
    Object.hasOwn(messages, value.code)
  )
    return error(value.code as Code);
  return undefined;
}
export function safeError(value: unknown, signal?: AbortSignal): ModelProviderError {
  if (signal?.aborted) return known(signal.reason) ?? error("CANCELLED");
  const safe = known(value);
  if (safe) return safe;
  if (value instanceof OpenAI.APIConnectionTimeoutError) return error("TIMEOUT");
  if (value instanceof OpenAI.APIConnectionError) return error("NETWORK");
  if (value instanceof OpenAI.APIError) {
    switch (value.status) {
      case 401:
        return error("AUTHENTICATION");
      case 403:
      case 421:
        return error("ACCESS_DENIED");
      case 402:
        return error("PAYMENT_REQUIRED");
      case 408:
        return error("TIMEOUT");
      case 429:
        return error("RATE_LIMIT_OR_QUOTA");
    }
    if (value.status !== undefined && value.status >= 500) return error("SERVICE_UNAVAILABLE");
  }
  return error("INVALID_RESPONSE");
}
export function invalid(): never {
  throw error("INVALID_RESPONSE");
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
export function outputBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw error("CONFIGURATION");
  return value;
}
