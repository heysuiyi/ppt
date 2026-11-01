import type { ModelAdapterProfile, ModelSupport } from "../../model-profiles.js";

export const adapterId = "anthropic-messages" as const;
export const capabilities = Object.freeze({
  streaming: true,
  toolCalls: true,
  images: true,
  reasoning: true,
});

export const profile: ModelAdapterProfile = Object.freeze({
  adapterId,
  displayName: "Anthropic Messages",
  protocol: "anthropic-messages",
  endpoint: Object.freeze({ kind: "configurable", defaultURL: "https://api.anthropic.com" }),
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
  // Thinking summaries/replay are supported; model-dependent thinking configuration is not.
  reasoningEfforts: Object.freeze([]),
});
const unsupported: ModelSupport = Object.freeze({
  supported: false,
  unsupportedReason: "Messages requires a nonempty model identifier without whitespace.",
});

/** Protocol support does not assert model availability or account permissions. */
export function support(modelId: string): ModelSupport {
  return validModelId(modelId) ? supported : unsupported;
}
