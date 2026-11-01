import { TavilySearchAdapter } from "./tavily-adapter";
import type {
  WebSearchAdapter,
  WebSearchOptions,
  WebSearchResponse,
  WebSearchRuntimeConfig,
} from "./types";

export class SearchService {
  constructor(private readonly adapters: WebSearchAdapter[]) {
    if (adapters.length === 0) throw new Error("At least one web search adapter is required.");
  }

  async search(query: string, options: WebSearchOptions): Promise<WebSearchResponse> {
    let lastError: unknown;
    for (const adapter of this.adapters) {
      try {
        return await adapter.search(query, options);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Web search failed.");
  }
}

export function createSearchService(config: WebSearchRuntimeConfig = {}): SearchService {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "Web search is not configured. Add a Tavily API key in Settings → 生成参数, " +
        "or set TAVILY_API_KEY.",
    );
  }

  return new SearchService([
    new TavilySearchAdapter({
      apiKey,
      endpoint: config.endpoint?.trim(),
      timeoutMs: config.timeoutMs,
    }),
  ]);
}
