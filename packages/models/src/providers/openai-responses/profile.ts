import type { ModelAdapterProfile, ModelSupport } from "../../model-profiles.js";

export const ADAPTER_ID = "openai-responses" as const;
export const REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const);
export const capabilities = Object.freeze({
  streaming: true,
  toolCalls: true,
  images: true,
  reasoning: true,
});
export const profile: ModelAdapterProfile = Object.freeze({
  adapterId: ADAPTER_ID,
  displayName: "OpenAI Responses",
  protocol: "openai-responses",
  endpoint: Object.freeze({ kind: "configurable", defaultURL: "https://api.openai.com/v1" }),
});
export function validModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\s\x00-\x1f\x7f]/u.test(value)
  );
}
const supported: ModelSupport = Object.freeze({
  supported: true,
  capabilities,
  reasoningEfforts: REASONING_EFFORTS,
});
/** 协议能力不代表任意兼容端点上的远程模型均提供这些能力。 */
export function support(modelId: string): ModelSupport {
  return validModelId(modelId)
    ? supported
    : {
        supported: false,
        unsupportedReason: "模型标识无效。",
      };
}
