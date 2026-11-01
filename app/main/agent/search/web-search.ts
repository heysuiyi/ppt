import type { AgentSearchConfig } from "@shared/agent-gateway-config";
import { z } from "zod";
import { createSearchService } from "./search-service";
import type { WebSearchImageResult, WebSearchResult } from "./types";

const domainSchema = z.string().trim().min(1).max(253);

export const webSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(500).describe("要搜索的具体问题或关键词"),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .default(5)
      .describe("返回结果数量，默认 5，最多 10"),
    search_depth: z
      .enum(["basic", "advanced"])
      .optional()
      .default("basic")
      .describe("basic 更快更省额度；advanced 相关性更高但消耗更多额度"),
    topic: z
      .enum(["general", "news"])
      .optional()
      .default("general")
      .describe("general 用于通用资料，news 用于实时新闻"),
    include_images: z
      .boolean()
      .optional()
      .describe("是否同时返回图片候选；图片仅供选材，使用前需核对授权与来源"),
    max_images: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("图片候选数量，默认 5，最多 10"),
    allowed_domains: z
      .array(domainSchema)
      .max(20)
      .optional()
      .describe("仅搜索这些域名，例如 ['who.int']"),
    blocked_domains: z.array(domainSchema).max(20).optional().describe("排除这些域名"),
  })
  .superRefine((value, context) => {
    if (value.allowed_domains?.length && value.blocked_domains?.length) {
      context.addIssue({
        code: "custom",
        message: "allowed_domains and blocked_domains cannot be used together.",
      });
    }
  });

export type WebSearchArgs = z.infer<typeof webSearchSchema>;

export interface WebSearchOutput {
  query: string;
  results: WebSearchResult[];
  images: WebSearchImageResult[];
  sourcesGuidance: string;
}

function configFromSearch(config?: AgentSearchConfig): {
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
} {
  return {
    apiKey: config?.webSearchApiKey,
    endpoint: config?.webSearchEndpoint,
    timeoutMs: config?.webSearchTimeoutMs,
  };
}

export async function executeWebSearch(
  args: WebSearchArgs,
  options: { searchConfig?: AgentSearchConfig; signal?: AbortSignal } = {},
): Promise<WebSearchOutput> {
  const service = createSearchService(configFromSearch(options.searchConfig));
  const response = await service.search(args.query, {
    maxResults: args.max_results,
    searchDepth: args.search_depth,
    topic: args.topic,
    includeImages: args.include_images ?? false,
    maxImages: args.max_images ?? 5,
    allowedDomains: args.allowed_domains,
    blockedDomains: args.blocked_domains,
    signal: options.signal,
  });

  return {
    query: args.query,
    results: response.results,
    images: response.images,
    sourcesGuidance:
      "Use source URLs for factual claims. Image candidates are discovery results, not automatic reuse permission; retain provenance and verify the license before use.",
  };
}

export function formatWebSearchOutput(output: WebSearchOutput): string {
  if (output.results.length === 0 && output.images.length === 0) {
    return `No web results found for: ${output.query}`;
  }
  const sections = [`Web search results for: ${output.query}`];
  if (output.results.length > 0) {
    sections.push(
      ...output.results.map((result, index) => {
        const metadata = result.publishedDate ? ` (${result.publishedDate})` : "";
        const snippet = result.snippet ? `\n${result.snippet}` : "";
        return `${index + 1}. [${result.title}](${result.url})${metadata}${snippet}`;
      }),
    );
  }
  if (output.images.length > 0) {
    sections.push(
      "Image candidates (verify license and attribution before use):",
      ...output.images.map((image, index) => {
        const description = image.description || `Image ${index + 1}`;
        const source = image.sourceUrl ? ` · source page: ${image.sourceUrl}` : "";
        return `${index + 1}. ${description}\n${image.url}${source}`;
      }),
    );
  }
  sections.push(output.sourcesGuidance);
  return sections.join("\n\n");
}
