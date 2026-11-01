import { toolResultBlocksFromContent, toolUseBlocksFromContent } from "./content-blocks";
import type {
  AgentModelContentBlock,
  AgentModelMessage,
  AgentModelToolResultBlock,
  AgentModelToolUseBlock,
} from "./types";

const MISSING_RESULT_PREFIX = "Tool execution did not produce a result";

function dedupeToolUses(content: AgentModelContentBlock[]): AgentModelContentBlock[] {
  const seen = new Set<string>();
  return content.filter((block) => {
    if (block.type !== "tool_use") return block.type !== "tool_result";
    if (!block.id || seen.has(block.id)) return false;
    seen.add(block.id);
    return true;
  });
}
function pairResults(
  calls: AgentModelToolUseBlock[],
  results: AgentModelToolResultBlock[],
): AgentModelToolResultBlock[] {
  const expected = new Set(calls.map((call) => call.id));
  const byCallId = new Map<string, AgentModelToolResultBlock>();

  for (const result of results) {
    if (!expected.has(result.toolUseId) || byCallId.has(result.toolUseId)) continue;
    byCallId.set(result.toolUseId, result);
  }

  return calls.map(
    (call) =>
      byCallId.get(call.id) ?? {
        type: "tool_result",
        toolUseId: call.id,
        content: [{ type: "text", text: `${MISSING_RESULT_PREFIX} for ${call.name}.` }],
        isError: true,
      },
  );
}

/**
 * Repair ContentBlock history immediately before a provider request.
 * Every assistant tool_use receives exactly one result in the next user turn.
 */
export function ensureToolResultPairing(messages: AgentModelMessage[]): AgentModelMessage[] {
  const repaired: AgentModelMessage[] = [];
  let pendingCalls: AgentModelToolUseBlock[] = [];

  const flushMissingResults = (): void => {
    if (pendingCalls.length === 0) return;
    repaired.push({
      role: "user",
      content: pairResults(pendingCalls, []),
    });
    pendingCalls = [];
  };

  for (const source of messages) {
    if (source.role === "assistant") {
      flushMissingResults();
      const content = dedupeToolUses(source.content);
      if (content.length > 0) repaired.push({ role: "assistant", content });
      pendingCalls = toolUseBlocksFromContent(content);
      continue;
    }

    const nonResults = source.content.filter((block) => block.type !== "tool_result");
    const content =
      pendingCalls.length > 0
        ? [...pairResults(pendingCalls, toolResultBlocksFromContent(source.content)), ...nonResults]
        : nonResults;
    pendingCalls = [];
    if (content.length > 0) repaired.push({ role: "user", content });
  }

  flushMissingResults();
  return repaired;
}

/**
 * Add request-scoped prompt data after canonical history without mutating that
 * history. Provider adapters use this for query/user/system context that must
 * reach the model but must never become a durable conversation message.
 */
export function withEphemeralPrompt(
  messages: AgentModelMessage[],
  prompt: string,
): AgentModelMessage[] {
  const paired = ensureToolResultPairing(messages);
  if (!prompt.trim()) return paired;
  return [
    ...paired,
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  ];
}
