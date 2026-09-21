import { beforeEach, describe, expect, it, vi } from "vitest";
import { liftSvgText } from "../src/ppt/core/svg-text-lift";
import { utf8ToBase64 } from "../src/shared/base64";
import type { SlideNarrative } from "../src/shared/presentation";
import {
  createStarterPresentation,
  createSvgVisualSource,
} from "../src/shared/presentation-fixtures";

const pptxMocks = vi.hoisted(() => {
  const slide = {
    background: undefined as unknown,
    addImage: vi.fn(),
    addNotes: vi.fn(),
    addText: vi.fn(),
    addShape: vi.fn(),
    addChart: vi.fn(),
    addTable: vi.fn(),
  };
  const instance = {
    layout: "",
    defineLayout: vi.fn(),
    addSlide: vi.fn(() => slide),
    writeFile: vi.fn(async () => undefined),
  };
  return { instance, slide };
});

vi.mock("pptxgenjs", () => ({
  default: function MockPptxGen() {
    return pptxMocks.instance;
  },
}));

import { exportToPptx } from "../src/ppt/core/ppt-exporter";

const NARRATIVE: SlideNarrative = {
  role: "cover",
  coreMessage: "SVG page export",
  audienceMove: "Review",
  rhythm: "anchor",
  layoutIntent: "One full-page SVG.",
};

describe("SVG page PPTX export", () => {
  beforeEach(() => {
    pptxMocks.instance.layout = "";
    pptxMocks.instance.defineLayout.mockClear();
    pptxMocks.instance.addSlide.mockClear();
    pptxMocks.instance.writeFile.mockClear();
    pptxMocks.slide.background = undefined;
    [
      pptxMocks.slide.addImage,
      pptxMocks.slide.addNotes,
      pptxMocks.slide.addText,
      pptxMocks.slide.addShape,
      pptxMocks.slide.addChart,
      pptxMocks.slide.addTable,
    ].forEach((mock) => mock.mockClear());
  });

  it("exports a text-stripped SVG background plus native editable text", async () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
      '<rect width="1280" height="720" fill="#0f172a"/>' +
      '<text x="40" y="80" font-size="32" fill="#ffffff">SVG page</text></svg>';
    const lifted = liftSvgText(markup);
    const presentation = createStarterPresentation();
    presentation.id = "deck-1";
    presentation.title = "SVG deck";
    presentation.revision = 1;
    presentation.slides[0] = {
      id: "slide-1",
      title: "Legacy chrome must not appear",
      speakerNotes: "Speaker note",
      narrative: NARRATIVE,
      visualSource: createSvgVisualSource({
        markup,
        sourcePath: "slides/svg/slide-1.svg",
        title: "Legacy chrome must not appear",
      }),
    };

    await exportToPptx(presentation, {}, "/tmp/svg-page.pptx");

    expect(pptxMocks.instance.defineLayout).toHaveBeenCalledWith({
      name: "AGENT_PPT_WIDE",
      width: 10,
      height: 5.625,
    });
    expect(pptxMocks.instance.layout).toBe("AGENT_PPT_WIDE");
    expect(pptxMocks.slide.background).toEqual({ fill: "FFFFFF" });
    expect(pptxMocks.slide.addImage).toHaveBeenCalledTimes(1);
    expect(pptxMocks.slide.addImage).toHaveBeenCalledWith({
      data: `data:image/svg+xml;base64,${utf8ToBase64(lifted.backgroundSvg)}`,
      x: 0,
      y: 0,
      w: 10,
      h: 5.625,
    });
    expect(pptxMocks.slide.addText).toHaveBeenCalledTimes(1);
    expect(pptxMocks.slide.addText).toHaveBeenCalledWith(
      "SVG page",
      expect.objectContaining({
        fontFace: "Arial",
        color: "FFFFFF",
        align: "left",
        valign: "top",
        bold: false,
      }),
    );
    expect(pptxMocks.slide.addNotes).toHaveBeenCalledWith("Speaker note");
    expect(pptxMocks.slide.addShape).not.toHaveBeenCalled();
    expect(pptxMocks.slide.addChart).not.toHaveBeenCalled();
    expect(pptxMocks.slide.addTable).not.toHaveBeenCalled();
    expect(pptxMocks.instance.writeFile).toHaveBeenCalledWith({
      fileName: "/tmp/svg-page.pptx",
    });
  });

  it("falls back to a full-page SVG image when there is no liftable text", async () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
      '<rect width="1280" height="720" fill="#0f172a"/></svg>';
    const presentation = createStarterPresentation();
    presentation.slides[0] = {
      id: "slide-1",
      title: "No text",
      narrative: NARRATIVE,
      visualSource: createSvgVisualSource({
        markup,
        sourcePath: "slides/svg/slide-1.svg",
        title: "No text",
      }),
    };

    await exportToPptx(presentation, {}, "/tmp/svg-page-no-text.pptx");

    expect(pptxMocks.slide.addImage).toHaveBeenCalledWith({
      data: `data:image/svg+xml;base64,${utf8ToBase64(markup)}`,
      x: 0,
      y: 0,
      w: 10,
      h: 5.625,
    });
    expect(pptxMocks.slide.addText).not.toHaveBeenCalled();
  });

  it("rejects a slide without SVG visualSource", async () => {
    const presentation = createStarterPresentation();
    (presentation.slides[0] as { visualSource?: unknown }).visualSource = undefined;

    await expect(exportToPptx(presentation, {}, "/tmp/non-svg-page.pptx")).rejects.toThrow(
      "not SVG-native",
    );
  });
});
