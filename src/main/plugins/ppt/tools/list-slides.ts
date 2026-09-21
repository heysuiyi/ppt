import { z } from "zod";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";
import { requirePresentation } from "../context";

export const listSlidesSchema = z.object({});
export const listSlidesOutputSchema = z.object({
  slides: z.array(
    z.object({
      id: z.string(),
      index: z.number().int().nonnegative(),
      title: z.string(),
      svgSourcePath: z.string().optional(),
      svgSha256: z.string().optional(),
      narrativeRole: z.string().optional(),
      rhythm: z.enum(["anchor", "dense", "breathing"]).optional(),
    }),
  ),
});

/**
 * Core Tool: 轻量列出页面 id、顺序和标题。
 * 用于定位页码、确认页数和解析“第 N 页”。
 * 不返回完整元素树，避免替代 ReadPresentationSnapshot。
 */
export const listSlidesTool: ToolDefinition<
  typeof listSlidesSchema,
  {
    slides: Array<{
      id: string;
      index: number;
      title: string;
      svgSourcePath?: string;
      svgSha256?: string;
      narrativeRole?: string;
      rhythm?: "anchor" | "dense" | "breathing";
    }>;
  }
> = {
  name: "ListSlides",
  description: "轻量列出所有幻灯片的基本信息，包括 ID、索引顺序和标题。",
  category: "core",
  loadPolicy: "core",
  inputSchema: listSlidesSchema,
  behavior: { concurrency: { mode: "parallel" } },
  outputSchema: listSlidesOutputSchema,
  risk: "low",
  execute: async (_, context) => {
    const slides = requirePresentation(context).slides.map((slide, index) => ({
      id: slide.id,
      index,
      title: slide.title,
      ...(slide.visualSource?.kind === "svg"
        ? {
            svgSourcePath: slide.visualSource.sourcePath,
            svgSha256: slide.visualSource.sha256,
            narrativeRole: slide.narrative?.role,
            rhythm: slide.narrative?.rhythm,
          }
        : {}),
    }));
    return { slides };
  },
};
