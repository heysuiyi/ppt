import { describe, expect, it } from "vitest";
import { askUserTool } from "../src/main/agent/tools/core/ask-user";
import { loadSkillTool } from "../src/main/agent/tools/core/load-skill";
import { readFileTool, writeFileTool } from "../src/main/agent/tools/core/workspace-files";
import {
  buildIdentitySection,
  buildToolsSection,
} from "../src/main/plugins/ppt/prompts/prompt-sections";
import { buildContentBlockResponseGuidance } from "../src/main/plugins/ppt/prompts/response-guidance";
import { previewSvgPageTool } from "../src/main/plugins/ppt/tools/preview-svg-page";
import {
  formatSvgDeckLockBootstrapGuidance,
  formatSvgDeckLockContractBlock,
} from "../src/main/plugins/ppt/tools/svg-deck-locks";

/**
 * Soft create-path habits that inflate turnCount (not hard runtime gates):
 * one LoadSkill per turn, write-one-page-preview-one-page, empty transition filler.
 * These assertions lock denser batches plus milestone intent (not empty旁白).
 */
describe("prompt turn-density guidance", () => {
  it("identity asks for denser independent tool batches", () => {
    const identity = buildIdentitySection();
    expect(identity).toContain("降低模型往返");
    expect(identity).toContain("同一 assistant 响应");
    expect(identity).toContain("不要为了“看起来一步一步”而把独立工作拆成多轮");
  });

  it("tool selection requires milestone intent and bans empty transition filler", () => {
    const section = buildToolsSection({
      stage: "author",
      enabledTools: [askUserTool, loadSkillTool, readFileTool, writeFileTool, previewSvgPageTool],
    });
    expect(section).toContain("多个 LoadSkill");
    expect(section).toContain("分批写剩余 SVG");
    expect(section).not.toContain("parameterSummary");
    expect(section).toContain('"approvalRequired"');
    expect(section).toContain("同批多个 PreviewSvgPage");
    expect(section).toContain("阶段切换");
    expect(section).toContain("可见 Markdown 意图");
    expect(section).toContain("不要把意图只写在思考通道里");
    expect(section).toContain("继续推进");
    expect(section).toContain("不要为旁白把可同批的独立工具拆成多轮");
    expect(section).toContain("开场目标、用户决策与收尾交付");
  });

  it("omits create-path tool names from batch examples when those tools are absent", () => {
    const section = buildToolsSection({
      stage: "discover",
      enabledTools: [askUserTool],
    });
    expect(section).not.toContain("ReadFile");
    expect(section).not.toContain("WriteFile");
    expect(section).not.toContain("PreviewSvgPage");
    expect(section).toContain("阶段切换");
    expect(section).toContain("继续推进");
  });

  it("response protocol requires milestone intent before tools without step-by-step tool narration", () => {
    const protocol = buildContentBlockResponseGuidance();
    expect(protocol).toContain("阶段切换");
    expect(protocol).toContain("1–2 句可见 Markdown 意图");
    expect(protocol).toContain("不要把意图只写在思考通道里");
    expect(protocol).toContain("不要逐条复述即将调用的工具名");
    expect(protocol).toContain("继续推进");
    expect(protocol).toContain("不要为旁白把可同批的独立工具拆成多轮");
  });

  it("SVG lock contract and bootstrap prefer batched skills and post-P01 bulk writes", () => {
    const contract = formatSvgDeckLockContractBlock();
    expect(contract).toContain("可同批加载多个 Skill");
    expect(contract).toContain("分批写剩余 SVG");
    expect(contract).toContain("SubmitSvgDeck（独批）");

    const bootstrap = formatSvgDeckLockBootstrapGuidance();
    expect(bootstrap).toContain("Batch LoadSkill");
    expect(bootstrap).toContain("manageable batches");
    expect(bootstrap).toContain("preview each batch");
  });

  it("LoadSkill tool card text allows multiple skills in one response", () => {
    expect(loadSkillTool.description).toContain("same assistant response");
    expect(loadSkillTool.description).toContain("do not open a new model turn per skill");
  });
});
