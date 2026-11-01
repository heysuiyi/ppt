import type { ModelPromptPayload } from "../turns/model-call-recovery";
import { compactConversation, compactTranscript } from "../turns/transcript-compact";
import { microCompactTranscript } from "./micro-compact";
import { snipCompactConversation, snipCompactTranscript } from "./snip-compact";

export { emergencyTrimModelMessages } from "./model-messages";

const EMERGENCY_KEEP_RECENT = 3;
const EMERGENCY_CONVERSATION_KEEP = 2;

/**
 * Last-resort trim when the API still rejects with prompt_too_long.
 * Runs snip + micro + legacy reactive compaction aggressively.
 */
export function emergencyTrimContext(payload: ModelPromptPayload): ModelPromptPayload {
  let transcript = snipCompactTranscript(payload.transcript, 6, 1, EMERGENCY_KEEP_RECENT);
  transcript = microCompactTranscript(transcript, 1);
  transcript = compactTranscript(transcript, EMERGENCY_KEEP_RECENT);

  return {
    ...payload,
    conversation: compactConversation(
      snipCompactConversation(payload.conversation, 6, 1, EMERGENCY_CONVERSATION_KEEP),
      EMERGENCY_CONVERSATION_KEEP,
    ),
    transcript,
  };
}
