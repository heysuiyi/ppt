import { createPptToolRegistry } from "@main/plugins/ppt/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUB_AGENT_TOOL_PERMISSION_PROFILES } from "../src/main/agent/runtime/tools/tool-access-policy";
import { createSearchService } from "../src/main/agent/search/search-service";
import { TavilySearchAdapter } from "../src/main/agent/search/tavily-adapter";
import { webSearchSchema } from "../src/main/agent/search/web-search";
import { SUB_AGENT_TOOLS, webSearchSubAgentTool } from "../src/main/agent/subagent/workspace-tools";
import { webSearchTool } from "../src/main/agent/tools/core/web-search";
import { searchSlideImagesTool } from "../src/main/plugins/ppt/tools/search-slide-images";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web search", () => {
  it("calls Tavily with bounded options and normalizes results", async () => {
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Example result",
                url: "https://example.com/article",
                content: "A compact source-backed snippet.",
                published_date: "2026-07-10",
              },
              {
                title: "Duplicate",
                url: "https://example.com/article",
                content: "Should be removed.",
              },
              { title: "Unsafe URL", url: "javascript:alert(1)" },
            ],
          }),
          { status: 200 },
        ),
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const adapter = new TavilySearchAdapter({
      apiKey: "tvly-secret",
      fetchImpl,
    });

    const output = await adapter.search("agent architecture", {
      maxResults: 5,
      searchDepth: "advanced",
      topic: "general",
      includeImages: false,
      maxImages: 5,
      allowedDomains: ["example.com"],
    });

    expect(output.results).toEqual([
      {
        title: "Example result",
        url: "https://example.com/article",
        snippet: "A compact source-backed snippet.",
        publishedDate: "2026-07-10",
      },
    ]);
    expect(output.images).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.tavily.com/search");
    expect((request?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer tvly-secret",
    );
    expect(JSON.parse(String(request?.body))).toMatchObject({
      query: "agent architecture",
      search_depth: "advanced",
      max_results: 5,
      include_domains: ["example.com"],
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_image_descriptions: false,
    });
  });

  it("optionally returns normalized image candidates with source pages", async () => {
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(
          JSON.stringify({
            images: [
              {
                url: "https://cdn.example.com/hero.jpg",
                description: "A wide technology landscape",
              },
              "javascript:alert(1)",
            ],
            results: [
              {
                title: "Source article",
                url: "https://example.com/source",
                content: "Source-backed context.",
                images: [
                  "https://cdn.example.com/evidence.png",
                  "https://cdn.example.com/hero.jpg",
                ],
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const adapter = new TavilySearchAdapter({
      apiKey: "tvly-secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const output = await adapter.search("technology hero image", {
      maxResults: 3,
      searchDepth: "basic",
      topic: "general",
      includeImages: true,
      maxImages: 5,
    });

    expect(output.images).toEqual([
      {
        url: "https://cdn.example.com/hero.jpg",
        description: "A wide technology landscape",
      },
      {
        url: "https://cdn.example.com/evidence.png",
        sourceUrl: "https://example.com/source",
      },
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      include_images: true,
      include_image_descriptions: true,
    });
  });

  it("reports missing configuration without making a request", () => {
    expect(() => createSearchService({}, {})).toThrow("Tavily API key");
  });

  it("does not send an environment key to an unbound search endpoint", () => {
    expect(() =>
      createSearchService(
        {
          endpoint: "https://attacker.example.test/search",
        },
        {
          TAVILY_API_KEY: "environment-key",
          TAVILY_SEARCH_ENDPOINT: "https://bound.example.test/search",
        },
      ),
    ).toThrow("Tavily API key");
  });

  it("uses an environment key at the official search endpoint by default", async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const service = createSearchService(
      {},
      {
        TAVILY_API_KEY: "environment-key",
      },
    );

    await service.search("official route", {
      maxResults: 1,
      searchDepth: "basic",
      topic: "general",
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.tavily.com/search");
    expect(
      (fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined)?.Authorization,
    ).toBe("Bearer environment-key");
  });

  it("uses an environment key only at its normalized explicit endpoint", async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const service = createSearchService(
      {
        endpoint: "https://bound.example.test/search/",
      },
      {
        TAVILY_API_KEY: "environment-key",
        TAVILY_SEARCH_ENDPOINT: "https://bound.example.test/search",
      },
    );

    await service.search("bound route", {
      maxResults: 1,
      searchDepth: "basic",
      topic: "general",
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://bound.example.test/search/");
    expect(
      (fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined)?.Authorization,
    ).toBe("Bearer environment-key");
  });

  it("rejects simultaneous allow and block domain lists", () => {
    const result = webSearchSchema.safeParse({
      query: "test",
      allowed_domains: ["example.com"],
      blocked_domains: ["spam.example"],
    });
    expect(result.success).toBe(false);
  });

  it("registers WebSearch for the main agent and web_search for teammate workspace agents", () => {
    expect(createPptToolRegistry().get("WebSearch")).toBe(webSearchTool);
    expect(createPptToolRegistry().get("SearchSlideImages")).toBe(searchSlideImagesTool);
    expect(createPptToolRegistry().get("InsertSlideImage")).toBeUndefined();
    expect(SUB_AGENT_TOOLS).toContain(webSearchSubAgentTool);
    expect(webSearchSubAgentTool.permission).toBe(SUB_AGENT_TOOL_PERMISSION_PROFILES.web_search);
  });

  it("searches slide images with image mode and free-source defaults", async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Factory photo",
                url: "https://www.pexels.com/photo/factory-123",
                content: "Industrial automation photo.",
                images: [
                  {
                    url: "https://images.pexels.com/photos/123/factory.jpg",
                    description: "Robotic arm in a modern factory",
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const presentation = createStarterPresentation();
    const slideId = presentation.slides[0].id;
    const context = {
      presentation,
      selectedElementIds: [],
      discoverySession: { discoveredToolNames: new Set<string>() },
      registry: createPptToolRegistry(),
      messageHistory: [],
      searchConfig: {
        webSearchApiKey: "tvly-runtime-key",
      },
      gateway: {
        getGatewayConfig: () => ({
          timeoutMs: 180_000,
          maxOutputTokens: 16_384,
        }),
        getSearchConfig: () => ({
          webSearchApiKey: "tvly-runtime-key",
        }),
        async queryModel() {
          throw new Error("not used");
        },
        async *queryModelStream() {
          throw new Error("not used");
        },
      },
    };

    const output = await searchSlideImagesTool.execute(
      {
        slideId,
        query: "industrial robot assembly line",
        visualKind: "evidence",
        sourceMode: "free",
        maxImages: 3,
      },
      context,
    );

    expect(output.candidates[0]).toMatchObject({
      provider: "Pexels",
      sourcePageUrl: "https://www.pexels.com/photo/factory-123",
      assetArgs: {
        slideId,
        aspectRatio: "auto",
        sourcePageUrl: "https://www.pexels.com/photo/factory-123",
      },
    });
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({
      include_images: true,
      include_image_descriptions: true,
      search_depth: "basic",
    });
    expect(requestBody.include_domains).toEqual(
      expect.arrayContaining(["pexels.com", "pixabay.com"]),
    );
  });

  it("uses per-run search configuration and returns citation-ready model content", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Official source",
                url: "https://docs.example.com/fact",
                content: "Verified fact.",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const context = {
      presentation: createStarterPresentation(),
      selectedElementIds: [],
      discoverySession: { discoveredToolNames: new Set<string>() },
      registry: createPptToolRegistry(),
      messageHistory: [],
      searchConfig: {
        webSearchApiKey: "tvly-runtime-key",
      },
      gateway: {
        getGatewayConfig: () => ({
          timeoutMs: 180_000,
          maxOutputTokens: 16_384,
        }),
        getSearchConfig: () => ({
          webSearchApiKey: "tvly-runtime-key",
        }),
        async queryModel() {
          throw new Error("not used");
        },
        async *queryModelStream() {
          throw new Error("not used");
        },
      },
    };

    const output = await webSearchTool.execute(
      {
        query: "verified fact",
        max_results: 3,
        search_depth: "basic",
        topic: "general",
      },
      context,
    );
    const modelContent = await webSearchTool.mapResultToModelContent!(output, context);

    expect(modelContent).toContain("[Official source](https://docs.example.com/fact)");
    expect(modelContent).toContain("Use source URLs");
    expect(output.images).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
