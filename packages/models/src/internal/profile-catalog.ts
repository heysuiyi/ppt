import type { ModelAdapterProfile, ModelSupport } from "../model-profiles.js";
import {
  profile as anthropicProfile,
  support as anthropicSupport,
} from "../providers/anthropic-messages/profile.js";
import { mimoProfile, mimoSupport } from "../providers/mimo-token-plan-cn/profile.js";
import {
  profile as chatProfile,
  support as chatSupport,
} from "../providers/openai-chat-completions/profile.js";
import {
  profile as responsesProfile,
  support as responsesSupport,
} from "../providers/openai-responses/profile.js";

export function getModelProfile(adapterId: string): ModelAdapterProfile | undefined {
  switch (adapterId) {
    case "mimo-token-plan-cn":
      return mimoProfile;
    case "openai-chat-completions":
      return chatProfile;
    case "openai-responses":
      return responsesProfile;
    case "anthropic-messages":
      return anthropicProfile;
    default:
      return undefined;
  }
}

export function getModelSupport(adapterId: string, modelId: string): ModelSupport | undefined {
  switch (adapterId) {
    case "mimo-token-plan-cn":
      return mimoSupport(modelId);
    case "openai-chat-completions":
      return chatSupport(modelId);
    case "openai-responses":
      return responsesSupport(modelId);
    case "anthropic-messages":
      return anthropicSupport(modelId);
    default:
      return undefined;
  }
}
