import { describe, expect, it } from "vitest";
import {
  createEmptySkillRegistry,
  registerSkillFromContent,
} from "../src/main/agent/skills/loadSkillsDir";
import { createSkillSession } from "../src/main/agent/skills/skill-types";
import { loadSkillSubAgentTool, SUB_AGENT_TOOLS } from "../src/main/agent/subagent/workspace-tools";
import { buildTeammateSystemPrompt } from "../src/main/agent/teammate/teammate-system-prompt";
import { createPptTeammateDomain } from "../src/main/plugins/ppt/teammate-domain";

const SAMPLE_SKILL = `---
name: ppt-brief
description: Draft a communication brief
when_to_use: Vague new deck topics
stages:
  - discover
---

# Brief

Write brief.md with AskUser and WriteFile.
`;

describe("teammate image-search prompt", () => {
  it("makes image search mandatory for image-dependent SVG pages", () => {
    const prompt = buildTeammateSystemPrompt({
      name: "designer",
      role: "layout designer",
      tools: SUB_AGENT_TOOLS,
      domain: createPptTeammateDomain(),
    });

    expect(prompt).toContain("include_images");
    expect(prompt).toContain("2–4 unique");
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("Embed images in page SVG");
    expect(prompt).toContain("SearchSlideImages");
    expect(prompt).not.toContain("insert-image enhancement");
  });

  it("exposes LoadSkill and skill catalog to teammates", () => {
    const registry = createEmptySkillRegistry();
    registerSkillFromContent(registry, "/tmp/brief", "ppt-brief", SAMPLE_SKILL);

    expect(SUB_AGENT_TOOLS.some((tool) => tool.name === "LoadSkill")).toBe(true);

    const prompt = buildTeammateSystemPrompt({
      name: "researcher",
      role: "researcher",
      tools: SUB_AGENT_TOOLS,
      skillCatalog: registry.listCards(),
      skillRegistry: registry,
    });

    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("`ppt-brief`");
    expect(prompt).toContain("LoadSkill");
  });

  it("LoadSkill teammate tool returns skill body and tracks session", async () => {
    const registry = createEmptySkillRegistry();
    registerSkillFromContent(registry, "/tmp/brief", "ppt-brief", SAMPLE_SKILL);
    const skillSession = createSkillSession();

    const result = await loadSkillSubAgentTool.execute(
      { skillName: "ppt-brief" },
      {
        workspaceRoot: "/tmp",
        skillRegistry: registry,
        skillSession,
        promptStage: "discover",
      },
    );

    expect(result.name).toBe("ppt-brief");
    expect(result.content).toContain("# Brief");
    expect(result.alreadyLoaded).toBe(false);
    expect(skillSession.loadedSkillNames.has("ppt-brief")).toBe(true);

    const again = await loadSkillSubAgentTool.execute(
      { skillName: "ppt-brief" },
      {
        workspaceRoot: "/tmp",
        skillRegistry: registry,
        skillSession,
        promptStage: "discover",
      },
    );
    expect(again.alreadyLoaded).toBe(true);
  });
});
