import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";

import type { ImageAssetMetadata } from "@shared/presentation";
import { resolveWorkspacePath } from "../subagent/workspace-path";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 5;

type SupportedImage = {
  mimeType: "image/png" | "image/jpeg" | "image/gif";
  extension: "png" | "jpg" | "gif";
};

export interface LocalizeImageAssetInput {
  url: string;
  workspaceRoot: string;
  provider?: string;
  sourcePageUrl?: string;
  description?: string;
  attribution?: string;
  license?: string;
}

export interface LocalizedImageAsset {
  filePath: string;
  fileUrl: string;
  metadata: ImageAssetMetadata;
}

export interface LocalizeImageAssetOptions {
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
  maxBytes?: number;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function assertPublicImageUrl(
  rawUrl: string,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Image asset URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Image asset URL must not contain credentials.");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Image asset URL cannot target localhost.");
  }
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("Image asset URL resolved to a private or invalid network address.");
  }
  return url;
}

function detectSupportedImage(buffer: Buffer): SupportedImage | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return { mimeType: "image/gif", extension: "gif" };
    }
  }
  return null;
}

async function fetchPublicImage(
  initialUrl: URL,
  fetchImpl: typeof fetch,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1" },
    });
    if (response.status < 300 || response.status >= 400) return response;
    if (redirectCount === MAX_REDIRECTS) throw new Error("Image download exceeded redirect limit.");
    const location = response.headers.get("location");
    if (!location) throw new Error("Image download redirect did not include a location.");
    currentUrl = await assertPublicImageUrl(new URL(location, currentUrl).toString(), resolveHost);
  }
  throw new Error("Image download exceeded redirect limit.");
}

export async function localizeImageAsset(
  input: LocalizeImageAssetInput,
  options: LocalizeImageAssetOptions = {},
): Promise<LocalizedImageAsset> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const url = await assertPublicImageUrl(input.url, resolveHost);

  const response = await fetchPublicImage(url, fetchImpl, resolveHost);
  if (!response.ok) {
    throw new Error(`Image download failed with HTTP ${response.status}.`);
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Image asset exceeds the ${maxBytes}-byte limit.`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error("Image asset response was empty.");
  if (buffer.length > maxBytes) throw new Error(`Image asset exceeds the ${maxBytes}-byte limit.`);

  const detected = detectSupportedImage(buffer);
  if (!detected) {
    throw new Error("Unsupported image format. Use PNG, JPEG, or GIF.");
  }

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const localPath = `assets/images/${sha256.slice(0, 24)}.${detected.extension}`;
  const filePath = resolveWorkspacePath(input.workspaceRoot, localPath);
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, buffer, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const normalizedLocalPath = relative(input.workspaceRoot, filePath).replaceAll("\\", "/");
  return {
    filePath,
    fileUrl: pathToFileURL(filePath).toString(),
    metadata: {
      ...(input.provider ? { provider: input.provider } : {}),
      sourceUrl: url.toString(),
      ...(input.sourcePageUrl ? { sourcePageUrl: input.sourcePageUrl } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.attribution ? { attribution: input.attribution } : {}),
      ...(input.license ? { license: input.license } : {}),
      localPath: normalizedLocalPath,
      mimeType: detected.mimeType,
      byteSize: buffer.length,
      sha256,
      fetchedAt: new Date().toISOString(),
    },
  };
}
