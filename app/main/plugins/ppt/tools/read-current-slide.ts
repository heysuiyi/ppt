import { z } from "zod";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";
import { requirePresentation } from "../context";

export const readCurrentSlideSchema = z.object({});

/**
 * Core Tool: 读取当前编辑页的 SVG 来源与叙事摘要。
 * 用于“这一页”“当前页”“这里”等局部请求。
 * 只读；当前页来源应由编辑器/session 上下文提供，不能由模型猜测。
 */
export const readCurrentSlideTool: ToolDefinition<
  typeof readCurrentSlideSchema,
  { slide: Record<string, unknown> | null }
> = {
  name: "ReadCurrentSlide",
  description: "获取当前编辑幻灯片的 SVG 来源与叙事摘要；非 SVG 页仅返回提示。",
  category: "core",
  loadPolicy: "core",
  inputSchema: readCurrentSlideSchema,
  behavior: { concurrency: { mode: "parallel" } },
  mapResultToModelContent: (result) => JSON.stringify(result),
  risk: "low",
  execute: async (_, context) => {
    if (!context.currentSlideId) {
      return { slide: null };
    }
    const slide =
      requirePresentation(context).slides.find((s) => s.id === context.currentSlideId) || null;
    if (!slide) {
      return { slide: null };
    }

    if (slide.visualSource?.kind === "svg") {
      return {
        slide: {
          id: slide.id,
          title: slide.title,
          speakerNotes: slide.speakerNotes,
          narrative: slide.narrative,
          visualSource: {
            kind: "svg",
            sourcePath: slide.visualSource.sourcePath,
            sha256: slide.visualSource.sha256,
            width: slide.visualSource.width,
            height: slide.visualSource.height,
            resourceCount: slide.visualSource.resources.length,
          },
          readInstruction: `Use ReadFile("${slide.visualSource.sourcePath}") to inspect or edit the complete SVG page.`,
        },
      };
    }

    return {
      slide: {
        id: slide.id,
        title: slide.title,
        notSvgNative: true,
        readInstruction:
          "This slide is not SVG-native. Element-IR authoring is removed. Author or attach a complete 1280×720 SVG page instead.",
      },
    };
  },
};
