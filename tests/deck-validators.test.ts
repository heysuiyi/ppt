import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AssetValidator } from "../src/ppt/core/validators/asset-validator";
import { LayoutValidator } from "../src/ppt/core/validators/layout-validator";
import { StyleValidator } from "../src/ppt/core/validators/style-validator";
import type { Presentation, Slide, SlideNarrative } from "../src/shared/presentation";
import { createSvgTestSlide } from "../src/shared/presentation-fixtures";
import { TEST_DESIGN_SYSTEM, testDesignSystem } from "./design-engine-test-utils";

const NARRATIVE: SlideNarrative = {
  role: "cover",
  coreMessage: "Validation test message",
  audienceMove: "Focus attention",
  rhythm: "anchor",
  layoutIntent: "One dominant statement.",
};

function createPresentation(slides: Slide[], overrides: Partial<Presentation> = {}): Presentation {
  return {
    id: "pres-1",
    title: "Validation Test Deck",
    revision: 1,
    designSystem: TEST_DESIGN_SYSTEM,
    slides,
    ...overrides,
  };
}

describe("LayoutValidator", () => {
  const validator = new LayoutValidator();

  it("accepts a valid SVG page with matching hash and narrative", () => {
    const slide = createSvgTestSlide({ title: "Cover", narrative: NARRATIVE });
    const issues = validator.validate(createPresentation([slide]));
    expect(issues).toEqual([]);
  });

  it("flags invalid SVG markup", () => {
    const slide = createSvgTestSlide({
      title: "Broken",
      markup: "<svg><script>alert(1)</script></svg>",
      narrative: NARRATIVE,
    });
    slide.visualSource.sha256 = createHash("sha256")
      .update(slide.visualSource.markup, "utf8")
      .digest("hex");

    const issues = validator.validate(createPresentation([slide]));
    expect(issues.some((issue) => issue.severity === "error" && issue.category === "layout")).toBe(
      true,
    );
  });

  it("flags hash tampering", () => {
    const slide = createSvgTestSlide({ title: "Tampered", narrative: NARRATIVE });
    slide.visualSource.sha256 = "a".repeat(64);

    const issues = validator.validate(createPresentation([slide]));
    expect(issues).toEqual([
      expect.objectContaining({
        slideId: slide.id,
        category: "layout",
        severity: "error",
        message: expect.stringContaining("no longer matches its source hash"),
      }),
    ]);
  });

  it("requires narrative contract on SVG pages", () => {
    const slide = createSvgTestSlide({ title: "No narrative" });
    const issues = validator.validate(createPresentation([slide]));
    expect(issues).toEqual([
      expect.objectContaining({
        slideId: slide.id,
        category: "structure",
        severity: "error",
        message: expect.stringContaining("missing its page narrative contract"),
      }),
    ]);
  });

  it("rejects non-SVG slides", () => {
    const slide = {
      id: "legacy",
      title: "Legacy",
    } as Slide;

    const issues = validator.validate(createPresentation([slide]));
    expect(issues).toEqual([
      expect.objectContaining({
        slideId: "legacy",
        category: "structure",
        severity: "error",
        message: expect.stringContaining("not SVG-native"),
      }),
    ]);
  });
});

describe("StyleValidator", () => {
  const validator = new StyleValidator();

  it("flags repeated slide titles", () => {
    const presentation = createPresentation([
      createSvgTestSlide({ id: "s1", title: "Duplicate", narrative: NARRATIVE }),
      createSvgTestSlide({ id: "s2", title: "Duplicate", narrative: NARRATIVE }),
    ]);

    const issues = validator.validate(presentation);
    expect(issues.some((issue) => issue.category === "consistency")).toBe(true);
  });

  it("flags an invalid deck design system", () => {
    const presentation = createPresentation(
      [createSvgTestSlide({ title: "Cover", narrative: NARRATIVE })],
      {
        designSystem: { version: 1 } as unknown as Presentation["designSystem"],
      },
    );

    const issues = validator.validate(presentation);
    expect(issues).toEqual([
      expect.objectContaining({
        category: "style",
        severity: "error",
        message: expect.stringContaining("designSystem is invalid"),
      }),
    ]);
  });

  it("accepts a valid design system contract", () => {
    const presentation = createPresentation(
      [createSvgTestSlide({ title: "Cover", narrative: NARRATIVE })],
      {
        designSystem: testDesignSystem({ visualStyle: "dark-tech" }),
      },
    );

    const issues = validator.validate(presentation);
    expect(issues.filter((issue) => issue.category === "style")).toEqual([]);
  });
});

describe("AssetValidator", () => {
  const validator = new AssetValidator();

  it("warns when the same embedded resource is reused across slides", () => {
    const resource = {
      sourcePath: "assets/photo.png",
      mimeType: "image/png" as const,
      byteSize: 128,
      sha256: "b".repeat(64),
    };
    const first = createSvgTestSlide({ id: "s1", title: "First", narrative: NARRATIVE });
    first.visualSource.resources = [resource];
    const second = createSvgTestSlide({ id: "s2", title: "Second", narrative: NARRATIVE });
    second.visualSource.resources = [resource];

    const issues = validator.validate(createPresentation([first, second]));
    expect(issues).toEqual([
      expect.objectContaining({
        category: "asset",
        severity: "warning",
        message: expect.stringContaining("same image source is reused"),
      }),
    ]);
  });

  it("does not flag SVG pages without embedded raster resources", () => {
    const slide = createSvgTestSlide({ title: "Text only", narrative: NARRATIVE });
    const issues = validator.validate(createPresentation([slide]));
    expect(issues).toEqual([]);
  });
});
