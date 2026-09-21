import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { getDesignReferenceTool } from "../src/main/plugins/ppt/tools/get-design-reference";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

describe("GetDesignReference", () => {
  it("returns behavior-rich mode, style, reading, and image guidance", async () => {
    const result = await getDesignReferenceTool.execute(
      {
        argumentMode: "pyramid",
        visualStyle: "swiss-minimal",
        readingMode: "presentation",
      },
      {
        presentation: createStarterPresentation(),
        selectedElementIds: [],
        discoverySession: { discoveredToolNames: new Set() },
        registry: new ToolRegistry(),
        messageHistory: [],
      },
    );

    expect(result.argument).toMatchObject({
      id: "pyramid",
      titleVoice: "assertion",
    });
    expect(result.argument.hardRules).toEqual(
      expect.arrayContaining([
        expect.stringContaining("结论"),
        expect.stringContaining("MECE"),
        expect.stringContaining("比较"),
      ]),
    );
    expect(result.argument.antiPatterns).toEqual(
      expect.arrayContaining([expect.stringContaining("主题标题"), expect.stringContaining("KPI")]),
    );
    expect(result.argument.titleExamples).toContainEqual({
      prefer: "续费而非拉新，已成为增长主引擎",
      avoid: "增长概览",
    });
    expect(result.argument.pageSkeletons[0]).toMatchObject({
      id: "analytical-proof",
      titlePattern: expect.stringContaining("结论句"),
    });
    expect(result.visual).toMatchObject({
      id: "swiss-minimal",
      shape: { radius: 0, decoration: "none" },
      whitespace: { rhythm: "vast" },
      imageLanguage: {
        rendering: "minimalist-swiss",
        illustrationPropensity: "sparse",
      },
    });
    expect(result.visual.composition).toContain("非对称");
    expect(result.visual.compositionDiscipline).toMatchObject({
      primaryStructure: expect.arrayContaining([expect.stringContaining("阅读顺序")]),
      decorationLayer: expect.arrayContaining([expect.stringContaining("不承担核心信息")]),
      deckVariation: expect.arrayContaining([expect.stringContaining("改变页面的主结构")]),
    });
    expect(result.reading).toMatchObject({
      id: "presentation",
      visualBurden: "leading",
    });
  });

  it.each([
    ["pyramid", "assertion", "MECE", "analytical-proof"],
    ["narrative", "story-beat", "转折", "turn-and-payoff"],
    ["instructional", "teaching", "一个概念", "worked-example"],
    ["showcase", "evocative", "主导视觉", "hero-reveal"],
    ["briefing", "topic", "完整集合", "status-reference"],
  ] as const)(
    "returns executable rules and skeletons for %s",
    async (argumentMode, titleVoice, ruleFragment, skeletonId) => {
      const result = await getDesignReferenceTool.execute(
        {
          argumentMode,
          visualStyle: "swiss-minimal",
          readingMode: "balanced",
        },
        {
          presentation: createStarterPresentation(),
          selectedElementIds: [],
          discoverySession: { discoveredToolNames: new Set() },
          registry: new ToolRegistry(),
          messageHistory: [],
        },
      );

      expect(result.argument.titleVoice).toBe(titleVoice);
      expect(result.argument.hardRules.join(" ")).toContain(ruleFragment);
      expect(result.argument.hardRules.length).toBeGreaterThanOrEqual(5);
      expect(result.argument.antiPatterns.length).toBeGreaterThanOrEqual(4);
      expect(result.argument.titleExamples.length).toBeGreaterThanOrEqual(2);
      expect(result.argument.pageSkeletons).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: skeletonId })]),
      );
      expect(
        result.argument.pageSkeletons.every((skeleton) => skeleton.bodySequence.length >= 4),
      ).toBe(true);
    },
  );
});
