import OpenAI from "openai";
import { ModelProviderError, type ModelProviderErrorCode } from "../../model-errors.js";
import { ADAPTER_ID } from "./profile.js";

const messages: Record<ModelProviderErrorCode, string> = {
  ADAPTER_UNSUPPORTED: "模型适配器不受支持。",
  CONFIGURATION: "模型连接或选择配置无效。",
  MODEL_CAPABILITY: "该模型协议不支持请求的能力。",
  AUTHENTICATION: "模型服务身份验证失败。",
  ACCESS_DENIED: "模型服务拒绝访问。",
  PAYMENT_REQUIRED: "模型服务要求支付费用。",
  RATE_LIMIT_OR_QUOTA: "模型服务限流或配额不足。",
  SERVICE_UNAVAILABLE: "模型服务暂不可用。",
  TIMEOUT: "模型请求超时。",
  NETWORK: "模型服务网络连接失败。",
  INCOMPLETE_STREAM: "模型流缺少完整的终止响应。",
  TRUNCATED: "模型输出达到长度限制，不能提交工具调用。",
  INVALID_RESPONSE: "模型服务返回了无效响应。",
  REPLAY_INCOMPATIBLE: "助手重放状态与当前模型连接或消息不兼容。",
  CANCELLED: "模型请求已取消。",
  CLOSED: "模型连接已关闭。",
};
const issued = new WeakSet<ModelProviderError>();
export function chatError(code: ModelProviderErrorCode): ModelProviderError {
  const error = new ModelProviderError(code, messages[code], ADAPTER_ID);
  issued.add(error);
  return error;
}
export function modelError(error: unknown, signal?: AbortSignal): ModelProviderError {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    return reason instanceof ModelProviderError && issued.has(reason)
      ? reason
      : chatError("CANCELLED");
  }
  if (error instanceof ModelProviderError && issued.has(error)) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError) return chatError("TIMEOUT");
  if (error instanceof OpenAI.APIConnectionError) return chatError("NETWORK");
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    if (status === 401) return chatError("AUTHENTICATION");
    if (status === 403 || status === 421) return chatError("ACCESS_DENIED");
    if (status === 402) return chatError("PAYMENT_REQUIRED");
    if (status === 408) return chatError("TIMEOUT");
    if (status === 429) return chatError("RATE_LIMIT_OR_QUOTA");
    if (status !== undefined && status >= 500) return chatError("SERVICE_UNAVAILABLE");
  }
  return chatError("INVALID_RESPONSE");
}
export function invalid(): never {
  throw chatError("INVALID_RESPONSE");
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
export function outputBudget(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw chatError("CONFIGURATION");
  return value as number;
}
