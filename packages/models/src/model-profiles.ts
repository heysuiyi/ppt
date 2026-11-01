import type { ModelCapabilities } from "@agent-harness/core/model/model-contract";
import type { ModelAdapterId } from "./model-contract.js";

export type ModelEndpointPolicy =
  | { readonly kind: "fixed"; readonly url: string }
  | { readonly kind: "configurable"; readonly defaultURL?: string };

export interface ModelAdapterProfile {
  readonly adapterId: ModelAdapterId;
  readonly displayName: string;
  readonly protocol: string;
  readonly endpoint?: ModelEndpointPolicy;
  readonly maxOutputTokens?: number;
}

export type ModelSupport =
  | { readonly supported: false; readonly unsupportedReason: string }
  | {
      readonly supported: true;
      readonly capabilities: ModelCapabilities;
      readonly reasoningEfforts: readonly string[];
      readonly maxOutputTokens?: number;
    };

export { getModelProfile, getModelSupport } from "./internal/profile-catalog.js";
