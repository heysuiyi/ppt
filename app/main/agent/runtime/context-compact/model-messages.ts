import type { AgentModelMessage, AgentModelToolResultBlock } from "../../gateway";
import { ensureToolResultPairing } from "../../gateway";
import {
  MICRO_COMPACT_ALWAYS_PRESERVE_TOOLS,
  MICRO_COMPACT_KEEP_TOOL_RESULTS,
  MICRO_COMPACT_MIN_RESULT_CHARS,
  MICRO_COMPACT_PRESERVE_LATEST_TOOLS,
  MICRO_COMPACT_PREVIEW_HEAD_CHARS,
  MICRO_COMPACT_PREVIEW_TAIL_CHARS,
  SNIP_KEEP_HEAD,
  SNIP_KEEP_TAIL,
  SNIP_MESSAGE_THRESHOLD,
} from "./config";

type MessageGroup = AgentModelMessage[];

const alwaysPreserveTools = new Set<string>(MICRO_COMPACT_ALWAYS_PRESERVE_TOOLS);
const preserveLatestTools = new Set<string>(MICRO_COMPACT_PRESERVE_LATEST_TOOLS);

function hasToolUse(message: AgentModelMessage): boolean {
  return message.role === "assistant" && message.content.some((block) => block.type === "tool_use");
}

function hasToolResult(message: AgentModelMessage | undefined): boolean {
  return message?.role === "user" && message.content.some((block) => block.type === "tool_result");
}

/**
 * Treat one assistant tool_use turn and its immediately following user
 * tool_result turn as an indivisible compaction unit.
 */
function groupPairedMessages(source: AgentModelMessage[]): MessageGroup[] {
  const messages = ensureToolResultPairing(structuredClone(source));
  const groups: MessageGroup[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index]!;
    const next = messages[index + 1];
    if (hasToolUse(current) && hasToolResult(next)) {
      groups.push([current, next!]);
      index += 1;
    } else {
      groups.push([current]);
    }
  }
  return groups;
}

function flattenGroups(groups: MessageGroup[]): AgentModelMessage[] {
  return groups.flat();
}

function compactBoundary(text: string): AgentModelMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

export function takeRecentModelMessages(
  messages: AgentModelMessage[] | undefined,
  keepGroups: number,
): AgentModelMessage[] | undefined {
  if (!messages) return undefined;
  const groups = groupPairedMessages(messages);
  return flattenGroups(groups.slice(-Math.max(0, keepGroups)));
}

/**
 * Native ContentBlock counterpart of snip_compact. Pair groups make it
 * impossible to retain a tool_use while dropping its tool_result (or vice
 * versa).
 */
export function snipCompactModelMessages(
  messages: AgentModelMessage[] | undefined,
  threshold = SNIP_MESSAGE_THRESHOLD,
  keepHead = SNIP_KEEP_HEAD,
  keepTail = SNIP_KEEP_TAIL,
): AgentModelMessage[] | undefined {
  if (!messages || messages.length <= threshold) return messages;
  const groups = groupPairedMessages(messages);
  if (groups.length <= keepHead + keepTail) return messages;

  const head = groups.slice(0, Math.max(0, keepHead));
  const tail = groups.slice(-Math.max(0, keepTail));
  const keptCount = flattenGroups([...head, ...tail]).length;
  const dropped = Math.max(0, messages.length - keptCount);
  if (dropped === 0) return messages;

  return [
    ...flattenGroups(head),
    compactBoundary(
      `[Snipped ${dropped} earlier native conversation messages to preserve context for current work.]`,
    ),
    ...flattenGroups(tail),
  ];
}

function serializedResultLength(result: AgentModelToolResultBlock): number {
  return JSON.stringify(result.content).length;
}

function resultPreview(result: AgentModelToolResultBlock): string {
  const parts = result.content.map((block) => {
    if (block.type === "text") return block.text;
    return `[${block.mediaType} image omitted from compacted preview; ${block.data.length} base64 characters]`;
  });
  return parts.join("\n");
}

