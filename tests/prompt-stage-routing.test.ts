import { describe, expect, it } from "vitest";
import type { WorkspaceArtifacts } from "../src/main/plugins/ppt/presentation/workspace-artifacts";
import {
  LEGACY_PROMPT_STAGE_MAP,
  normalizePromptStage,
  resolvePromptStage,
} from "../src/main/plugins/ppt/prompts/prompt-stage";
import type { Presentation } from "../src/shared/presentation";
import { createSvgTestSlide } from "../src/shared/presentation-fixtures";
import { TEST_DESIGN_SYSTEM } from "./design-engine-test-utils";

const emptyArtifacts: WorkspaceArtifacts = {
  designSpec: false,
  templatePolicy: false,
  templatePack: false,
  pagePlan: false,
  pageSvg: false,
  assets: false,
  deck: false,
  exportHistory: false,
  brief: false,
  outline: false,
  research: false,
};

function deck(slideCount: number, svg = false): Presentation {
  return {
    id: "p",
    title: "t",
    revision: 1,
    designSystem: TEST_DESIGN_SYSTEM,
    slides: Array.from({ length: slideCount }, (_, i) =>
      svg
        ? createSvgTestSlide({
            id: `slide-${i}`,
            title: `s${i}`,
            sourcePath: `slides/svg/slide-${i}.svg`,
          })
        : ({
            id: `slide-${i}`,
            title: `s${i}`,
            visualSource: undefined,
          } as unknown as Presentation["slides"][number]),
    ),
  };
}

describe("normalizePromptStage", () => {
  it("maps every legacy stage name to the advisory vocabulary", () => {
    expect(normalizePromptStage("routing")).toBe("discover");
    expect(normalizePromptStage("planning")).toBe("discover");
    expect(normalizePromptStage("content")).toBe("author");
    expect(normalizePromptStage("layout-choice")).toBe("design");
    expect(normalizePromptStage("layout-design")).toBe("design");
    expect(normalizePromptStage("layout-exec")).toBe("style");
    expect(normalizePromptStage("review")).toBe("style");
    expect(normalizePromptStage("light-edit")).toBe("edit");
    expect(normalizePromptStage("export")).toBe("export");
    expect(Object.keys(LEGACY_PROMPT_STAGE_MAP).length).toBe(8);
  });

  it("passes through current stage names", () => {
    expect(normalizePromptStage("discover")).toBe("discover");
    expect(normalizePromptStage("style")).toBe("style");
  });
});

describe("resolvePromptStage (advisory capability hint)", () => {
  it("uses the same durable state for different request wording", () => {
    const presentation = deck(4, true);
    const exportRequest = resolvePromptStage({
      request: "请导出 PPT 文件",
      presentation,
      artifacts: emptyArtifacts,
    });
    const editRequest = resolvePromptStage({
      request: "把第二页文字调整一下",
      presentation,
      artifacts: emptyArtifacts,
    });
    const fullDeckRequest = resolvePromptStage({
      request: "做成一套完整汇报",
      presentation,
      artifacts: emptyArtifacts,
    });

    expect(exportRequest).toBe("edit");
    expect(editRequest).toBe(exportRequest);
    expect(fullDeckRequest).toBe(exportRequest);
  });

  it("describes an empty workspace as discover", () => {
    expect(
      resolvePromptStage({
        request: "任意请求",
        presentation: deck(0),
        artifacts: emptyArtifacts,
      }),
    ).toBe("discover");
  });

  it("routes slides missing SVG visualSource to design", () => {
    expect(
      resolvePromptStage({
        request: "任意请求",
        presentation: deck(3),
        artifacts: emptyArtifacts,
      }),
    ).toBe("design");
    expect(
      resolvePromptStage({
        request: "任意请求",
        presentation: deck(0),
        artifacts: { ...emptyArtifacts, outline: true },
      }),
    ).toBe("author");
  });

  it("uses authored SVG pages as evidence for preview/quality work before apply", () => {
    expect(
      resolvePromptStage({
        request: "任意请求",
        presentation: deck(0),
        artifacts: { ...emptyArtifacts, pageSvg: true },
      }),
    ).toBe("style");
    expect(
      resolvePromptStage({
        request: "任意请求",
        presentation: deck(3, true),
        artifacts: { ...emptyArtifacts, pageSvg: true },
      }),
    ).toBe("edit");
  });

  it("does not parse assistant prose as hidden workflow state", () => {
    const withMessage = resolvePromptStage({
      request: "继续",
      presentation: deck(2),
      artifacts: emptyArtifacts,
      messageHistory: [{ role: "assistant", content: "内容草稿已就绪，请确认设计方向。" }],
    });
    const withoutMessage = resolvePromptStage({
      request: "继续",
      presentation: deck(2),
      artifacts: emptyArtifacts,
    });
    expect(withMessage).toBe("design");
    expect(withMessage).toBe(withoutMessage);
  });

  it("accepts explicit current and legacy stage hints", () => {
    expect(
      resolvePromptStage({
        request: "x",
        presentation: deck(0),
        artifacts: emptyArtifacts,
        stageHint: "export",
      }),
    ).toBe("export");
    expect(
      resolvePromptStage({
        request: "x",
        presentation: deck(0),
        artifacts: emptyArtifacts,
        stageHint: "layout-exec",
      }),
    ).toBe("style");
  });
});
