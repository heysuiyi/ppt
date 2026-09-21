import { z } from "zod";
import { imageSearchService } from "../../../agent/search/image-search-service";
import type { WebSearchOutput } from "../../../agent/search/web-search";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";
import { requirePptCapability, requirePresentation } from "../context";

export const searchSlideImagesSchema = z.object({
  slideId: z.string().describe("需要配图的幻灯片 ID；工具会读取标题以生成搜索意图"),
  query: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .optional()
    .describe("可选搜索意图；省略时根据 slide.title 自动生成"),
  visualKind: z
    .enum(["photo", "illustration", "evidence", "logo"])
    .optional()
    .default("photo")
    .describe("需要的视觉类型"),
  sourceMode: z
    .enum(["free", "web"])
    .optional()
    .default("free")
    .describe("free 优先 Pexels/Pixabay/Unsplash/Wikimedia；web 搜索全网但必须另行核对授权"),
  maxImages: z.number().int().min(1).max(8).optional().default(5),
});

export interface SlideImageCandidate {
  candidateId: string;
  url: string;
  description: string;
  provider?: string;
  sourcePageUrl?: string;
  licenseStatus: "unknown";
  /** Metadata for localizing the asset and embedding it in page SVG. */
  assetArgs: {
    slideId: string;
    url: string;
    aspectRatio: "16:9" | "4:3" | "1:1" | "auto";
    objectFit: "cover";
    provider?: string;
    sourcePageUrl?: string;
    description: string;
  };
}

export interface SearchSlideImagesOutput {
  slideId: string;
  query: string;
  candidates: SlideImageCandidate[];
  guidance: string;
  rawSearch: WebSearchOutput;
}

function formatSearchSlideImagesOutput(output: SearchSlideImagesOutput): string {
  if (output.candidates.length === 0) {
    return `No usable image candidates found for slide ${output.slideId}. Try a more concrete query or sourceMode=web.`;
  }
  return [
    `Image candidates for slide ${output.slideId}:`,
    ...output.candidates.map((candidate, index) =>
      [
        `${index + 1}. ${candidate.description}`,
        `   image: ${candidate.url}`,
        `   provider: ${candidate.provider ?? "unknown"}`,
        `   source page: ${candidate.sourcePageUrl ?? "missing — verify before use"}`,
        `   license status: ${candidate.licenseStatus}`,
        `   asset args: ${JSON.stringify(candidate.assetArgs)}`,
      ].join("\n"),
    ),
    output.guidance,
  ].join("\n\n");
}

export const searchSlideImagesTool: ToolDefinition<
  typeof searchSlideImagesSchema,
  SearchSlideImagesOutput
> = {
  name: "SearchSlideImages",
  description:
    "为指定幻灯片主动搜索可用图片候选，优先免费图库，并给出可本地化后嵌入页面 SVG 的素材参数。" +
    "当 visualAssetAudit 报告缺图，或页面需要照片/证据配图时调用。",
  category: "core",
  loadPolicy: "core",
  inputSchema: searchSlideImagesSchema,
  examples: [
    JSON.stringify({ slideId: "slide-3" }),
    JSON.stringify({
      slideId: "slide-5",
      query: "industrial robot assembly line",
      visualKind: "evidence",
    }),
  ],
  validateContext: requirePptCapability(["create", "edit", "restyle"]),
  behavior: {
    concurrency: { mode: "parallel" },
  },
  risk: "low",
  permission: {
    profile: "web-search",
    description: "Search image candidates for a presentation slide.",
    scopes: ["main"],
    effects: ["network.access"],
    sandbox: "none",
    approval: "never",
  },
  execute: async (args, context) => {
    const slide = requirePresentation(context).slides.find((item) => item.id === args.slideId);
    if (!slide) {
      throw new Error(`Slide '${args.slideId}' was not found.`);
    }

    const search = await imageSearchService.search(
      {
        brief: args.query?.trim() || slide.title,
        maxImages: args.maxImages,
        sourceMode: args.sourceMode,
        visualKind: args.visualKind,
      },
      {
        searchConfig: context.searchConfig,
        signal: context.signal,
      },
    );
    const { query, rawSearch } = search;

    const rankedImages = search.candidates.sort(
      (left, right) =>
        Number(Boolean(right.sourcePageUrl)) - Number(Boolean(left.sourcePageUrl)) ||
        left.candidateIndex - right.candidateIndex,
    );
    const candidates = rankedImages
      .slice(0, args.maxImages)
      .map((image, index): SlideImageCandidate => {
        const sourcePageUrl = image.sourcePageUrl;
        const provider = image.provider;
        const description = image.description || `${slide.title} image candidate ${index + 1}`;
        return {
          candidateId: `${slide.id}:image-${index + 1}`,
          url: image.url,
          description,
          provider,
          sourcePageUrl,
          licenseStatus: "unknown",
          assetArgs: {
            slideId: slide.id,
            url: image.url,
            aspectRatio: "auto",
            objectFit: "cover",
            ...(provider ? { provider } : {}),
            ...(sourcePageUrl ? { sourcePageUrl } : {}),
            description,
          },
        };
      });

    return {
      slideId: slide.id,
      query,
      candidates,
      guidance:
        "Choose one semantically relevant candidate, WriteFile it into workspace assets, reference it from the page SVG, then PreviewSvgPage. Keep source metadata; license may stay unset when unverified, but retain the warning and never claim commercial clearance.",
      rawSearch,
    };
  },
  mapResultToModelContent: formatSearchSlideImagesOutput,
};
