import { type Presentation, presentationSchema } from "@shared/presentation";
import {
  auditPresentationVisualAssets,
  type PresentationVisualAssetAudit,
} from "@shared/visual-asset-audit";
import { z } from "zod";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";
import { requirePresentation } from "../context";

export const readPresentationSnapshotSchema = z.object({});
export const readPresentationSnapshotOutputSchema = z.object({
  presentation: presentationSchema,
  visualAssetAudit: z.object({
    slides: z.array(
      z.object({
        slideId: z.string(),
        title: z.string(),
        status: z.enum(["missing-required", "missing-recommended", "satisfied", "not-needed"]),
        existingImageCount: z.number().int().nonnegative(),
        availableSlots: z.array(z.string()),
        suggestedSlot: z.string().optional(),
        suggestedQuery: z.string().optional(),
        reason: z.string(),
      }),
    ),
    imageSlideCount: z.number().int().nonnegative(),
    totalImageCount: z.number().int().nonnegative(),
    missingRequiredCount: z.number().int().nonnegative(),
    missingRecommendedCount: z.number().int().nonnegative(),
    duplicateImageUrls: z.array(z.string()),
    nextAction: z.string(),
  }),
});

/**
 * Core Tool: 读取整套 PPT 的只读快照与摘要。
 * 用于全局美化、结构理解和未指定页码的请求。
 * 只返回必要摘要，不修改 Presentation，不返回可写引用。
 */
export const readPresentationSnapshotTool: ToolDefinition<
  typeof readPresentationSnapshotSchema,
  { presentation: Presentation; visualAssetAudit: PresentationVisualAssetAudit }
> = {
  name: "ReadPresentationSnapshot",
  description:
    "读取整套演示文稿，并返回 SVG 页面摘要与视觉素材审计；有缺图项时按 nextAction 主动搜图。",
  category: "core",
  loadPolicy: "core",
  inputSchema: readPresentationSnapshotSchema,
  behavior: { concurrency: { mode: "parallel" } },
  outputSchema: readPresentationSnapshotOutputSchema,
  mapResultToModelContent: (result) =>
    JSON.stringify({
      presentation: {
        id: result.presentation.id,
        title: result.presentation.title,
        revision: result.presentation.revision,
        designSystem: result.presentation.designSystem,
        slides: result.presentation.slides.map((slide, index) => ({
          id: slide.id,
          index,
          title: slide.title,
          speakerNotes: slide.speakerNotes,
          narrative: slide.narrative,
          svgPage:
            slide.visualSource?.kind === "svg"
              ? {
                  sourcePath: slide.visualSource.sourcePath,
                  sha256: slide.visualSource.sha256,
                  width: slide.visualSource.width,
                  height: slide.visualSource.height,
                  resourceCount: slide.visualSource.resources.length,
                  readInstruction: `Use ReadFile("${slide.visualSource.sourcePath}") to inspect or edit the author source.`,
                }
              : undefined,
          notSvgNative: slide.visualSource?.kind === "svg" ? undefined : true,
        })),
      },
      visualAssetAudit: result.visualAssetAudit,
    }),
  risk: "low",
  execute: async (_, context) => {
    return {
      presentation: requirePresentation(context),
      visualAssetAudit: auditPresentationVisualAssets(requirePresentation(context)),
    };
  },
};
