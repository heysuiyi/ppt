import { DEFAULT_WEB_SEARCH_ENDPOINT } from "@shared/agent-gateway-config";
import type {
  WebSearchAdapter,
  WebSearchImageResult,
  WebSearchOptions,
  WebSearchResponse,
  WebSearchResult,
} from "./types";

const DEFAULT_TAVILY_ENDPOINT = DEFAULT_WEB_SEARCH_ENDPOINT;
const DEFAULT_TIMEOUT_MS = 20_000;

type FetchImplementation = typeof fetch;

interface TavilySearchAdapterOptions {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImplementation;
}

interface TavilyResultCandidate {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  published_date?: unknown;
  images?: unknown;
}

interface TavilyImageCandidate {
  url?: unknown;
  description?: unknown;
}

function asSearchResult(value: unknown): WebSearchResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as TavilyResultCandidate;
  if (typeof candidate.title !== "string" || typeof candidate.url !== "string") return null;

  try {
    const url = new URL(candidate.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return {
      title: (candidate.title.trim() || url.hostname).slice(0, 300),
      url: url.toString(),
      ...(typeof candidate.content === "string" && candidate.content.trim()
        ? { snippet: candidate.content.trim().slice(0, 1_200) }
        : {}),
      ...(typeof candidate.published_date === "string" && candidate.published_date.trim()
        ? { publishedDate: candidate.published_date.trim().slice(0, 100) }
        : {}),
    };
  } catch {
    return null;
  }
}

function asImageResult(value: unknown, sourceUrl?: string): WebSearchImageResult | null {
  const candidate: TavilyImageCandidate =
    typeof value === "string"
      ? { url: value }
      : value && typeof value === "object"
        ? (value as TavilyImageCandidate)
        : {};
  if (typeof candidate.url !== "string") return null;

  try {
    const url = new URL(candidate.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return {
      url: url.toString(),
      ...(typeof candidate.description === "string" && candidate.description.trim()
        ? { description: candidate.description.trim().slice(0, 600) }
        : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  } catch {
    return null;
  }
}

function createRequestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });

  const timeout = setTimeout(() => {
    controller.abort(new Error(`Web search timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export class TavilySearchAdapter implements WebSearchAdapter {
  readonly name = "tavily";
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImplementation;

  constructor(options: TavilySearchAdapterOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("Tavily API key is not configured.");
    this.endpoint = options.endpoint?.trim() || DEFAULT_TAVILY_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;

    const endpoint = new URL(this.endpoint);
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      throw new Error("Web search endpoint must use HTTP or HTTPS.");
    }
  }

  async search(query: string, options: WebSearchOptions): Promise<WebSearchResponse> {
    const request = createRequestSignal(options.signal, this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          search_depth: options.searchDepth,
          topic: options.topic,
          max_results: options.maxResults,
          include_answer: false,
          include_raw_content: false,
          include_images: options.includeImages ?? false,
          include_image_descriptions: options.includeImages ?? false,
          ...(options.allowedDomains?.length ? { include_domains: options.allowedDomains } : {}),
          ...(options.blockedDomains?.length ? { exclude_domains: options.blockedDomains } : {}),
        }),
        signal: request.signal,
      });

      if (!response.ok) {
        throw new Error(`Tavily search failed with HTTP ${response.status}.`);
      }

      const payload = (await response.json()) as { results?: unknown; images?: unknown };
      if (!Array.isArray(payload.results)) {
        throw new Error("Tavily search returned an invalid response.");
      }

      const seen = new Set<string>();
      const results: WebSearchResult[] = [];
      for (const item of payload.results) {
        const result = asSearchResult(item);
        if (!result || seen.has(result.url)) continue;
        seen.add(result.url);
        results.push(result);
      }

      const images: WebSearchImageResult[] = [];
      const seenImages = new Set<string>();
      const appendImage = (value: unknown, sourceUrl?: string) => {
        const image = asImageResult(value, sourceUrl);
        if (!image || seenImages.has(image.url)) return;
        seenImages.add(image.url);
        images.push(image);
      };

      if (options.includeImages) {
        if (Array.isArray(payload.images)) {
          payload.images.forEach((image) => appendImage(image));
        }
        for (const item of payload.results) {
          if (!item || typeof item !== "object") continue;
          const candidate = item as TavilyResultCandidate;
          const source = asSearchResult(item)?.url;
          if (Array.isArray(candidate.images)) {
            candidate.images.forEach((image) => appendImage(image, source));
          }
        }
      }

      return {
        results: results.slice(0, options.maxResults),
        images: images.slice(0, options.maxImages ?? options.maxResults),
      };
    } catch (error) {
      if (request.signal.aborted) {
        if (options.signal?.aborted) throw new Error("Web search was cancelled.");
        throw new Error(`Web search timed out after ${this.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      request.dispose();
    }
  }
}

export { DEFAULT_TAVILY_ENDPOINT };
