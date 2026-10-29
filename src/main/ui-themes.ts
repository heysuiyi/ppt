import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { UiThemeSummary } from "@shared/ipc";
import { BUILTIN_UI_THEME_IDS } from "@shared/ui-themes";
import { getApplicationDataRoot } from "./application-data";

export type { UiThemeSummary };

export const UI_THEMES_DIRECTORY_NAME = "themes";
export const UI_THEME_ENTRY_FILE_NAME = "theme.css";
export const UI_THEME_MAX_BYTES = 256 * 1024;

/** Directory name = theme id. Unicode letters/numbers plus - _ ; no dots or separators. */
const THEME_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

const THEMES_README = `# UI themes

Put each workbench theme in its own folder under this directory:

\`\`\`text
themes/
  example/
    theme.css
  my-theme/
    theme.css
\`\`\`

The folder name is the theme id. Only folders that contain \`theme.css\` are listed.

Open this root from Settings → 界面外观 → 打开主题根目录, then refresh the list.

## Stable contract (recommended)

Override semantic CSS variables for light/dark in \`theme.css\`. Use the
\`:root[data-skin][data-color-scheme="…"]\` form: the built-in skin defines the
palette at that same specificity, so a plain \`:root[data-color-scheme="…"]\`
block loses the cascade and its colors silently do nothing.

\`\`\`css
:root[data-skin][data-color-scheme="dark"] {
  --surface-canvas: #0f1419;
  --surface-base: #1b222c;
  --surface-raised: #151b22;
  --surface-sunken: #212a35;
  --surface-overlay: #27313d;
  --text-primary: #f3f6fa;
  --text-secondary: #a8b3c2;
  --text-muted: #a0adbf;
  --border-subtle: rgba(255, 255, 255, 0.06);
  --border-default: rgba(255, 255, 255, 0.1);
  --accent-action-bg: #0369a1;
  --text-on-accent: #ffffff;
  --accent-link-text: #38bdf8;
  --border-focused: #38bdf8;
}

:root[data-skin][data-color-scheme="light"] {
  --surface-canvas: #e7ebf0;
  --surface-base: #eef1f5;
  --surface-raised: #ffffff;
  --surface-sunken: #f3f5f8;
  --surface-overlay: #ffffff;
  --text-primary: #12161c;
  --text-secondary: #4a5563;
  --text-muted: #596372;
  --border-subtle: rgba(0, 0, 0, 0.06);
  --border-default: rgba(0, 0, 0, 0.1);
  --accent-action-bg: #0369a1;
  --text-on-accent: #ffffff;
  --accent-link-text: #0369a1;
  --border-focused: #0369a1;
}
\`\`\`

Keep identity color, readable links and solid-action backgrounds separate.
Check normal text at 4.5:1 against its actual composited surface, including
selected and hover states. Do not reduce every dark-mode font weight.
User font/size choices take precedence through root inline variables.
Shared geometry roles include field/button/card/panel/popover radii,
control-height-sm/md, card-padding and layout-gap-compact/default.
Native caption colors and panel resize geometry are not theme parameters.

## Deep customization

Prefer region hooks:

- \`[data-ui-region="sidebar"]\`
- \`[data-ui-region="composer"]\`
- \`[data-ui-region="canvas"]\`
- \`[data-ui-region="settings"]\`

Relative \`url(./asset.png)\` inside the theme folder is not loaded yet — use \`https:\` or \`data:\` for images.
The built-in ids \`studio\` and \`catnip\` cannot be used as folder names.
`;

const EXAMPLE_THEME_CSS = `/*
 * example — token-only workbench theme for verifying UI theme loading.
 * Path: ~/.agent-ppt/themes/example/theme.css
 * Select it in Settings → 界面外观.
 *
 * The [data-skin] part is required: the built-in skin defines the same
 * variables at that specificity, so a plain :root[data-color-scheme] block
 * would lose the cascade.
 */

:root[data-skin][data-color-scheme="dark"] {
  --surface-canvas: #0f1419;
  --surface-base: #1b222c;
  --surface-raised: #151b22;
  --surface-sunken: #212a35;
  --surface-overlay: #27313d;
  --surface-hover: rgba(255, 255, 255, 0.06);
  --surface-active: rgba(255, 255, 255, 0.1);

  --text-primary: #f3f6fa;
  --text-secondary: #a8b3c2;
  --text-muted: #a0adbf;

  --border-subtle: rgba(255, 255, 255, 0.06);
  --border-default: rgba(255, 255, 255, 0.1);
  --border-strong: rgba(255, 255, 255, 0.16);
  --border-focused: #38bdf8;
  --accent-action-bg: #0369a1;
  --text-on-accent: #ffffff;
  --accent-link-text: #38bdf8;
}

:root[data-skin][data-color-scheme="light"] {
  --surface-canvas: #dde3ea;
  --surface-base: #e7ecf2;
  --surface-raised: #f7f9fc;
  --surface-sunken: #eef2f7;
  --surface-overlay: #ffffff;
  --surface-hover: rgba(0, 0, 0, 0.04);
  --surface-active: rgba(0, 0, 0, 0.07);

  --text-primary: #12161c;
  --text-secondary: #4a5563;
  --text-muted: #596372;

  --border-subtle: rgba(0, 0, 0, 0.06);
  --border-default: rgba(0, 0, 0, 0.1);
  --border-strong: rgba(0, 0, 0, 0.14);
  --border-focused: #0369a1;
  --accent-action-bg: #0369a1;
  --text-on-accent: #ffffff;
  --accent-link-text: #0369a1;
}
`;

