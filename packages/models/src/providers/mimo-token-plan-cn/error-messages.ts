import { ModelProviderError, type ModelProviderErrorCode } from "../../model-errors.js";
import { MIMO_TOKEN_PLAN_CN_MAX_OUTPUT_TOKENS, MIMO_TOKEN_PLAN_CN_PROVIDER_ID } from "./profile.js";

export type MimoErrorCode = Exclude<ModelProviderErrorCode, "ADAPTER_UNSUPPORTED">;

const messages: Record<MimoErrorCode, string> = {
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

export function mimoError(code: MimoErrorCode): ModelProviderError {
  return new ModelProviderError(code, messages[code], MIMO_TOKEN_PLAN_CN_PROVIDER_ID);
}

export function knownMimoError(error: unknown): ModelProviderError | undefined {
  if (
    error instanceof ModelProviderError &&
    error.adapterId === MIMO_TOKEN_PLAN_CN_PROVIDER_ID &&
    Object.hasOwn(messages, error.code)
  ) {
    // Never trust an arbitrary instance's message as already sanitized.
    return mimoError(error.code as MimoErrorCode);
  }
  return undefined;
}

export function outputBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MIMO_TOKEN_PLAN_CN_MAX_OUTPUT_TOKENS) {
    throw mimoError("CONFIGURATION");
  }
  return value;
}
