// @vitest-environment jsdom

import { presentationUsesSvgPages } from "@shared/presentation-export";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmSvgExportExpectation } from "../app/renderer/src/app/presentation/exportExpectations";
import { DEFAULT_DESIGN_SYSTEM } from "../src/design-system";
import { createSvgTestSlide } from "../src/shared/presentation-fixtures";

function svgPresentation() {
  return {
    id: "deck-1",
    title: "SVG deck",
    revision: 1,
    designSystem: DEFAULT_DESIGN_SYSTEM,
    slides: [createSvgTestSlide({ id: "svg-1", title: "SVG" })],
  };
}

describe("exportExpectations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects SVG-native pages", () => {
    expect(presentationUsesSvgPages(svgPresentation())).toBe(true);
  });

  it("asks before exporting SVG decks", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(confirmSvgExportExpectation(svgPresentation())).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });
});
