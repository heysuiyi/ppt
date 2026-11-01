import { SNIP_KEEP_HEAD, SNIP_KEEP_TAIL, SNIP_MESSAGE_THRESHOLD } from "./config";
import type { ConversationMessage, TranscriptEntry } from "./types";

function isToolUseEntry(entry: TranscriptEntry): boolean {
  return entry.kind === "tool_use";
}

function isToolResultEntry(entry: TranscriptEntry): boolean {
  if (entry.kind === "tool_result") return true;
  if (entry.role === "tool") return true;
  if (entry.role === "user" && entry.kind === "tool_result") return true;
  return false;
}

/**
 * Adjust tail start so we never split assistant(tool_use) from user(tool_result).
 */
export function adjustSnipBoundary<T extends TranscriptEntry | ConversationMessage>(
  messages: T[],
  tailStart: number,
  keepHead: number,
): number {
  let start = tailStart;

  while (start > keepHead && isToolResultEntry(messages[start] as TranscriptEntry)) {
    start -= 1;
    if (start >= 0 && isToolUseEntry(messages[start] as TranscriptEntry)) {
      break;
    }
  }

  if (start > keepHead && start > 0 && isToolUseEntry(messages[start - 1] as TranscriptEntry)) {
    start -= 1;
  }

  return Math.max(start, keepHead);
}

function buildSnipBoundaryMarker(dropped: number): TranscriptEntry {
  return {
    role: "system",
    kind: "compact_boundary",
    content: `Snipped ${dropped} earlier messages to preserve context for current work.`,
  };
}

function buildConversationBoundary(dropped: number): ConversationMessage {
  return {
    role: "assistant",
    content: `[Snipped ${dropped} earlier conversation messages to preserve context for current work.]`,
  };
}

/**
 * L1: snip_compact — drop middle history, keep head + tail.
 */
export function snipCompactConversation(
  conversation: ConversationMessage[] | undefined,
  threshold = SNIP_MESSAGE_THRESHOLD,
  keepHead = SNIP_KEEP_HEAD,
  keepTail = SNIP_KEEP_TAIL,
): ConversationMessage[] | undefined {
  if (!conversation || conversation.length <= threshold) return conversation;

  const tailStart = adjustSnipBoundary(conversation, conversation.length - keepTail, keepHead);
  const dropped = tailStart - keepHead;
  if (dropped <= 0) return conversation;

  return [
    ...conversation.slice(0, keepHead),
    buildConversationBoundary(dropped),
    ...conversation.slice(tailStart),
  ];
}

export function snipCompactTranscript(
  transcript: TranscriptEntry[],
  threshold = SNIP_MESSAGE_THRESHOLD,
  keepHead = SNIP_KEEP_HEAD,
  keepTail = SNIP_KEEP_TAIL,
): TranscriptEntry[] {
  if (transcript.length <= threshold) return transcript;

  const tailStart = adjustSnipBoundary(transcript, transcript.length - keepTail, keepHead);
  const dropped = tailStart - keepHead;
  if (dropped <= 0) return transcript;

  return [
    ...transcript.slice(0, keepHead),
    buildSnipBoundaryMarker(dropped),
    ...transcript.slice(tailStart),
  ];
}
