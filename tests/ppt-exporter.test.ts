import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportPresentationOptions } from "@shared/ppt-export";
import { afterEach, describe, expect, it } from "vitest";
import { exportToPptx } from "../src/ppt/core/ppt-exporter";
import { CommandBus } from "../src/shared/commands";
import type { Presentation, SlideNarrative } from "../src/shared/presentation";
import { createStarterPresentation, createSvgTestSlide } from "../src/shared/presentation-fixtures";
import { testDesignSystem } from "./design-engine-test-utils";

const defaultExportOptions: ExportPresentationOptions = {};

const NARRATIVE: SlideNarrative = {
  role: "cover",
  coreMessage: "Export smoke test",
  audienceMove: "Review the deck",
  rhythm: "anchor",
  layoutIntent: "One full-page SVG slide.",
};

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function createTempPptxPath(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, "export.pptx");
}

async function assertValidPptxFile(filePath: string, expectedSlideCount: number): Promise<void> {
  const info = await stat(filePath);
  expect(info.isFile()).toBe(true);
  expect(info.size).toBeGreaterThan(1024);

  const buffer = await readFile(filePath);
  expect(buffer.subarray(0, 4).toString("hex")).toBe("504b0304");

  const archiveText = buffer.toString("latin1");
  expect(archiveText).toContain("[Content_Types].xml");
  expect(archiveText).toContain("ppt/presentation.xml");
  expect(archiveText).toContain("ppt/slides/slide1.xml");

  const slideParts = archiveText.match(/ppt\/slides\/slide\d+\.xml/g) ?? [];
  expect(new Set(slideParts).size).toBe(expectedSlideCount);
}

function exportReadyPresentation(): Presentation {
  const presentation = createStarterPresentation();
  presentation.slides[0].narrative = NARRATIVE;
  return presentation;
}

function createMultiSlidePresentation(): Presentation {
  return {
    id: crypto.randomUUID(),
    title: "SVG Export Smoke Test",
    revision: 3,
    designSystem: testDesignSystem({ visualStyle: "dark-tech", colorScheme: "tech-dark" }),
    slides: [
      createSvgTestSlide({
        title: "Opening Slide",
        markup: [
          '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
          '<rect width="1280" height="720" fill="#0f172a"/>',
          '<text x="640" y="360" fill="#f8fafc" font-size="48" text-anchor="middle">Opening</text>',
          "</svg>",
        ].join(""),
        narrative: NARRATIVE,
      }),
      createSvgTestSlide({
        title: "Content Slide",
        markup: [
          '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
          '<rect width="1280" height="720" fill="#111827"/>',
          '<text x="120" y="180" fill="#e5e7eb" font-size="36">Evidence page</text>',
          "</svg>",
        ].join(""),
        narrative: {
          role: "evidence",
          coreMessage: "Supporting detail",
          audienceMove: "Build conviction",
          rhythm: "dense",
          layoutIntent: "Layer evidence with a clear reading path.",
        },
      }),
    ],
  };
}

describe("ppt-exporter", () => {
  it("exports the starter presentation to a valid pptx file", async () => {
    const filePath = await createTempPptxPath("ppt-export-starter-");
    await exportToPptx(exportReadyPresentation(), defaultExportOptions, filePath);
    await assertValidPptxFile(filePath, 1);
  });

  it("exports multiple SVG pages across slides", async () => {
    const filePath = await createTempPptxPath("ppt-export-multi-svg-");
    await exportToPptx(createMultiSlidePresentation(), defaultExportOptions, filePath);
    await assertValidPptxFile(filePath, 2);
  });

  it("exports speaker notes for SVG pages", async () => {
    const filePath = await createTempPptxPath("ppt-export-notes-");
    const presentation = exportReadyPresentation();
    presentation.slides[0].speakerNotes = "Explain the opening and ask for approval.";

    await exportToPptx(presentation, defaultExportOptions, filePath);
    await assertValidPptxFile(filePath, 1);

    const archiveText = (await readFile(filePath)).toString("latin1");
    expect(archiveText).toContain("ppt/notesSlides/notesSlide1.xml");
  });

  it("rejects a slide without SVG visualSource", async () => {
    const filePath = await createTempPptxPath("ppt-export-non-svg-");
    const presentation = exportReadyPresentation();
    (presentation.slides[0] as { visualSource?: unknown }).visualSource = undefined;

    await expect(exportToPptx(presentation, defaultExportOptions, filePath)).rejects.toThrow(
      "not SVG-native",
    );
  });

  it("exports a presentation built through CommandBus SVG commands", async () => {
    const bus = new CommandBus(exportReadyPresentation());
    const firstSlideId = bus.getSnapshot().slides[0].id;

    bus.execute({
      id: crypto.randomUUID(),
      type: "set-presentation-title",
      title: "CommandBus Generated Deck",
    });
    bus.execute({
      id: crypto.randomUUID(),
      type: "set-design-system",
      designSystem: testDesignSystem({ visualStyle: "dark-tech", colorScheme: "tech-dark" }),
    });
    bus.execute({
      id: crypto.randomUUID(),
      type: "add-slide",
      index: 1,
      slide: createSvgTestSlide({
        title: "Generated Slide",
        narrative: {
          role: "summary",
          coreMessage: "Created by PresentationCommand pipeline",
          audienceMove: "Confirm next steps",
          rhythm: "breathing",
          layoutIntent: "Close with one clear action.",
        },
      }),
    });
    bus.execute({
      id: crypto.randomUUID(),
      type: "set-slide-title",
      slideId: firstSlideId,
      title: "Updated opening",
    });

    const presentation = bus.getSnapshot();
    expect(presentation.slides).toHaveLength(2);
    expect(presentation.slides.every((slide) => slide.visualSource.kind === "svg")).toBe(true);

    const filePath = await createTempPptxPath("ppt-export-command-bus-");
    await exportToPptx(presentation, {}, filePath);
    await assertValidPptxFile(filePath, 2);
  });
});
