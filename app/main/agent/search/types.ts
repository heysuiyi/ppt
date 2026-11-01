export type WebSearchDepth = "basic" | "advanced";
export type WebSearchTopic = "general" | "news";

export interface WebSearchOptions {
  maxResults: number;
  searchDepth: WebSearchDepth;
  topic: WebSearchTopic;
  /** Ask the provider for image candidates in addition to web pages. */
  includeImages?: boolean;
  /** Maximum normalized image candidates returned to the caller. */
  maxImages?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  signal?: AbortSignal;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
}

export interface WebSearchImageResult {
  url: string;
  description?: string;
  /** Page that exposed the image when the provider supplies that relationship. */
  sourceUrl?: string;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  images: WebSearchImageResult[];
}

export interface WebSearchAdapter {
  readonly name: string;
  search(query: string, options: WebSearchOptions): Promise<WebSearchResponse>;
}

export interface WebSearchRuntimeConfig {
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
}
