import { resolveSlideStyle, type SlideDesignOverride } from "@design-system";
import type { Slide } from "@shared/presentation";
import { z } from "zod";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";
import { slideThumbnailService } from "../adapters/electron-thumbnail-service";
import { requirePptCapability, requirePresentation } from "../context";
import { previewResultEvents } from "../preview-events";

export const previewSlideSchema = z.object({
  slideId: z.string().describe("要预览的幻灯片 ID"),
  includeThumbnail: z
    .boolean()
    .optional()
    .default(true)
    .describe("是否生成 PNG 缩略图（640×360 base64）；非 Electron 环境自动跳过"),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run thumbnail generation in the background; result returns later as task_notification.",
    ),
});

export interface SlidePreviewThumbnail {
  pngBase64: string;
  width: number;
  height: number;
  mimeType: "image/png";
}

export interface SlidePreviewSummary {
  slideId: string;
  title: string;
  svgPage?: {
    sourcePath: string;
    sha256: string;
    width: 1280;
    height: 720;
    resourceCount: number;
  };
  narrative?: Slide["narrative"];
  designOverride?: SlideDesignOverride;
  resolvedDesign?: Pick<
    ReturnType<typeof resolveSlideStyle>,
    "argumentMode" | "visualStyle" | "readingMode" | "layoutTokens" | "typography"
  >;
  backgroundCss?: string;
  /** Present when the slide is not SVG-native. */
  notSvgNative?: true;
  description: string;
}

function describeSlide(slide: Slide): string {
  if (slide.visualSource?.kind === "svg") {
    return [
      "Complete-page SVG",
      `${slide.visualSource.width}×${slide.visualSource.height}`,
      `source=${slide.visualSource.sourcePath}`,
      `sha256=${slide.visualSource.sha256.slice(0, 12)}`,
      `rhythm=${slide.narrative?.rhythm ?? "unset"}`,
    ].join(" · ");
  }

  return "Element-IR preview removed — slide is not SVG-native. Use ReadFile on the page SVG source or author a new SVG page.";
}

/**
 * Core Tool: 返回幻灯片结构化视觉摘要，供 Agent 排版后自检。
 * P2-2：从 Deferred 提升为 Core，layout/review 阶段可直接调用。
 */
export const previewSlideTool: ToolDefinition<
  typeof previewSlideSchema,
  {
    preview: SlidePreviewSummary;
    thumbnail: SlidePreviewThumbnail | null;
    thumbnailError?: string;
  }
> = {
  name: "PreviewSlide",
  description:
    "获取单页 SVG 幻灯片的视觉摘要（visualSource、narrative、背景）及 PNG 缩略图，用于排版后自检。",
  category: "core",
  loadPolicy: "core",
  inputSchema: previewSlideSchema,
  mapResultToProgress: previewResultEvents,
  mapResultToModelBlocks: (result) => {
    const summary = {
      slideId: result.preview.slideId,
      title: result.preview.title,
      description: result.preview.description,
      svgPage: result.preview.svgPage,
      narrative: result.preview.narrative,
      notSvgNative: result.preview.notSvgNative,
      thumbnail: result.thumbnail
        ? { width: result.thumbnail.width, height: result.thumbnail.height }
        : null,
      thumbnailError: result.thumbnailError,
    };
    return [
      { type: "text", text: JSON.stringify(summary) },
      ...(result.thumbnail
        ? [
            {
              type: "image" as const,
              mediaType: result.thumbnail.mimeType,
              data: result.thumbnail.pngBase64,
            },
          ]
        : []),
    ];
  },
  validateContext: requirePptCapability(["edit", "restyle", "review"]),
  behavior: {
    background: {
      isRequested: (args) => args.run_in_background === true,
      describe: (args) => `PreviewSlide: ${args.slideId}`,
    },
  },
  risk: "low",
  execute: async (args, context) => {
    const slide = requirePresentation(context).slides.find((item) => item.id === args.slideId);
    if (!slide) throw new Error(`Slide '${args.slideId}' was not found.`);

    const isSvg = slide.visualSource?.kind === "svg";
    const style = isSvg
      ? resolveSlideStyle(requirePresentation(context).designSystem, slide)
      : undefined;

    const preview: SlidePreviewSummary = isSvg
      ? {
          slideId: slide.id,
          title: slide.title,
          svgPage: {
            sourcePath: slide.visualSource!.sourcePath,
            sha256: slide.visualSource!.sha256,
            width: slide.visualSource!.width,
            height: slide.visualSource!.height,
            resourceCount: slide.visualSource!.resources.length,
          },
          narrative: slide.narrative,
          designOverride: slide.designOverride,
          resolvedDesign: {
            argumentMode: style!.argumentMode,
            visualStyle: style!.visualStyle,
            readingMode: style!.readingMode,
            layoutTokens: style!.layoutTokens,
            typography: style!.typography,
          },
          backgroundCss: style!.background.css,
          description: describeSlide(slide),
        }
      : {
          slideId: slide.id,
          title: slide.title,
          notSvgNative: true,
          description: describeSlide(slide),
        };

    let thumbnail: SlidePreviewThumbnail | null = null;
    let thumbnailError: string | undefined;
    if (args.includeThumbnail) {
      try {
        thumbnail = await slideThumbnailService.captureSlide(
          slide,
          requirePresentation(context).designSystem,
        );
      } catch (error) {
        thumbnail = null;
        thumbnailError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      preview,
      thumbnail,
      ...(thumbnailError ? { thumbnailError } : {}),
    };
  },
};
