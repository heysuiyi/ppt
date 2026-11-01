import { describe, expect, it } from "vitest";
import { SUB_AGENT_TOOLS } from "../app/main/agent/subagent/workspace-tools";
import { buildTeammateSystemPrompt } from "../app/main/agent/teammate/teammate-system-prompt";

describe("teammate system prompt", () => {
  it("directs file operations to workspace tools before bash", () => {
    const prompt = buildTeammateSystemPrompt({
      name: "worker",
      role: "workspace teammate",
      tools: SUB_AGENT_TOOLS,
    });

    expect(prompt).toContain("WriteFile creates parent directories automatically");
    expect(prompt).toContain(
      "Never use bash for mkdir/cat/echo redirection/copy/move style file operations",
    );
    expect(prompt.indexOf("- WriteFile")).toBeLessThan(prompt.indexOf("- bash"));
  });
});
