import type { ModelAdapterProfile, ModelSupport } from "../../model-profiles.js";

export const ADAPTER_ID = "openai-chat-completions" as const;
export const capabilities = Object.freeze({
  streaming: true,
  toolCalls: true,
  images: true,
  reasoning: true,
});
export const profile: ModelAdapterProfile = Object.freeze({
  adapterId: ADAPTER_ID,
  displayName: "OpenAI Chat Completions",
  protocol: ADAPTER_ID,
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

const efforts = Object.freeze(["low", "medium", "high"]);
const noEfforts = Object.freeze([] as string[]);

/** 能力描述协议可表达的内容，不承诺兼容端点上某个模型的远程可用性。 */
export function support(modelId: string): ModelSupport {
  if (!validModelId(modelId)) {
    return { supported: false, unsupportedReason: "模型标识无效。" };
  }
  return {
    supported: true,
    capabilities,
    reasoningEfforts: /^(?:o[134](?:-|$)|gpt-5(?:[.-]|$))/u.test(modelId) ? efforts : noEfforts,
  };
}
