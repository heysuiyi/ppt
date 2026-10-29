import { z } from "zod";

import { createLayoutTokens } from "./catalog";

/**
 * Design System v2 separates the deck's argument, visual language, colors, and
 * reading density. Catalog data is adapted from ppt-master's MIT-licensed
 * there is no live `skills/ppt-master/` tree in this repository.
 */
export const ARGUMENT_MODES = [
  "pyramid",
  "narrative",
  "instructional",
  "showcase",
  "briefing",
] as const;

export const VISUAL_STYLES = [
  "swiss-minimal",
  "soft-rounded",
  "glassmorphism",
  "dark-tech",
  "blueprint",
  "editorial",
  "photo-editorial",
  "data-journalism",
  "brutalist",
  "memphis",
  "zine",
  "vintage-poster",
  "paper-cut",
  "sketch-notes",
  "ink-notes",
  "chalkboard",
  "ink-wash",
  "pixel-art",
] as const;

export const READING_MODES = ["text", "balanced", "presentation"] as const;

/**
 * Named schemes are convenience starting points, not part of a visual style.
 * A fully custom six-anchor scheme is also accepted by colorSchemeSchema.
 */
export const COLOR_SCHEMES = [
  "business-blue",
  "warm-paper",
  "mono-report",
  "tech-dark",
  "soft-academic",
] as const;

// Executable layout projections consumed by the layout/rendering engine.
export const DESIGN_PALETTES = COLOR_SCHEMES;
export const FONT_MOODS = ["formal", "editorial", "technical", "warm", "minimal"] as const;
export const SHAPE_LANGUAGES = ["cards", "annotation", "geometric", "path", "editorial"] as const;
export const BACKGROUND_STYLES = ["clean", "paper", "grid", "gradient", "dark"] as const;
export const MOTIFS = [
  "none",
  "bookmark",
  "chapter-number",
  "arc",
  "path-line",
  "margin-note",
] as const;
export const DENSITIES = ["calm", "standard", "dense"] as const;
export const IMAGE_TREATMENTS = ["plain", "framed", "masked", "captioned"] as const;
export const CHART_STYLES = ["minimal", "report", "dashboard", "editorial"] as const;

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, "Expected a six-digit HEX color such as #1d4ed8.");

/**
 * The six semantic anchors used by ppt-master. They intentionally remain
 * independent from visualStyle so any palette can skin any visual grammar.
 */
export const customColorSchemeSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    background: hexColorSchema,
    secondaryBg: hexColorSchema,
    primary: hexColorSchema,
    accent: hexColorSchema,
    secondaryAccent: hexColorSchema,
    bodyText: hexColorSchema,
    surface: hexColorSchema.optional(),
    grid: hexColorSchema.optional(),
    scrim: hexColorSchema.optional(),
  })
  .strict();

export const colorSchemeSchema = z.union([z.enum(COLOR_SCHEMES), customColorSchemeSchema]);

/**
 * User overrides are applied after both the selected scheme and light/dark
 * surface adaptation. Anchor names are canonical; renderer-role aliases make
 * the override useful to callers that need a precise card/title treatment.
 */
export const colorOverridesSchema = z
  .object({
    background: hexColorSchema.optional(),
    secondaryBg: hexColorSchema.optional(),
    secondaryBackground: hexColorSchema.optional(),
    primary: hexColorSchema.optional(),
    accent: hexColorSchema.optional(),
    secondaryAccent: hexColorSchema.optional(),
    bodyText: hexColorSchema.optional(),
    surface: hexColorSchema.optional(),
    grid: hexColorSchema.optional(),
    scrim: hexColorSchema.optional(),
    bg: hexColorSchema.optional(),
    title: hexColorSchema.optional(),
    body: hexColorSchema.optional(),
    cardBg: hexColorSchema.optional(),
    cardStroke: hexColorSchema.optional(),
    muted: hexColorSchema.optional(),
    softAccent: hexColorSchema.optional(),
  })
  .strict();

