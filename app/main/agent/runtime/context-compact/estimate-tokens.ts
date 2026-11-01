import type { AgentModelMessage } from "../../gateway";
import type { ModelPromptPayload } from "../turns/model-call-recovery";
import { CHARS_PER_TOKEN_ESTIMATE } from "./config";

/**
 * Cheap token estimate from serialized prompt size (no API / tokenizer).
 */
export function estimatePromptTokens(
  systemPrompt: string,
  payload: ModelPromptPayload,
  messages?: AgentModelMessage[],
): number {
  const serialized = systemPrompt + JSON.stringify(payload) + JSON.stringify(messages ?? []);
  return Math.ceil(serialized.length / CHARS_PER_TOKEN_ESTIMATE);
}
