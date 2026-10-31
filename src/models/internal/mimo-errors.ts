import OpenAI from "openai";

export type MimoModelErrorCode =
  | "CONFIGURATION"
  | "MODEL_CAPABILITY"
  | "AUTHENTICATION"
  | "ACCESS_DENIED"
  | "PAYMENT_REQUIRED"
  | "RATE_LIMIT_OR_QUOTA"
  | "SERVICE_UNAVAILABLE"
  | "TIMEOUT"
  | "NETWORK"
  | "INCOMPLETE_STREAM"
  | "TRUNCATED"
  | "INVALID_RESPONSE"
  | "REPLAY_INCOMPATIBLE"
  | "CANCELLED"
  | "CLOSED";

const messages: Record<MimoModelErrorCode, string> = {
  CONFIGURATION: "MiMo 配置无效。",
  MODEL_CAPABILITY: "该模型或输入能力尚未受 MiMo 适配器支持。",
  AUTHENTICATION: "MiMo 身份认证失败。",
  ACCESS_DENIED: "MiMo 拒绝访问当前资源。",
  PAYMENT_REQUIRED: "MiMo 服务要求处理付费或额度状态。",
  RATE_LIMIT_OR_QUOTA: "MiMo 限流或额度受限。",
  SERVICE_UNAVAILABLE: "MiMo 服务暂时不可用。",
  TIMEOUT: "MiMo 请求超时。",
  NETWORK: "MiMo 网络请求失败。",
  INCOMPLETE_STREAM: "MiMo 流未完整结算。",
  TRUNCATED: "MiMo 输出达到长度上限。",
  INVALID_RESPONSE: "MiMo 返回了无效或不支持的响应。",
  REPLAY_INCOMPATIBLE: "MiMo 历史重放与当前模型、连接或内容不兼容。",
  CANCELLED: "MiMo 请求已取消。",
  CLOSED: "MiMo 提供方或模型绑定已关闭。",
};

/** 不保留 SDK 异常、响应正文、请求头或 cause。 */
export class MimoModelError extends Error {
  constructor(readonly code: MimoModelErrorCode) {
    super(messages[code]);
    this.name = "MimoModelError";
  }
}

export function modelError(error: unknown, signal?: AbortSignal): MimoModelError {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    if (reason instanceof MimoModelError) return reason;
    return new MimoModelError("CANCELLED");
  }
  if (error instanceof MimoModelError) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new MimoModelError("TIMEOUT");
  if (error instanceof OpenAI.APIConnectionError) return new MimoModelError("NETWORK");
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    if (status === 401) return new MimoModelError("AUTHENTICATION");
    if (status === 403 || status === 421) return new MimoModelError("ACCESS_DENIED");
    if (status === 402) return new MimoModelError("PAYMENT_REQUIRED");
    if (status === 408) return new MimoModelError("TIMEOUT");
    if (status === 429) return new MimoModelError("RATE_LIMIT_OR_QUOTA");
    if (status !== undefined && status >= 500) return new MimoModelError("SERVICE_UNAVAILABLE");
    return new MimoModelError("INVALID_RESPONSE");
  }
  return new MimoModelError("INVALID_RESPONSE");
}

export function invalid(): never {
  throw new MimoModelError("INVALID_RESPONSE");
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
  if (!Number.isSafeInteger(value) || value < 1 || value > 131072) {
    throw new MimoModelError("CONFIGURATION");
  }
  return value;
}