export const designTokensSchema = z
  .object({
    palette: z.enum(DESIGN_PALETTES),
    fontMood: z.enum(FONT_MOODS),
    shapeLanguage: z.enum(SHAPE_LANGUAGES),
    backgroundStyle: z.enum(BACKGROUND_STYLES),
    motif: z.enum(MOTIFS),
    density: z.enum(DENSITIES),
    imageTreatment: z.enum(IMAGE_TREATMENTS),
    chartStyle: z.enum(CHART_STYLES),
  })
  .strict();

const designSystemV2SourceSchema = z
  .object({
    version: z.literal(2),
    argumentMode: z.enum(ARGUMENT_MODES),
    visualStyle: z.enum(VISUAL_STYLES),
    colorScheme: colorSchemeSchema,
    readingMode: z.enum(READING_MODES),
    colors: colorOverridesSchema.optional(),
  })
  .strict();

export type ArgumentMode = (typeof ARGUMENT_MODES)[number];
export type VisualStyle = (typeof VISUAL_STYLES)[number];
export type ReadingMode = (typeof READING_MODES)[number];
export type NamedColorScheme = (typeof COLOR_SCHEMES)[number];
export type CustomColorScheme = z.infer<typeof customColorSchemeSchema>;
export type ColorScheme = z.infer<typeof colorSchemeSchema>;
export type ColorOverrides = z.infer<typeof colorOverridesSchema>;
export type DesignTokens = z.infer<typeof designTokensSchema>;
export type DesignPalette = (typeof DESIGN_PALETTES)[number];
export type FontMood = (typeof FONT_MOODS)[number];
export type ShapeLanguage = (typeof SHAPE_LANGUAGES)[number];
export type BackgroundStyle = (typeof BACKGROUND_STYLES)[number];
export type Motif = (typeof MOTIFS)[number];
export type Density = (typeof DENSITIES)[number];
export type ImageTreatment = (typeof IMAGE_TREATMENTS)[number];
export type ChartStyle = (typeof CHART_STYLES)[number];

export type DesignSystemV2 = z.infer<typeof designSystemV2SourceSchema>;

/** The only accepted persisted schema is the strict, source-only v2 shape. */
export const designSystemV2Schema = designSystemV2SourceSchema;

const visualTokenOverrideShape = designTokensSchema.partial().shape;

export const slideDesignOverrideSchema = z
  .object({
    visualStyle: z.enum(VISUAL_STYLES).optional(),
    colorScheme: colorSchemeSchema.optional(),
    readingMode: z.enum(READING_MODES).optional(),
    colors: colorOverridesSchema.optional(),
    ...visualTokenOverrideShape,
  })
  .strict();

export type SlideDesignOverride = z.infer<typeof slideDesignOverrideSchema>;

export const DEFAULT_DESIGN_SYSTEM: DesignSystemV2 = designSystemV2Schema.parse({
  version: 2,
  argumentMode: "pyramid",
  visualStyle: "swiss-minimal",
  colorScheme: "business-blue",
  readingMode: "balanced",
});

export function parseDesignSystem(input: unknown): DesignSystemV2 {
  return designSystemV2Schema.parse(input);
}

const DESIGN_TOKEN_KEYS = [
  "palette",
  "fontMood",
  "shapeLanguage",
  "backgroundStyle",
  "motif",
  "density",
  "imageTreatment",
  "chartStyle",
] as const satisfies readonly (keyof DesignTokens)[];

export function resolveDesignTokens(
  system: DesignSystemV2,
  override?: SlideDesignOverride,
): DesignTokens {
  const style = override?.visualStyle ?? system.visualStyle;
  const readingMode = override?.readingMode ?? system.readingMode;
  const colorScheme = override?.colorScheme ?? system.colorScheme;
  const base = createLayoutTokens(style, readingMode, colorScheme);
  const tokenOverrides = Object.fromEntries(
    DESIGN_TOKEN_KEYS.flatMap((key) => (override?.[key] == null ? [] : [[key, override[key]]])),
  );
  return designTokensSchema.parse({ ...base, ...tokenOverrides });
}