export function getUiThemesDirectory(applicationDataRoot?: string): string {
  return join(applicationDataRoot ?? getApplicationDataRoot(), UI_THEMES_DIRECTORY_NAME);
}

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
  const resolvedCandidate = resolve(candidatePath);
  const resolvedDirectory = resolve(directoryPath);
  return (
    resolvedCandidate === resolvedDirectory || resolvedCandidate.startsWith(resolvedDirectory + sep)
  );
}

export function isValidUiThemeId(id: string): boolean {
  if (typeof id !== "string" || !id.trim() || id !== id.trim()) return false;
  if (BUILTIN_UI_THEME_IDS.has(id)) return false;
  if (id.includes("\0") || id.includes("/") || id.includes("\\") || id.includes("..")) {
    return false;
  }
  return THEME_ID_PATTERN.test(id);
}

function themeDisplayName(id: string): string {
  if (/^[\u4e00-\u9fff]/u.test(id) || !/[-_]/.test(id)) {
    return id;
  }
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveThemeCssPath(themesDirectory: string, id: string): string | null {
  if (!isValidUiThemeId(id)) return null;
  const themeDirectory = resolve(themesDirectory, id);
  if (!isPathInsideDirectory(themeDirectory, themesDirectory)) return null;
  if (basename(themeDirectory) !== id) return null;

  const filePath = resolve(themeDirectory, UI_THEME_ENTRY_FILE_NAME);
  if (!isPathInsideDirectory(filePath, themeDirectory)) return null;
  if (basename(filePath) !== UI_THEME_ENTRY_FILE_NAME) return null;
  return filePath;
}

export function ensureUiThemesDirectory(applicationDataRoot?: string): string {
  const themesDirectory = getUiThemesDirectory(applicationDataRoot);
  mkdirSync(themesDirectory, { recursive: true });

  const readmePath = join(themesDirectory, "README.md");
  try {
    statSync(readmePath);
  } catch {
    writeFileSync(readmePath, THEMES_README, "utf8");
  }

  const exampleDirectory = join(themesDirectory, "example");
  mkdirSync(exampleDirectory, { recursive: true });
  const examplePath = join(exampleDirectory, UI_THEME_ENTRY_FILE_NAME);
  try {
    statSync(examplePath);
  } catch {
    writeFileSync(examplePath, EXAMPLE_THEME_CSS, "utf8");
  }

  return themesDirectory;
}

export function listUiThemes(applicationDataRoot?: string): UiThemeSummary[] {
  const themesDirectory = ensureUiThemesDirectory(applicationDataRoot);
  let entries: string[];
  try {
    entries = readdirSync(themesDirectory);
  } catch {
    return [];
  }

  const themes: UiThemeSummary[] = [];
  for (const entryName of entries) {
    if (entryName.startsWith("README")) continue;
    if (!isValidUiThemeId(entryName)) continue;

    const themeDirectory = join(themesDirectory, entryName);
    let directoryStats;
    try {
      directoryStats = statSync(themeDirectory);
    } catch {
      continue;
    }
    if (!directoryStats.isDirectory()) continue;

    const entryPath = join(themeDirectory, UI_THEME_ENTRY_FILE_NAME);
    try {
      const entryStats = statSync(entryPath);
      if (!entryStats.isFile()) continue;
    } catch {
      continue;
    }

    themes.push({
      id: entryName,
      name: themeDisplayName(entryName),
      fileName: `${entryName}/${UI_THEME_ENTRY_FILE_NAME}`,
    });
  }

  return themes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function readUiThemeCss(id: string, applicationDataRoot?: string): string | null {
  const themesDirectory = ensureUiThemesDirectory(applicationDataRoot);
  const filePath = resolveThemeCssPath(themesDirectory, id);
  if (!filePath) return null;

  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size > UI_THEME_MAX_BYTES) return null;

  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
