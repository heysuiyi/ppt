import { exportPresentationOptionsSchema } from "@shared/ppt-export";
import { describe, expect, it } from "vitest";
import {
  rasterDataImageSourceSchema,
  slideSchema,
  svgPageResourceSchema,
  svgPageVisualSourceSchema,
} from "../src/shared/presentation";
import { createMinimalSvgMarkup, createSvgVisualSource } from "../src/shared/presentation-fixtures";

describe("presentation SVG schema integrity", () => {
  it("accepts only known export presentation options", () => {
    expect(exportPresentationOptionsSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(exportPresentationOptionsSchema.safeParse({ allowUnverifiedAssets: true }).success).toBe(
      true,
    );
    expect(exportPresentationOptionsSchema.safeParse({}).success).toBe(true);
  });

  it("requires a complete SVG visual source with fixed page dimensions", () => {
    const markup = createMinimalSvgMarkup("Schema test");
    const visualSource = createSvgVisualSource({ markup });

    expect(svgPageVisualSourceSchema.safeParse(visualSource).success).toBe(true);
    expect(
      svgPageVisualSourceSchema.safeParse({
        ...visualSource,
        width: 1920,
      }).success,
    ).toBe(false);
    expect(
      svgPageVisualSourceSchema.safeParse({
        ...visualSource,
        kind: "html",
      }).success,
    ).toBe(false);
    expect(
      svgPageVisualSourceSchema.safeParse({
        ...visualSource,
        markup: "   ",
      }).success,
    ).toBe(false);
  });

  it("validates embedded SVG raster resources", () => {
    expect(
      svgPageResourceSchema.safeParse({
        sourcePath: "assets/photo.png",
        mimeType: "image/png",
        byteSize: 1024,
        sha256: "a".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      svgPageResourceSchema.safeParse({
        sourcePath: "assets/photo.png",
        mimeType: "image/svg+xml",
        byteSize: 1024,
        sha256: "a".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("rejects legacy element-IR fields on slides", () => {
    const slide = {
      id: "slide-1",
      title: "Legacy",
      visualSource: createSvgVisualSource(),
      elements: [{ id: "text-1", type: "text" }],
    };

    expect(slideSchema.safeParse(slide).success).toBe(false);
  });

  it("rejects mismatched raster data URL signatures", () => {
    expect(
      rasterDataImageSourceSchema.safeParse("data:image/png;base64,PHN2Zz48L3N2Zz4=").success,
    ).toBe(false);
    expect(
      rasterDataImageSourceSchema.safeParse("data:image/jpeg;base64,iVBORw0KGgo=").success,
    ).toBe(false);
  });
});
