import type {
  AgentModelContentBlock,
  AgentModelThinkingBlock,
  AgentModelToolResultBlock,
  AgentModelToolUseBlock,
} from "./types";

export function textFromContentBlocks(blocks: AgentModelContentBlock[] | undefined): string {
  return (blocks ?? [])
    .filter(
      (block): block is Extract<AgentModelContentBlock, { type: "text" }> => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function toolUseBlocksFromContent(
  blocks: AgentModelContentBlock[] | undefined,
): AgentModelToolUseBlock[] {
  return (blocks ?? []).filter(
    (block): block is Extract<AgentModelContentBlock, { type: "tool_use" }> =>
      block.type === "tool_use",
  );
}

export function thinkingFromContentBlocks(
  blocks: AgentModelContentBlock[] | undefined,
): AgentModelThinkingBlock[] {
  return (blocks ?? []).filter(
    (block): block is AgentModelThinkingBlock =>
      block.type === "thinking" || block.type === "redacted_thinking",
  );
}

export function toolResultBlocksFromContent(
  blocks: AgentModelContentBlock[] | undefined,
): AgentModelToolResultBlock[] {
  return (blocks ?? []).filter(
    (block): block is AgentModelToolResultBlock => block.type === "tool_result",
  );
}

export function textBlock(text: string): AgentModelContentBlock {
  return { type: "text", text };
}
