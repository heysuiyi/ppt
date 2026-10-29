export type UiFontFamily = "system" | "yahei" | "pingfang" | "segoe";

export const DEFAULT_UI_FONT_FAMILY: UiFontFamily = "system";
/** Base UI size in px; drives the renderer's default --text-base. */
export const DEFAULT_UI_FONT_SIZE = 13;
/** Base leading multiplier; the default base line box is 21px. */
export const DEFAULT_UI_LINE_HEIGHT = 1.6;

export const MIN_UI_FONT_SIZE = 11;
export const MAX_UI_FONT_SIZE = 20;
export const MIN_UI_LINE_HEIGHT = 1.2;
export const MAX_UI_LINE_HEIGHT = 2.2;

const SYSTEM_FONT_STACK =
  'system-ui, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", sans-serif';

export const FONT_FAMILY_STACKS: Record<UiFontFamily, { display: string; body: string }> = {
  system: {
    display: SYSTEM_FONT_STACK,
    body: SYSTEM_FONT_STACK,
  },
  yahei: {
    display:
      '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif',
    body: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif',
  },
  pingfang: {
    display: '"PingFang SC", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif',
    body: '"PingFang SC", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif',
  },
  segoe: {
    display: '"Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif',
    body: '"Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif',
  },
};

/**
 * Single default size/leading source for the renderer stylesheet and overrides.
 * Each step retains its own leading character; user settings scale the table
 * rather than flattening badges and prose to one line-height ratio.
 */
export const DEFAULT_TEXT_SCALE: Array<{ name: string; size: number; lineHeight: number }> = [
  { name: "2xs", size: 10, lineHeight: 14 },
  { name: "xs", size: 11, lineHeight: 16 },
  { name: "sm", size: 12, lineHeight: 19 },
  { name: "base", size: 13, lineHeight: 21 },
  { name: "md", size: 14, lineHeight: 23 },
  { name: "lg", size: 16, lineHeight: 26 },
  { name: "xl", size: 20, lineHeight: 30 },
  { name: "2xl", size: 24, lineHeight: 34 },
];

export const FONT_FAMILY_VARS = ["--font-display", "--font-body"] as const;

export function roundUiTypographyValue(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizePersistedUiFontFamily(value: unknown): UiFontFamily {
  if (value === "yahei" || value === "pingfang" || value === "segoe" || value === "system") {
    return value;
  }
  return DEFAULT_UI_FONT_FAMILY;
}

export function normalizePersistedUiFontSize(value: unknown): number {
  const size = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(size)) return DEFAULT_UI_FONT_SIZE;
  return roundUiTypographyValue(clamp(size, MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE));
}

export function normalizePersistedUiLineHeight(value: unknown): number {
  const lineHeight = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(lineHeight)) return DEFAULT_UI_LINE_HEIGHT;
  return roundUiTypographyValue(clamp(lineHeight, MIN_UI_LINE_HEIGHT, MAX_UI_LINE_HEIGHT));
}
