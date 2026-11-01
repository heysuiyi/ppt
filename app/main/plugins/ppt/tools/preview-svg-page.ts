import { DEFAULT_DESIGN_SYSTEM } from "@design-system";
import type { Slide } from "@shared/presentation";
import { assertValidSvgPage } from "@shared/svg-page";
import { z } from "zod";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";
import {
  type SlideThumbnailResult,
  slideThumbnailService,
} from "../adapters/electron-thumbnail-service";
import { requirePptCapability } from "../context";
import { previewResultEvents } from "../preview-events";
import { loadWorkspaceSvgPage, recordSvgPagePreview } from "../svg-page-loader";
import { commitSvgPagePreviewLifecycle } from "./svg-deck-lifecycle";
import { precheckSvgPagePreviewLocks } from "./svg-deck-locks";

export const previewSvgPageSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .describe("Workspace-relative SVG page path, for example slides/svg/P01.svg."),
    title: z.string().trim().min(1).max(500).optional(),
    includeThumbnail: z.boolean().optional().default(true),
  })
  .strict();

interface PreviewSvgPageResult {
  preview: {
    sourcePath: string;
    title: string;
    sha256: string;
    width: 1280;
    height: 720;
    resourceCount: number;
    description: string;
    previewGatePassed: boolean;
  };
  thumbnail: SlideThumbnailResult | null;
  thumbnailError?: string;
}

/**
 * Content-exact authoring gate for SVG files that have not yet entered Presentation.
 */
export const previewSvgPageTool: ToolDefinition<typeof previewSvgPageSchema, PreviewSvgPageResult> =
  {
    name: "PreviewSvgPage",
    description:
      "校验并真实渲染 workspace 中尚未提交的完整页面 SVG。P01 写完后先查看 PNG 并校准风格；" +
      "最终提交前每页当前版本都必须通过本工具。它与 SubmitSvgDeck 使用同一图片内联和 SVG 校验边界。" +
      "通过预览门禁前会先校验 design/design-spec.json 与 slides/page-plan.json，" +
      "且该页 path 必须出现在 page-plan 中；锁契约失败不会记为预览通过。",
    category: "core",
    loadPolicy: "core",
    inputSchema: previewSvgPageSchema,
    mapResultToProgress: previewResultEvents,
    validateContext: requirePptCapability(["create", "edit", "restyle", "review"]),
    isEnabled: (context) => Boolean(context.workspaceRoot && context.fileService),
    mapResultToModelBlocks: (result) => [
      {
        type: "text",
        text: JSON.stringify({
          ...result.preview,
          thumbnail: result.thumbnail
            ? { width: result.thumbnail.width, height: result.thumbnail.height }
            : null,
          thumbnailError: result.thumbnailError,
        }),
      },
      ...(result.thumbnail
        ? [
            {
              type: "image" as const,
              mediaType: result.thumbnail.mimeType,
              data: result.thumbnail.pngBase64,
            },
          ]
        : []),
    ],
    risk: "low",
    execute: async (args, context) => {
      if (!context.workspaceRoot || !context.fileService) {
        throw new Error("PreviewSvgPage requires a configured workspace.");
      }
      context.presentationLifecycle?.requireActiveCapability([
        "create",
        "edit",
        "restyle",
        "review",
      ]);
      await context.presentationLifecycle?.observeArtifactChanges({
        workspaceRoot: context.workspaceRoot,
        source: "preview",
      });
      const page = await loadWorkspaceSvgPage({
        requestedPath: args.path,
        workspaceRoot: context.workspaceRoot,
        fileService: context.fileService,
      });
      assertValidSvgPage(page.markup);

      // Gate path requires valid locks before spending thumbnail render cost.
      if (args.includeThumbnail) {
        await precheckSvgPagePreviewLocks(context.fileService, page.sourcePath, "PreviewSvgPage");
      }

      const title = args.title ?? page.sourcePath;
      const slide: Slide = {
        id: `svg-preview-${page.sha256.slice(0, 16)}`,
        title,
        visualSource: {
          kind: "svg",
          markup: page.markup,
          width: 1280,
          height: 720,
          sha256: page.sha256,
          sourcePath: page.sourcePath,
          resources: page.resources,
        },
      };

      let thumbnail: SlideThumbnailResult | null = null;
      let thumbnailError: string | undefined;
      if (args.includeThumbnail) {
        try {
          thumbnail = await slideThumbnailService.captureSlide(slide, DEFAULT_DESIGN_SYSTEM);
        } catch (error) {
          thumbnailError = error instanceof Error ? error.message : String(error);
        }
      }
      const previewGatePassed = args.includeThumbnail && thumbnail !== null;
      if (previewGatePassed) {
        if (context.presentationLifecycle) {
          await commitSvgPagePreviewLifecycle({
            lifecycle: context.presentationLifecycle,
            fileService: context.fileService,
            page,
          });
        }
        recordSvgPagePreview(context.fileService, page);
      }

      return {
        preview: {
          sourcePath: page.sourcePath,
          title,
          sha256: page.sha256,
          width: 1280,
          height: 720,
          resourceCount: page.resources.length,
          description: `Validated complete-page SVG · ${page.resources.length} localized raster resource(s)`,
          previewGatePassed,
        },
        thumbnail,
        ...(thumbnailError ? { thumbnailError } : {}),
      };
    },
  };
