import type { AgentSearchConfig } from "@shared/agent-gateway-config";
import { executeWebSearch, type WebSearchOutput } from "./web-search";

export const FREE_IMAGE_DOMAINS = [
  "pexels.com",
  "pixabay.com",
  "unsplash.com",
  "commons.wikimedia.org",
] as const;

export interface ImageSearchRequest {
  brief: string;
  maxImages: number;
  sourceMode: "free" | "web";
  visualKind: "photo" | "illustration" | "evidence" | "logo";
}

export interface ImageSearchCandidate {
  url: string;
  description: string;
  provider?: string;
  sourcePageUrl?: string;
  licenseStatus: "unknown";
  candidateIndex: number;
}

export interface ImageSearchResult {
  query: string;
  candidates: ImageSearchCandidate[];
  rawSearch: WebSearchOutput;
}

export function imageProviderFromUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host.includes("pexels")) return "Pexels";
    if (host.includes("pixabay")) return "Pixabay";
    if (host.includes("unsplash")) return "Unsplash";
    if (host.includes("wikimedia")) return "Wikimedia Commons";
    return host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export class ImageSearchService {
  async search(
    request: ImageSearchRequest,
    options: { searchConfig?: AgentSearchConfig; signal?: AbortSignal } = {},
  ): Promise<ImageSearchResult> {
    const kindPhrase = {
      photo: "professional editorial photography",
      illustration: "high quality editorial illustration",
      evidence: "documentary evidence photography",
      logo: "official logo transparent background",
    }[request.visualKind];
    const query = `${request.brief.trim()} ${kindPhrase} landscape no text`;
    const rawSearch = await executeWebSearch(
      {
        query,
        max_results: Math.max(3, request.maxImages),
        search_depth: "basic",
        topic: "general",
        include_images: true,
        max_images: request.maxImages,
        ...(request.sourceMode === "free" ? { allowed_domains: [...FREE_IMAGE_DOMAINS] } : {}),
      },
      options,
    );
    return {
      query,
      rawSearch,
      candidates: rawSearch.images.map((image, candidateIndex) => ({
        url: image.url,
        description: image.description || `Image candidate ${candidateIndex + 1}`,
        provider: imageProviderFromUrl(image.sourceUrl ?? image.url),
        sourcePageUrl: image.sourceUrl,
        licenseStatus: "unknown",
        candidateIndex,
      })),
    };
  }
}

export const imageSearchService = new ImageSearchService();
