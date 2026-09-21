import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportPresentationOptions } from "@shared/ppt-export";
import { afterEach, describe, expect, it } from "vitest";
import { DeckExportService } from "../src/ppt/core/deck-export-service";
import type { SlideNarrative } from "../src/shared/presentation";
import { createStarterPresentation, createSvgTestSlide } from "../src/shared/presentation-fixtures";

const defaultExportOptions: ExportPresentationOptions = {};

const NARRATIVE: SlideNarrative = {
  role: "cover",
  coreMessage: "Deck export service test",
  audienceMove: "Review export output",
  rhythm: "anchor",
  layoutIntent: "One full-page SVG slide.",
};

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function createTempExportPath(prefix: string, ext: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, `export.${ext}`);
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

function exportReadyPresentation() {
  const presentation = createStarterPresentation();
  presentation.slides[0].narrative = NARRATIVE;
  return presentation;
}

describe("DeckExportService", () => {
  const service = new DeckExportService();

  it("exports presentation to a valid pptx file", async () => {
    const presentation = exportReadyPresentation();
    const filePath = await createTempExportPath("deck-export-pptx-", "pptx");

    const result = await service.exportDeck({
      presentation,
      options: defaultExportOptions,
      filePath,
    });

    expect(result.filePath).toBe(filePath);
    expect(result.slideCount).toBe(presentation.slides.length);
    await assertValidPptxFile(filePath, presentation.slides.length);
  });

  it("exports presentation to json when file path ends with .json", async () => {
    const presentation = exportReadyPresentation();
    const filePath = await createTempExportPath("deck-export-json-", "json");

    const result = await service.exportDeck({
      presentation,
      options: defaultExportOptions,
      filePath,
    });

    expect(result.filePath).toBe(filePath);
    expect(result.slideCount).toBe(presentation.slides.length);

    const saved = JSON.parse(await readFile(filePath, "utf8"));
    expect(saved.title).toBe(presentation.title);
    expect(saved.slides).toHaveLength(presentation.slides.length);
    expect(saved.slides[0].visualSource.kind).toBe("svg");
  });

  it("exports presentation to html when file path ends with .html", async () => {
    const presentation = exportReadyPresentation();
    const filePath = await createTempExportPath("deck-export-html-", "html");

    const result = await service.exportDeck({
      presentation,
      options: defaultExportOptions,
      filePath,
    });

    expect(result.filePath).toBe(filePath);
    const html = await readFile(filePath, "utf8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(presentation.title);
    expect(html).toContain('class="slide-svg-source"');
  });

  it("rejects unknown export option keys", async () => {
    const presentation = exportReadyPresentation();
    const filePath = await createTempExportPath("deck-export-options-", "pptx");

    await expect(
      service.exportDeck({
        presentation,
        options: { unexpected: true } as unknown as ExportPresentationOptions,
        filePath,
      }),
    ).rejects.toThrow();
  });

  it("generates a default export path when filePath is omitted", async () => {
    const presentation = exportReadyPresentation();

    const result = await service.exportDeck({
      presentation,
      options: defaultExportOptions,
    });

    expect(result.filePath.endsWith(".pptx")).toBe(true);
    expect(result.slideCount).toBe(presentation.slides.length);
    await assertValidPptxFile(result.filePath, presentation.slides.length);

    tempDirs.push(join(result.filePath, ".."));
  });

  it("blocks renderable exports when SVG validation fails", async () => {
    const presentation = exportReadyPresentation();
    presentation.slides[0].visualSource.sha256 = "0".repeat(64);
    const filePath = await createTempExportPath("deck-export-invalid-svg-", "pptx");

    await expect(
      service.exportDeck({
        presentation,
        options: defaultExportOptions,
        filePath,
      }),
    ).rejects.toThrow("Export blocked by deck validation");
  });

  it("still allows JSON recovery export for decks with validation errors", async () => {
    const presentation = exportReadyPresentation();
    presentation.slides[0].visualSource.sha256 = "0".repeat(64);
    const filePath = await createTempExportPath("deck-export-recovery-", "json");

    await expect(
      service.exportDeck({
        presentation,
        options: defaultExportOptions,
        filePath,
      }),
    ).resolves.toMatchObject({ filePath });
  });

  it("exports multi-slide SVG decks", async () => {
    const presentation = exportReadyPresentation();
    presentation.slides.push(
      createSvgTestSlide({
        title: "Second page",
        narrative: {
          role: "evidence",
          coreMessage: "More detail",
          audienceMove: "Understand",
          rhythm: "dense",
          layoutIntent: "Evidence stack.",
        },
      }),
    );
    const filePath = await createTempExportPath("deck-export-multi-svg-", "pptx");

    const result = await service.exportDeck({
      presentation,
      options: defaultExportOptions,
      filePath,
    });

    expect(result.slideCount).toBe(2);
    await assertValidPptxFile(filePath, 2);
  });
});
