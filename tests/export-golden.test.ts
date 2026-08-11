import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { DeckExportService } from "../src/main/deck/deck-export-service";
import { inspectPptxExport } from "../src/main/deck/pptx-postflight";
import {
  expectedExportSvgHashSource,
  type LiftedText,
  liftSvgText,
} from "../src/main/deck/svg-text-lift";
import type { Presentation } from "../src/shared/presentation";
import { createExportGoldenPresentation } from "./fixtures/export-golden-deck";

const GOLDEN_PATH = fileURLToPath(new URL("./fixtures/export-golden-layers.json", import.meta.url));
const UPDATE_GOLDEN = process.env.UPDATE_EXPORT_GOLDEN === "1";

interface GoldenSlideLayers {
  id: string;
  texts: LiftedText[];
  backgroundSvg: string;
  backgroundSha256: string;
}

interface GoldenLayersFile {
  slides: GoldenSlideLayers[];
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function captureLayers(presentation: Presentation): GoldenSlideLayers[] {
  return presentation.slides.map((slide) => {
    const markup = slide.visualSource.markup;
    const lifted = liftSvgText(markup);
    const backgroundSvg = expectedExportSvgHashSource(markup);
    return {
      id: slide.id,
      texts: lifted.texts,
      backgroundSvg,
      backgroundSha256: createHash("sha256").update(backgroundSvg, "utf8").digest("hex"),
    };
  });
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function extractTextRuns(xml: string): string[] {
  return Array.from(xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g), (match) =>
    decodeXmlText(match[1]),
  );
}

async function assertValidPptxFile(filePath: string, expectedSlideCount: number): Promise<void> {
  const info = await stat(filePath);
  expect(info.isFile()).toBe(true);
  expect(info.size).toBeGreaterThan(1024);

  const buffer = await readFile(filePath);
  expect(buffer.subarray(0, 4).toString("hex")).toBe("504b0304");

  const archive = await JSZip.loadAsync(buffer);
  expect(archive.file("[Content_Types].xml")).toBeTruthy();
  expect(archive.file("ppt/presentation.xml")).toBeTruthy();

  const slidePaths = Object.keys(archive.files).filter((path) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(path),
  );
  expect(slidePaths).toHaveLength(expectedSlideCount);
}

describe("Layer 2 export golden", () => {
  it("locks lifted export layers against the committed golden", async () => {
    const presentation = createExportGoldenPresentation();
    const actual = { slides: captureLayers(presentation) } satisfies GoldenLayersFile;

    if (UPDATE_GOLDEN) {
      await writeFile(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    }

    const raw = await readFile(GOLDEN_PATH, "utf8");
    const golden = JSON.parse(raw) as GoldenLayersFile;
    expect(actual).toEqual(golden);
  });

  it("exports the golden deck through DeckExportService and matches package contents", async () => {
    const presentation = createExportGoldenPresentation();
    const layers = captureLayers(presentation);
    const directory = await mkdtemp(join(tmpdir(), "export-golden-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "export-golden.pptx");

    const result = await new DeckExportService().exportDeck({
      presentation,
      options: {},
      filePath,
    });

    expect(result.filePath).toBe(filePath);
    expect(result.slideCount).toBe(presentation.slides.length);
    await assertValidPptxFile(filePath, presentation.slides.length);

    const report = await inspectPptxExport(filePath, presentation);
    expect(report.passed).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.slideCount).toBe(6);
    expect(report.notesPartCount).toBeGreaterThanOrEqual(1);
    expect(report.chartPartCount).toBe(0);

    const archive = await JSZip.loadAsync(await readFile(filePath));
    for (const [index, slideLayers] of layers.entries()) {
      const slideXml = await archive.file(`ppt/slides/slide${index + 1}.xml`)!.async("string");
      const runs = extractTextRuns(slideXml);
      const expectedLines = slideLayers.texts.flatMap((text) => text.content.split("\n"));
      expect(runs, `slide ${slideLayers.id} text runs`).toEqual(expectedLines);

      if (slideLayers.texts.length === 0) {
        expect(slideXml).not.toMatch(/<p:sp\b/);
      }
    }

    const notesPaths = Object.keys(archive.files).filter((path) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(path),
    );
    const notesTexts = await Promise.all(
      notesPaths.map(async (path) => extractTextRuns(await archive.file(path)!.async("string"))),
    );
    expect(notesTexts.flat().join("\n")).toContain(
      "Explain the export contract and ask for approval.",
    );
  });
});
