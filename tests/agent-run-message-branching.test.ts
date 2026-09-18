import { describe, expect, it } from "vitest";
import { prepareAgentRunMessages } from "../src/renderer/src/app/agent/agentRunPreparation";
import type { ChatMessage } from "../src/renderer/src/app/chatMessageRuntime";

const sourceMessages: ChatMessage[] = [
  { id: "user-1", role: "user", content: "first" },
  { id: "assistant-1", role: "assistant", content: "answer", runStatus: "completed" },
  { id: "user-2", role: "user", content: "second" },
];

const streamMessage: ChatMessage = {
  id: "stream-1",
  role: "assistant",
  content: "",
  runId: "run-1",
  runStatus: "running",
};

function prepare(overrides: Partial<Parameters<typeof prepareAgentRunMessages>[0]> = {}) {
  return prepareAgentRunMessages({
    sourceMessages,
    activeRequest: "new prompt",
    userDisplayContent: "new prompt",
    isSidechain: false,
    streamMessage,
    createMessageId: () => "new-user-id",
    ...overrides,
  });
}

describe("agent run message branching", () => {
  it("adds one stable running assistant turn with runId separate from threadId", () => {
    expect(prepare().runMessages.slice(-2)).toEqual([
      { id: "new-user-id", role: "user", content: "new prompt" },
      streamMessage,
    ]);
    expect(streamMessage.threadId).toBeUndefined();
  });

  it("does not invent a user bubble for hidden or sidechain turns", () => {
    expect(prepare({ userDisplayContent: null }).runMessages.at(-1)).toBe(streamMessage);
    expect(prepare({ isSidechain: true }).runMessages.at(-1)).toBe(streamMessage);
  });

  it("forks edited history while retaining the stable running turn anchor", () => {
    const result = prepare({ editedMessageId: "user-2", userDisplayContent: "edited" });

    expect(result.forkedMessages).toEqual([
      sourceMessages[0],
      sourceMessages[1],
      { id: "new-user-id", role: "user", content: "edited" },
    ]);
    expect(result.runMessages).toEqual([...result.forkedMessages!, streamMessage]);
    expect([...result.retainedMessageIds!]).toEqual(["user-1", "assistant-1", "new-user-id"]);
  });
});
