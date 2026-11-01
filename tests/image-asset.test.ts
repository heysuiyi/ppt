import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { localizeImageAsset } from "../app/main/agent/assets/image-asset";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
  "base64",
);

const tempRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ppt-image-asset-"));
  tempRoots.push(root);
  return root;
}

describe("image asset localization", () => {
  it("downloads a public raster image into a content-addressed workspace path", async () => {
    const workspaceRoot = await makeTempRoot();
    const localized = await localizeImageAsset(
      {
        url: "https://cdn.example.com/hero.png",
        workspaceRoot,
        provider: "tavily",
        sourcePageUrl: "https://example.com/article",
        description: "Wide hero image",
        license: "license-pending-verification",
      },
      {
        fetchImpl: vi.fn(
          async () =>
            new Response(TINY_PNG, {
              status: 200,
              headers: {
                "content-type": "image/png",
                "content-length": String(TINY_PNG.length),
              },
            }),
        ) as unknown as typeof fetch,
        resolveHost: async () => ["93.184.216.34"],
      },
    );

    expect(localized.fileUrl).toMatch(/^file:\/\/\//);
    expect(localized.metadata).toMatchObject({
      provider: "tavily",
      sourceUrl: "https://cdn.example.com/hero.png",
      sourcePageUrl: "https://example.com/article",
      localPath: expect.stringMatching(/^assets\/images\/[a-f0-9]{24}\.png$/),
      mimeType: "image/png",
      byteSize: TINY_PNG.length,
    });
    expect(await readFile(localized.filePath)).toEqual(TINY_PNG);
  });

  it("rejects private network image URLs before download", async () => {
    const workspaceRoot = await makeTempRoot();
    const fetchImpl = vi.fn();
    await expect(
      localizeImageAsset(
        {
          url: "http://127.0.0.1/private.png",
          workspaceRoot,
        },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow("private");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects redirects to private network targets before following them", async () => {
    const workspaceRoot = await makeTempRoot();
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private.png" },
        }),
    );
    await expect(
      localizeImageAsset(
        {
          url: "https://cdn.example.com/redirect.png",
          workspaceRoot,
        },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          resolveHost: async () => ["93.184.216.34"],
        },
      ),
    ).rejects.toThrow("private");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
