import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureUiThemesDirectory,
  listUiThemes,
  readUiThemeCss,
  UI_THEME_ENTRY_FILE_NAME,
  UI_THEME_MAX_BYTES,
} from "@main/ui-themes";
import { DEFAULT_UI_THEME_ID } from "@shared/ui-themes";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createAppRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ppt-ui-themes-"));
  temporaryDirectories.push(root);
  return root;
}

function writeTheme(themesDirectory: string, id: string, css: string): void {
  const themeDirectory = join(themesDirectory, id);
  mkdirSync(themeDirectory, { recursive: true });
  writeFileSync(join(themeDirectory, UI_THEME_ENTRY_FILE_NAME), css, "utf8");
}

describe("ui themes directory", () => {
  it("creates themes/ with README and example/theme.css", async () => {
    const root = await createAppRoot();
    const themesDirectory = ensureUiThemesDirectory(root);

    expect(themesDirectory).toBe(join(root, "themes"));
    const themes = listUiThemes(root);
    expect(themes.some((theme) => theme.id === "example")).toBe(true);
    expect(themes.find((theme) => theme.id === "example")?.fileName).toBe(
      `example/${UI_THEME_ENTRY_FILE_NAME}`,
    );
    expect(readUiThemeCss("example", root)).toContain("--surface-canvas");
  });

  it("lists only first-level folders that contain theme.css", async () => {
    const root = await createAppRoot();
    const themesDirectory = ensureUiThemesDirectory(root);
    writeTheme(themesDirectory, "midnight", ":root { --surface-canvas: #000; }");
    writeTheme(themesDirectory, "午夜蓝", ":root { --surface-canvas: #001; }");
    writeTheme(themesDirectory, "studio", ":root { --surface-canvas: #111; }");
    writeTheme(themesDirectory, "catnip", ":root { --surface-canvas: #222; }");
    writeFileSync(join(themesDirectory, "legacy-flat.css"), ":root{}", "utf8");
    mkdirSync(join(themesDirectory, "empty-folder"), { recursive: true });
    mkdirSync(join(themesDirectory, "nested", "hidden"), { recursive: true });
    writeFileSync(
      join(themesDirectory, "nested", "hidden", UI_THEME_ENTRY_FILE_NAME),
      ":root{}",
      "utf8",
    );

    const themes = listUiThemes(root);
    const ids = themes.map((theme) => theme.id);
    expect(ids).toContain("midnight");
    expect(ids).toContain("example");
    expect(ids).toContain("午夜蓝");
    expect(ids).not.toContain(DEFAULT_UI_THEME_ID);
    expect(ids).not.toContain("catnip");
    expect(ids).not.toContain("empty-folder");
    expect(ids).not.toContain("hidden");
    expect(ids).not.toContain("legacy-flat");
  });

  it("rejects path traversal and invalid ids when reading", async () => {
    const root = await createAppRoot();
    ensureUiThemesDirectory(root);

    expect(readUiThemeCss("../secrets", root)).toBeNull();
    expect(readUiThemeCss("..\\secrets", root)).toBeNull();
    expect(readUiThemeCss("studio", root)).toBeNull();
    expect(readUiThemeCss("catnip", root)).toBeNull();
    expect(readUiThemeCss("", root)).toBeNull();
    expect(readUiThemeCss("a/b", root)).toBeNull();
  });

  it("rejects oversized theme.css files", async () => {
    const root = await createAppRoot();
    const themesDirectory = ensureUiThemesDirectory(root);
    writeTheme(themesDirectory, "huge", "x".repeat(UI_THEME_MAX_BYTES + 1));

    expect(listUiThemes(root).some((theme) => theme.id === "huge")).toBe(true);
    expect(readUiThemeCss("huge", root)).toBeNull();
  });
});
