const DEFAULT_KEEP_RECENT = 6;
const MAX_ENTRY_CHARS = 1_500;

function truncateValue(value: unknown, maxChars = MAX_ENTRY_CHARS): unknown {
  if (typeof value === "string") {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
  }
  if (Array.isArray(value)) {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxChars) return value;
    return `${serialized.slice(0, maxChars)}…`;
  }
  if (value && typeof value === "object") {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxChars) return value;
    return `${serialized.slice(0, maxChars)}…`;
  }
  return value;
}

function compactEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = { role: entry.role };
  if (entry.toolName) compact.toolName = entry.toolName;
  if (entry.error) {
    compact.error = truncateValue(entry.error, 400);
    return compact;
  }
  if (entry.content !== undefined) {
    compact.content = truncateValue(entry.content);
    return compact;
  }
  if (entry.result !== undefined) {
    compact.result = truncateValue(entry.result);
    return compact;
  }
  if (entry.raw !== undefined) {
    compact.raw = truncateValue(entry.raw);
    return compact;
  }
  if (entry.response !== undefined) {
    compact.response = truncateValue(entry.response);
    return compact;
  }
  return truncateValue(entry) as Record<string, unknown>;
}

/**
 * Reactive compaction for prompt-too-long recovery.
 * Keeps the most recent transcript entries and summarizes dropped history.
 */
export function compactTranscript(
  transcript: Array<Record<string, unknown>>,
  keepRecent = DEFAULT_KEEP_RECENT,
): Array<Record<string, unknown>> {
  if (transcript.length <= keepRecent) {
    return transcript.map((entry) => compactEntry(entry));
  }

  const dropped = transcript.length - keepRecent;
  const recent = transcript.slice(-keepRecent).map((entry) => compactEntry(entry));
  return [
    {
      role: "system",
      kind: "compact_boundary",
      content: `Earlier ${dropped} transcript entries were compacted to fit the model context window.`,
    },
    ...recent,
  ];
}

export function compactConversation(
  conversation: Array<{ role: "user" | "assistant"; content: string }> | undefined,
  keepRecent = 4,
): Array<{ role: "user" | "assistant"; content: string }> | undefined {
  if (!conversation || conversation.length <= keepRecent) return conversation;
  const dropped = conversation.length - keepRecent;
  const recent = conversation.slice(-keepRecent).map((message) => ({
    role: message.role,
    content:
      message.content.length > MAX_ENTRY_CHARS
        ? `${message.content.slice(0, MAX_ENTRY_CHARS)}…`
        : message.content,
  }));
  return [
    {
      role: "assistant",
      content: `[Compacted ${dropped} earlier conversation messages to fit context.]`,
    },
    ...recent,
  ];
}
