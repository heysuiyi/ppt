import {
  DEFAULT_TEXT_SCALE,
  DEFAULT_UI_FONT_FAMILY,
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_UI_LINE_HEIGHT,
  FONT_FAMILY_STACKS,
  FONT_FAMILY_VARS,
  roundUiTypographyValue,
  type UiFontFamily,
} from "@shared/ui-typography";

export type { UiFontFamily } from "@shared/ui-typography";
export {
  DEFAULT_UI_FONT_FAMILY,
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_UI_LINE_HEIGHT,
  MAX_UI_FONT_SIZE,
  MAX_UI_LINE_HEIGHT,
  MIN_UI_FONT_SIZE,
  MIN_UI_LINE_HEIGHT,
  normalizePersistedUiFontFamily,
  normalizePersistedUiFontSize,
  normalizePersistedUiLineHeight,
} from "@shared/ui-typography";

const DEFAULT_TYPOGRAPHY_STYLE_ID = "ui-typography-defaults";
const DEFAULT_TYPOGRAPHY_CSS = `:root{${DEFAULT_TEXT_SCALE.map(
  (step) => `--text-${step.name}:${step.size}px;--text-${step.name}-lh:${step.lineHeight}px;`,
).join("")}}`;

/** Lowest-priority defaults: themes can override them without inline styles. */
export function installUiTypographyDefaults(): void {
  if (typeof document === "undefined") return;
  let sheet = document.getElementById(DEFAULT_TYPOGRAPHY_STYLE_ID);
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = DEFAULT_TYPOGRAPHY_STYLE_ID;
    document.head.prepend(sheet);
  }
  if (sheet.textContent !== DEFAULT_TYPOGRAPHY_CSS) {
    sheet.textContent = DEFAULT_TYPOGRAPHY_CSS;
  }
}

/**
 * Writes font/size CSS variables as inline styles on :root.
 * Default values remove the inline overrides so stylesheet tokens take over again.
 */
export function applyUiTypography(
  family: UiFontFamily,
  fontSize: number,
  lineHeight: number,
): void {
  if (typeof document === "undefined") return;
  installUiTypographyDefaults();

  const root = document.documentElement;

  if (family === DEFAULT_UI_FONT_FAMILY) {
    for (const name of FONT_FAMILY_VARS) {
      root.style.removeProperty(name);
    }
  } else {
    const stacks = FONT_FAMILY_STACKS[family];
    root.style.setProperty("--font-display", stacks.display);
    root.style.setProperty("--font-body", stacks.body);
  }

  const isDefaultScale = fontSize === DEFAULT_UI_FONT_SIZE && lineHeight === DEFAULT_UI_LINE_HEIGHT;

  if (isDefaultScale) {
    for (const step of DEFAULT_TEXT_SCALE) {
      root.style.removeProperty(`--text-${step.name}`);
      root.style.removeProperty(`--text-${step.name}-lh`);
    }
    return;
  }

  const sizeScale = fontSize / DEFAULT_UI_FONT_SIZE;
  const leadingScale = lineHeight / DEFAULT_UI_LINE_HEIGHT;

  for (const step of DEFAULT_TEXT_SCALE) {
    root.style.setProperty(
      `--text-${step.name}`,
      `${roundUiTypographyValue(step.size * sizeScale)}px`,
    );
    root.style.setProperty(
      `--text-${step.name}-lh`,
      `${roundUiTypographyValue(step.lineHeight * sizeScale * leadingScale)}px`,
    );
  }
}
