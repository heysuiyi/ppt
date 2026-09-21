import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { exportToPptx } from "../src/ppt/core/ppt-exporter";
import { inspectPptxExport } from "../src/ppt/core/pptx-postflight";
import type { Slide } from "../src/shared/presentation";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("SVG page PPTX postflight", () => {
  it("proves that the exported media matches the text-stripped export background", async () => {
    const directory = await mkdtemp(join(tmpdir(), "svg-page-postflight-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "svg-deck.pptx");
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
      '<rect width="1280" height="720" fill="#0f172a"/>' +
      '<text x="80" y="140" fill="#ffffff" font-size="64">Exact source</text>' +
      "</svg>";
    const presentation = createStarterPresentation();
    presentation.slides = [
      {
        id: "svg-slide",
        title: "Exact source",
        narrative: {
          role: "cover",
          coreMessage: "Exact source",
          audienceMove: "Focus",
          rhythm: "anchor",
          layoutIntent: "One dominant statement.",
        },
        visualSource: {
          kind: "svg",
          markup,
          width: 1280,
          height: 720,
          sha256: createHash("sha256").update(markup, "utf8").digest("hex"),
          sourcePath: "slides/svg/P01.svg",
          resources: [],
        },
      },
    ];

    await exportToPptx(presentation, {}, filePath);
    const report = await inspectPptxExport(filePath, presentation);

    expect(report.passed).toBe(true);
    expect(report.slides[0]).toMatchObject({
      pictures: 1,
      graphicFrames: 0,
      svgSourcePresent: true,
      titlePresent: true,
    });
    expect(report.slides[0].textRuns).toBeGreaterThanOrEqual(1);
    expect(report.slides[0].shapes).toBeGreaterThanOrEqual(1);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("fallback media is not a valid PNG")]),
    );
  });

  it("rejects a deck when slide relationships point at swapped SVG media", async () => {
    const directory = await mkdtemp(join(tmpdir(), "svg-page-postflight-swap-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "svg-deck.pptx");
    const corruptedPath = join(directory, "svg-deck-corrupted.pptx");
    const presentation = createStarterPresentation();
    presentation.slides = [
      svgSlide("slide-1", "First", "slides/svg/P01.svg"),
      svgSlide("slide-2", "Second", "slides/svg/P02.svg"),
    ];

    await exportToPptx(presentation, {}, filePath);
    const archive = await JSZip.loadAsync(await readFile(filePath));
    const svgPaths = Object.keys(archive.files)
      .filter((path) => /^ppt\/media\/[^/]+\.svg$/i.test(path))
      .sort();
    expect(svgPaths).toHaveLength(2);
    const first = await archive.file(svgPaths[0])!.async("uint8array");
    const second = await archive.file(svgPaths[1])!.async("uint8array");
    archive.file(svgPaths[0], second);
    archive.file(svgPaths[1], first);
    await writeFile(corruptedPath, await archive.generateAsync({ type: "nodebuffer" }));

    const report = await inspectPptxExport(corruptedPath, presentation);
    expect(report.passed).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Slide 1 SVG picture's asvg:svgBlip is not related to its export background SVG",
        ),
        expect.stringContaining(
          "Slide 2 SVG picture's asvg:svgBlip is not related to its export background SVG",
        ),
      ]),
    );
  });

  it("rejects duplicate pictures, native charts, and non-full-frame SVG geometry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "svg-page-postflight-structure-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "svg-deck.pptx");
    const corruptedPath = join(directory, "svg-deck-corrupted.pptx");
    const presentation = createStarterPresentation();
    presentation.slides = [svgSlide("slide-1", "Structure", "slides/svg/P01.svg")];

    await exportToPptx(presentation, {}, filePath);
    const archive = await JSZip.loadAsync(await readFile(filePath));
    const slideFile = archive.file("ppt/slides/slide1.xml")!;
    const xml = await slideFile.async("string");
    const picture = xml.match(/<p:pic\b[^>]*>[\s\S]*?<\/p:pic>/i)?.[0];
    expect(picture).toBeDefined();

    archive.file("ppt/slides/slide1.xml", xml.replace("</p:spTree>", `${picture}</p:spTree>`));
    await writeFile(corruptedPath, await archive.generateAsync({ type: "nodebuffer" }));

    let report = await inspectPptxExport(corruptedPath, presentation);
    expect(report.passed).toBe(false);
    expect(report.errors).toContain("Slide 1 SVG page must contain exactly one p:pic; found 2.");

    const malformedPicture = picture!
      .replace(/<a:xfrm\b[^>]*>/i, '<a:xfrm rot="60000" flipH="1">')
      .replace(/<a:off\b[^>]*\/>/i, '<a:off x="1" y="0"/>')
      .replace('<a:ext cx="9144000" cy="5143500"/>', '<a:ext cx="9144001" cy="5143500"/>')
      .replace("<p:blipFill>", '<p:blipFill><a:srcRect l="1"/>');
    const malformedGeometry = xml
      .replace(picture!, malformedPicture)
      .replace("</p:spTree>", "<p:graphicFrame></p:graphicFrame></p:spTree>");
    archive.file("ppt/slides/slide1.xml", malformedGeometry);
    await writeFile(corruptedPath, await archive.generateAsync({ type: "nodebuffer" }));

    report = await inspectPptxExport(corruptedPath, presentation);
    expect(report.passed).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("must not contain native charts/tables"),
        "Slide 1 SVG picture must not be rotated.",
        "Slide 1 SVG picture must not be flipped.",
        expect.stringContaining("SVG picture offset must be (0,0)"),
        expect.stringContaining("SVG picture extent must be 9144000x5143500"),
        "Slide 1 SVG picture must not be cropped.",
      ]),
    );
  });

  it("accepts the exact SVG only when the picture's asvg:svgBlip owns its relationship", async () => {
    const directory = await mkdtemp(join(tmpdir(), "svg-page-postflight-svgblip-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "svg-deck.pptx");
    const corruptedPath = join(directory, "svg-deck-corrupted.pptx");
    const presentation = createStarterPresentation();
    presentation.slides = [svgSlide("slide-1", "Relationship", "slides/svg/P01.svg")];

    await exportToPptx(presentation, {}, filePath);
    const archive = await JSZip.loadAsync(await readFile(filePath));
    const slideFile = archive.file("ppt/slides/slide1.xml")!;
    const xml = await slideFile.async("string");
    const fallbackRelationshipId = xml.match(/<a:blip\b[^>]*\br:embed="([^"]+)"/i)?.[1];
    const svgRelationshipId = xml.match(/<asvg:svgBlip\b[^>]*\br:embed="([^"]+)"/i)?.[1];
    expect(fallbackRelationshipId).toBeDefined();
    expect(svgRelationshipId).toBeDefined();

    archive.file(
      "ppt/slides/slide1.xml",
      xml
        .replace(/(<asvg:svgBlip\b[^>]*\br:embed=")[^"]+/i, `$1${fallbackRelationshipId}`)
        .replace("</p:pic>", `<a:ext r:embed="${svgRelationshipId}"/></p:pic>`),
    );
    await writeFile(corruptedPath, await archive.generateAsync({ type: "nodebuffer" }));

    const report = await inspectPptxExport(corruptedPath, presentation);
    expect(report.passed).toBe(false);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "SVG picture's asvg:svgBlip is not related to its export background SVG",
        ),
      ]),
    );
  });

  it("rejects a non-canonical presentation slide size", async () => {
    const directory = await mkdtemp(join(tmpdir(), "svg-page-postflight-size-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "svg-deck.pptx");
    const corruptedPath = join(directory, "svg-deck-corrupted.pptx");
    const presentation = createStarterPresentation();
    presentation.slides = [svgSlide("slide-1", "Size", "slides/svg/P01.svg")];

    await exportToPptx(presentation, {}, filePath);
    const archive = await JSZip.loadAsync(await readFile(filePath));
    const presentationFile = archive.file("ppt/presentation.xml")!;
    const xml = await presentationFile.async("string");
    archive.file("ppt/presentation.xml", xml.replace('cx="9144000"', 'cx="9144001"'));
    await writeFile(corruptedPath, await archive.generateAsync({ type: "nodebuffer" }));

    const report = await inspectPptxExport(corruptedPath, presentation);
    expect(report.passed).toBe(false);
    expect(report.errors).toContain(
      "Presentation slide size must be 9144000x5143500, found 9144001x5143500.",
    );
  });

  it("warns instead of failing when the SVG picture fallback is not a valid PNG", async () => {
    const directory = await mkdtemp(join(tmpdir(), "svg-page-postflight-fallback-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "svg-deck.pptx");
    const corruptedPath = join(directory, "svg-deck-corrupted.pptx");
    const presentation = createStarterPresentation();
    presentation.slides = [svgSlide("slide-1", "Fallback", "slides/svg/P01.svg")];

    await exportToPptx(presentation, {}, filePath);
    const archive = await JSZip.loadAsync(await readFile(filePath));
    const pngPath = Object.keys(archive.files).find((path) =>
      /^ppt\/media\/[^/]+\.png$/i.test(path),
    );
    expect(pngPath).toBeDefined();
    archive.file(pngPath!, "not a PNG");
    await writeFile(corruptedPath, await archive.generateAsync({ type: "nodebuffer" }));

    const report = await inspectPptxExport(corruptedPath, presentation);
    expect(report.passed).toBe(true);
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("fallback media is not a valid PNG")]),
    );
  });
});

function svgSlide(id: string, text: string, sourcePath: string): Slide {
  const markup =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">' +
    `<rect width="1280" height="720" fill="#${createHash("sha256").update(id).digest("hex").slice(0, 6)}"/>` +
    `<text x="80" y="140" fill="#111827" font-size="64">${text}</text>` +
    "</svg>";
  return {
    id,
    title: text,
    narrative: {
      role: "evidence",
      coreMessage: text,
      audienceMove: "Understand",
      rhythm: "dense",
      layoutIntent: "One statement.",
    },
    visualSource: {
      kind: "svg" as const,
      markup,
      width: 1280 as const,
      height: 720 as const,
      sha256: createHash("sha256").update(markup, "utf8").digest("hex"),
      sourcePath,
      resources: [],
    },
  };
}
