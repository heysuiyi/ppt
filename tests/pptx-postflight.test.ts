import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportToPptx } from "../src/ppt/core/ppt-exporter";
import { inspectPptxExport } from "../src/ppt/core/pptx-postflight";
import type { SlideNarrative } from "../src/shared/presentation";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

const tempDirs: string[] = [];

const NARRATIVE: SlideNarrative = {
  role: "cover",
  coreMessage: "Postflight smoke test",
  audienceMove: "Review the export",
  rhythm: "anchor",
  layoutIntent: "One full-page SVG slide.",
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function exportReadyPresentation() {
  const presentation = createStarterPresentation();
  presentation.slides[0].narrative = NARRATIVE;
  return presentation;
}

describe("PPTX postflight", () => {
  it("verifies SVG slide parts and exact source presence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-postflight-"));
    tempDirs.push(dir);
    const path = join(dir, "svg-deck.pptx");
    const presentation = exportReadyPresentation();

    await exportToPptx(presentation, {}, path);
    const report = await inspectPptxExport(path, presentation);

    expect(report.passed).toBe(true);
    expect(report.slideCount).toBe(1);
    expect(report.slides[0]).toMatchObject({
      pictures: 1,
      graphicFrames: 0,
      svgSourcePresent: true,
      titlePresent: true,
    });
    expect(report.slides[0].textRuns).toBeGreaterThanOrEqual(1);
    expect(report.slides[0].shapes).toBeGreaterThanOrEqual(1);
    expect(report.totals.editableObjects).toBeGreaterThan(1);
  });

  it("verifies speaker notes for SVG pages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-postflight-notes-"));
    tempDirs.push(dir);
    const path = join(dir, "svg-notes.pptx");
    const presentation = exportReadyPresentation();
    presentation.slides[0].speakerNotes = "Explain the revenue inflection and ask for approval.";

    await exportToPptx(presentation, {}, path);
    const report = await inspectPptxExport(path, presentation);

    expect(report.passed).toBe(true);
    expect(report.notesPartCount).toBe(1);
    expect(report.chartPartCount).toBe(0);
  });

  it("rejects a non-ZIP file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pptx-postflight-invalid-"));
    tempDirs.push(dir);
    const path = join(dir, "invalid.pptx");
    await writeFile(path, "not a pptx", "utf8");

    await expect(inspectPptxExport(path, exportReadyPresentation())).rejects.toThrow(
      "not a ZIP-based Office document",
    );
  });
});