function compactResult(
  result: AgentModelToolResultBlock,
  toolName: string,
): AgentModelToolResultBlock {
  const originalChars = serializedResultLength(result);
  const preview = resultPreview(result);
  const head = preview.slice(0, MICRO_COMPACT_PREVIEW_HEAD_CHARS);
  const tailStart = Math.max(
    MICRO_COMPACT_PREVIEW_HEAD_CHARS,
    preview.length - MICRO_COMPACT_PREVIEW_TAIL_CHARS,
  );
  const tail = preview.slice(tailStart);
  const omitted = Math.max(0, preview.length - head.length - tail.length);
  return {
    ...result,
    content: [
      {
        type: "text",
        text: [
          `<compacted-tool-result tool="${toolName}" original-chars="${originalChars}">`,
          head,
          ...(omitted > 0 ? [`\n[${omitted} preview characters omitted]\n`, tail] : []),
          "</compacted-tool-result>",
        ].join("\n"),
      },
    ],
  };
}

/**
 * Compact large, older native tool_result blocks while retaining the latest
 * results and the same durable-state exceptions as legacy transcript
 * compaction.
 */
export function microCompactModelMessages(
  messages: AgentModelMessage[] | undefined,
  keepRecent = MICRO_COMPACT_KEEP_TOOL_RESULTS,
): AgentModelMessage[] | undefined {
  if (!messages) return undefined;

  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") toolNames.set(block.id, block.name);
    }
  }

  const resultLocations: Array<{
    messageIndex: number;
    blockIndex: number;
    result: AgentModelToolResultBlock;
    toolName: string;
  }> = [];
  messages.forEach((message, messageIndex) => {
    message.content.forEach((block, blockIndex) => {
      if (block.type !== "tool_result") return;
      resultLocations.push({
        messageIndex,
        blockIndex,
        result: block,
        toolName: toolNames.get(block.toolUseId) ?? "tool",
      });
    });
  });
  if (resultLocations.length <= keepRecent) return messages;

  const keep = new Set(
    resultLocations
      .slice(-Math.max(0, keepRecent))
      .map(({ messageIndex, blockIndex }) => `${messageIndex}:${blockIndex}`),
  );
  const latestPreserved = new Map<string, string>();
  for (let index = resultLocations.length - 1; index >= 0; index -= 1) {
    const location = resultLocations[index]!;
    if (!preserveLatestTools.has(location.toolName) || latestPreserved.has(location.toolName)) {
      continue;
    }
    latestPreserved.set(location.toolName, `${location.messageIndex}:${location.blockIndex}`);
  }
  for (const key of latestPreserved.values()) keep.add(key);

  return messages.map((message, messageIndex) => ({
    ...message,
    content: message.content.map((block, blockIndex) => {
      if (block.type !== "tool_result") return block;
      const key = `${messageIndex}:${blockIndex}`;
      const toolName = toolNames.get(block.toolUseId) ?? "tool";
      if (
        keep.has(key) ||
        block.isError ||
        alwaysPreserveTools.has(toolName) ||
        serializedResultLength(block) < MICRO_COMPACT_MIN_RESULT_CHARS
      ) {
        return block;
      }
      return compactResult(block, toolName);
    }),
  }));
}

export function buildModelCompactionBoundary(
  summary: string,
  savedPath?: string,
): AgentModelMessage {
  return compactBoundary(
    [
      `<compacted-conversation-context${savedPath ? ` saved-transcript="${savedPath}"` : ""}>`,
      summary,
      "</compacted-conversation-context>",
    ].join("\n"),
  );
}

/** Last-resort native-message trim used after provider prompt-too-long. */
export function emergencyTrimModelMessages(
  messages: AgentModelMessage[] | undefined,
): AgentModelMessage[] | undefined {
  if (!messages || messages.length === 0) return messages;
  const compacted = microCompactModelMessages(messages, 1);
  const recent = takeRecentModelMessages(compacted, 3) ?? [];
  if (recent.length >= messages.length) return compacted;
  return [
    compactBoundary(
      `[Emergency-trimmed ${messages.length - recent.length} earlier native conversation messages after provider context overflow.]`,
    ),
    ...recent,
  ];
}
