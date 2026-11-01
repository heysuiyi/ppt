import {
  ARGUMENT_MODES,
  getArgumentModeDefinition,
  getReadingModeDefinition,
  getVisualStyleDefinition,
  READING_MODES,
  SVG_COMPOSITION_DISCIPLINE,
  VISUAL_STYLES,
} from "@design-system";
import { DESIGN_CAPABILITY_VERSION } from "@shared/design-capability";
import { TEMPLATE_PACK_PATH } from "@shared/template-protocol";
import { z } from "zod";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";
import { requirePptCapability } from "../context";
import { loadProjectTemplatePack } from "./project-template-state";

export const getDesignReferenceSchema = z
  .object({
    argumentMode: z.enum(ARGUMENT_MODES),
    visualStyle: z.enum(VISUAL_STYLES),
    readingMode: z.enum(READING_MODES),
  })
  .strict();

/**
 * Exposes executable mode/style guidance from the inlined DesignSystem catalog.
 * When design/template-pack.json is active, pack colors/fonts/chrome/mustUse
 * override builtin look-and-feel so GetDesignReference cannot wash out an
 * uploaded reference template.
 */
export const getDesignReferenceTool: ToolDefinition<
  typeof getDesignReferenceSchema,
  Awaited<ReturnType<typeof resolveReference>>
> = {
  name: "GetDesignReference",
  description:
    "在写 SVG 前读取已锁定 argument mode、visual style、reading mode 的完整执行参考：" +
    "论证骨架、标题语气、构图几何、留白、字体、质感、图像语言与明确禁用项。" +
    "若 workspace 存在 design/template-pack.json，返回值会合并 pack 的配色/字体/chrome/mustUse，" +
    "不得用内置样板覆盖参考模板外观。",
  category: "core",
  loadPolicy: "core",
  inputSchema: getDesignReferenceSchema,
  validateContext: requirePptCapability(["create", "edit", "restyle"]),
  risk: "low",
  execute: async (args, context) => resolveReference(args, context.fileService),
};

async function resolveReference(
  args: z.infer<typeof getDesignReferenceSchema>,
  fileService: Parameters<typeof loadProjectTemplatePack>[0],
) {
  const argument = getArgumentModeDefinition(args.argumentMode);
  const style = getVisualStyleDefinition(args.visualStyle);
  const reading = getReadingModeDefinition(args.readingMode);
  const pack = await loadProjectTemplatePack(fileService);

  if (pack) {
    if (
      args.argumentMode !== pack.designSystem.argumentMode ||
      args.visualStyle !== pack.designSystem.visualStyle ||
      args.readingMode !== pack.designSystem.readingMode
    ) {
      throw new Error(
        `${TEMPLATE_PACK_PATH} is active; GetDesignReference axes must be ` +
          `${pack.designSystem.argumentMode}/${pack.designSystem.visualStyle}/` +
          `${pack.designSystem.readingMode} (got ${args.argumentMode}/` +
          `${args.visualStyle}/${args.readingMode}).`,
      );
    }
  }

  const colorScheme = pack?.designSystem.colorScheme;
  const paletteNote =
    colorScheme && typeof colorScheme !== "string"
      ? {
          name: colorScheme.name,
          background: colorScheme.background,
          secondaryBg: colorScheme.secondaryBg,
          primary: colorScheme.primary,
          accent: colorScheme.accent,
          secondaryAccent: colorScheme.secondaryAccent,
          bodyText: colorScheme.bodyText,
        }
      : undefined;

  return {
    capabilityVersion: DESIGN_CAPABILITY_VERSION,
    argument: {
      id: argument.id,
      label: argument.label,
      narrativeSkeleton: argument.narrativeSkeleton,
      titleVoice: argument.titleVoice,
      pageStructures: argument.pageStructures,
      speakerNotesRegister: argument.speakerNotesRegister,
      hardRules: argument.hardRules,
      antiPatterns: argument.antiPatterns,
      titleExamples: argument.titleExamples,
      pageSkeletons: argument.pageSkeletons,
    },
    visual: {
      id: style.id,
      label: style.label,
      summary: pack
        ? `${style.summary} Template pack "${pack.name}" overrides colors/fonts/chrome.`
        : style.summary,
      bestFor: style.bestFor,
      shape: style.shape,
      elevation: style.elevation,
      whitespace: style.whitespace,
      typography: pack
        ? {
            ...style.typography,
            headingFamily: pack.typography.title,
            bodyFamily: pack.typography.body,
            dataFamily: pack.typography.data,
            packRoles: pack.typography,
          }
        : style.typography,
      background: pack?.chrome?.background?.fill
        ? {
            ...style.background,
            fillHint: pack.chrome.background.fill,
            kind: pack.chrome.background.kind,
          }
        : style.background,
      texture: style.texture,
      composition: style.grammarPreferences.composition,
      compositionDiscipline: SVG_COMPOSITION_DISCIPLINE,
      avoid: [...style.grammarPreferences.avoid, ...(pack?.authoringGuidance.avoid ?? [])],
      imageLanguage: {
        rendering: style.imageRendering,
        treatment: style.imageTreatment,
        illustrationPropensity: style.illustrationPropensity,
      },
      packPalette: paletteNote,
      packChrome: pack?.chrome ?? null,
      packAssets: pack?.assets ?? [],
      packMustUse: pack?.authoringGuidance.mustUse ?? [],
      packInheritance: pack?.inheritance ?? null,
    },
    reading: {
      id: reading.id,
      label: reading.label,
      bodySize: reading.bodySize,
      density: reading.density,
      spacingScale: reading.spacingScale,
      typographyScale: reading.typographyScale,
      maxBodyCharacters: reading.maxBodyCharacters,
      visualBurden: reading.visualBurden,
    },
    authoringDirective: pack
      ? `Active template pack ${pack.templateId}@${pack.revisionId}. ` +
        "Use packPalette HEX, packRoles fonts, packChrome anchors and packAssets paths. " +
        "Builtin visualStyle only supplies composition discipline — do not replace the pack look."
      : "Translate this behavior into page-specific SVG composition. Keep the deck-wide language, " +
        "but do not copy a fixed coordinate template or repeat one card grid across pages.",
    templatePackPath: pack ? TEMPLATE_PACK_PATH : null,
  };
}
