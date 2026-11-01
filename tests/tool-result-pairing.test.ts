import { describe, expect, it } from "vitest";
import { ensureToolResultPairing } from "../app/main/agent/gateway/message-pairing";
import type { AgentModelMessage } from "../app/main/agent/gateway/types";

describe("ensureToolResultPairing", () => {
  it("adds one synthetic error result for every missing tool result", () => {
    const messages: AgentModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call-1", name: "Read", input: {} },
          { type: "tool_use", id: "call-2", name: "List", input: {} },
        ],
      },
    ];

    const repaired = ensureToolResultPairing(messages);
    expect(repaired).toHaveLength(2);
    expect(repaired[1]?.content).toEqual([
      expect.objectContaining({ type: "tool_result", toolUseId: "call-1", isError: true }),
      expect.objectContaining({ type: "tool_result", toolUseId: "call-2", isError: true }),
    ]);
  });

  it("removes orphan and duplicate results while preserving call order", () => {
    const messages: AgentModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call-1", name: "Read", input: {} },
          { type: "tool_use", id: "call-2", name: "List", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "call-2", content: [{ type: "text", text: "second" }] },
          {
            type: "tool_result",
            toolUseId: "call-2",
            content: [{ type: "text", text: "duplicate" }],
          },
          { type: "tool_result", toolUseId: "orphan", content: [{ type: "text", text: "orphan" }] },
          { type: "tool_result", toolUseId: "call-1", content: [{ type: "text", text: "first" }] },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "keep this user message" },
          {
            type: "tool_result",
            toolUseId: "orphan-2",
            content: [{ type: "text", text: "remove" }],
          },
        ],
      },
    ];

    const repaired = ensureToolResultPairing(messages);
    expect(repaired[1]?.content).toEqual([
      { type: "tool_result", toolUseId: "call-1", content: [{ type: "text", text: "first" }] },
      { type: "tool_result", toolUseId: "call-2", content: [{ type: "text", text: "second" }] },
    ]);
    expect(repaired[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "keep this user message" }],
    });
  });

  it("does not mutate the caller's message array", () => {
    const messages: AgentModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "orphan",
            content: [{ type: "text", text: "remove" }],
          },
        ],
      },
    ];

    ensureToolResultPairing(messages);
    expect(messages[0]?.content).toHaveLength(1);
  });
});
