import { describe, expect, it } from "vitest";
import { getChatPromptTemplates } from "../app/renderer/src/components/chat-workspace-copy";
import { DEFAULT_DESIGN_SYSTEM } from "../src/design-system";
import type { Presentation } from "../src/shared/presentation";
import { createSvgTestSlide } from "../src/shared/presentation-fixtures";

const presentation: Presentation = {
  id: "deck-1",
  title: "快捷模板测试",
  revision: 1,
  designSystem: DEFAULT_DESIGN_SYSTEM,
  slides: [
    createSvgTestSlide({ id: "slide-1", title: "封面", sourcePath: "slides/svg/P01.svg" }),
    createSvgTestSlide({ id: "slide-2", title: "结论", sourcePath: "slides/svg/P02.svg" }),
    createSvgTestSlide({ id: "slide-3", title: "计划", sourcePath: "slides/svg/P03.svg" }),
  ],
};

function commands(deck?: Presentation, selectedSlideId?: string): string[] {
  return getChatPromptTemplates(deck, selectedSlideId).map((template) => template.command);
}

describe("ChatWorkspace prompt templates", () => {
  it("uses the selected slide's one-based page number", () => {
    expect(commands(presentation, "slide-1")).toContain("删除第 1 页");
    expect(commands(presentation, "slide-2")).toContain("删除第 2 页");
  });

  it("hides the delete template when the current slide cannot be resolved", () => {
    expect(commands()).not.toEqual(expect.arrayContaining([expect.stringMatching(/^删除/)]));
    expect(commands(presentation, "")).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^删除/)]),
    );
    expect(commands(presentation, "missing-slide")).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^删除/)]),
    );
  });

  it("never produces the incomplete delete command", () => {
    for (const selectedSlideId of [undefined, "", "slide-1", "slide-3", "missing-slide"]) {
      expect(commands(presentation, selectedSlideId)).not.toContain("删除第 页");
    }
  });
});
