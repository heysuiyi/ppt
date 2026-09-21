import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { proveExistingExport } from "../src/main/deck/export-recovery";
import { exportToPptx } from "../src/ppt/core/ppt-exporter";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("export crash recovery proof", () => {
  it("proves an exact Presentation JSON and rejects changed content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppt-export-recovery-json-"));
    directories.push(directory);
    const filePath = join(directory, "deck.json");
    const presentation = createStarterPresentation();
    await writeFile(filePath, JSON.stringify(presentation, null, 2), "utf8");

    await expect(proveExistingExport(filePath, "json", presentation, {})).resolves.toMatchObject({
      passed: true,
      validator: "canonical-presentation-json",
      slideCount: presentation.slides.length,
    });

    await expect(
      proveExistingExport(filePath, "json", { ...presentation, title: "Different revision" }, {}),
    ).resolves.toBeUndefined();
  });

  it("proves a structurally valid PPTX but never guesses for HTML", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppt-export-recovery-pptx-"));
    directories.push(directory);
    const filePath = join(directory, "deck.pptx");
    const presentation = createStarterPresentation();
    await exportToPptx(presentation, {}, filePath);

    await expect(proveExistingExport(filePath, "pptx", presentation, {})).resolves.toMatchObject({
      passed: true,
      validator: "pptx-postflight",
      slideCount: presentation.slides.length,
    });
    await expect(proveExistingExport(filePath, "html", presentation, {})).resolves.toBeUndefined();
    await expect(
      proveExistingExport(filePath, "pptx", presentation, { allowUnverifiedAssets: true }),
    ).resolves.toBeUndefined();
  });
});
