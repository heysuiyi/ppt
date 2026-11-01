import type { ModelAdapterProfile, ModelSupport } from "../../model-profiles.js";

export const MIMO_TOKEN_PLAN_CN_PROVIDER_ID = "mimo-token-plan-cn" as const;
export const MIMO_TOKEN_PLAN_CN_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
export const MIMO_TOKEN_PLAN_CN_MAX_OUTPUT_TOKENS = 131_072;

const supportedModels: Readonly<Record<string, true>> = {
  "mimo-v2.6-flash": true,
  "mimo-v2.6-pro": true,
  "mimo-v2.6-pro-ultraspeed": true,
};

export const mimoProfile: ModelAdapterProfile = Object.freeze({
  adapterId: MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
  displayName: "MiMo Token Plan CN",
  protocol: "openai-responses",
  endpoint: Object.freeze({ kind: "fixed", url: MIMO_TOKEN_PLAN_CN_BASE_URL }),
  maxOutputTokens: MIMO_TOKEN_PLAN_CN_MAX_OUTPUT_TOKENS,
});

export const MIMO_REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const);

export const mimoCapabilities = Object.freeze({
  streaming: true,
  toolCalls: true,
  images: false,
  reasoning: true,
});

const supported: ModelSupport = Object.freeze({
  supported: true,
  capabilities: mimoCapabilities,
  reasoningEfforts: MIMO_REASONING_EFFORTS,
  maxOutputTokens: MIMO_TOKEN_PLAN_CN_MAX_OUTPUT_TOKENS,
});
const unsupported: ModelSupport = Object.freeze({
  supported: false,
  unsupportedReason: "尚无该模型的 Responses 对话能力信息。",
});

/** Local adapter support is not evidence of remote availability or account access. */
export function mimoSupport(modelId: string): ModelSupport {
  return Object.hasOwn(supportedModels, modelId) ? supported : unsupported;
}
