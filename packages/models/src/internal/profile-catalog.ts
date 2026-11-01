import type { ModelAdapterProfile, ModelSupport } from "../model-profiles.js";
import { mimoProfile, mimoSupport } from "../providers/mimo-token-plan-cn/profile.js";

export function getModelProfile(adapterId: string): ModelAdapterProfile | undefined {
  switch (adapterId) {
    case "mimo-token-plan-cn":
      return mimoProfile;
    default:
      return undefined;
  }
}

export function getModelSupport(adapterId: string, modelId: string): ModelSupport | undefined {
  switch (adapterId) {
    case "mimo-token-plan-cn":
      return mimoSupport(modelId);
    default:
      return undefined;
  }
}
