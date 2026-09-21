import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import type { SvgPageResource } from "@shared/presentation";
import type { WorkspaceFileService } from "../../agent/tools/files/workspace-file-service";
import { detectSupportedRasterMime, MAX_LOCAL_IMAGE_BYTES } from "../../local-image-file";

export interface HydratedSvgPage {
  markup: string;
  sourcePath: string;
  sha256: string;
  byteSize: number;
  resources: SvgPageResource[];
  resourceContents: HydratedSvgPageResourceContent[];
}

export interface HydratedSvgPageResourceContent {
  resource: SvgPageResource;
  bytes: Uint8Array;
}

export const MAX_HYDRATED_SVG_PAGE_BYTES = 25 * 1024 * 1024;

const previewedPageKeysByFileService = new WeakMap<WorkspaceFileService, Set<string>>();
const MAX_PREVIEW_RECEIPTS = 500;

export async function loadWorkspaceSvgPage(input: {
  requestedPath: string;
  workspaceRoot: string;
  fileService: WorkspaceFileService;
}): Promise<HydratedSvgPage> {
  const receipt = await input.fileService.inspect(input.requestedPath, {
    maxBytes: 4 * 1024 * 1024,
  });
  const resources: SvgPageResource[] = [];
  const resourceContents: HydratedSvgPageResourceContent[] = [];
  const cachedResources = new Map<
    string,
    {
      dataUri: string;
      resource: SvgPageResource;
      bytes: Uint8Array;
    }
  >();
  const resourceHashes = new Set<string>();
  let markup = receipt.content;
  let projectedHydratedBytes = Buffer.byteLength(markup, "utf8");
  const imageTags = findImageStartTags(markup);
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  for (const match of imageTags) {
    const tag = match.value;
    const hrefAttribute = findImageHrefAttribute(tag, receipt.path);
    if (!hrefAttribute) {
      throw new Error(`${receipt.path}: every <image> must declare href or xlink:href.`);
    }
    const href = hrefAttribute.value.trim();
    if (/^data:image\//i.test(href)) {
      const embedded = inspectEmbeddedRaster(href, receipt.path);
      if (!resourceHashes.has(embedded.resource.sha256)) {
        resources.push(embedded.resource);
        resourceContents.push(embedded);
        resourceHashes.add(embedded.resource.sha256);
      }
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || isAbsolute(href)) {
      throw new Error(
        `${receipt.path}: image source must be workspace-relative or embedded: ${href}`,
      );
    }

    const assetPath = normalizeWorkspacePath(
      posix.join(posix.dirname(normalizeWorkspacePath(receipt.path)), href.replace(/\\/g, "/")),
    );
    let localized = cachedResources.get(assetPath);
    if (!localized) {
      localized = await readWorkspaceRaster(input.workspaceRoot, assetPath);
      cachedResources.set(assetPath, localized);
      if (!resourceHashes.has(localized.resource.sha256)) {
        resources.push(localized.resource);
        resourceContents.push({
          resource: localized.resource,
          bytes: localized.bytes,
        });
        resourceHashes.add(localized.resource.sha256);
      }
    }
    projectedHydratedBytes +=
      Buffer.byteLength(localized.dataUri, "utf8") - Buffer.byteLength(hrefAttribute.value, "utf8");
    if (projectedHydratedBytes > MAX_HYDRATED_SVG_PAGE_BYTES) {
      throw new Error(
        `${receipt.path}: hydrated SVG would exceed ${MAX_HYDRATED_SVG_PAGE_BYTES} bytes.`,
      );
    }
    const hydratedTag =
      tag.slice(0, hrefAttribute.valueStart) +
      localized.dataUri +
      tag.slice(hrefAttribute.valueEnd);
    replacements.push({
      start: match.start,
      end: match.end,
      value: hydratedTag,
    });
  }

  if (replacements.length > 0) {
    const hydratedParts: string[] = [];
    let sourceCursor = 0;
    for (const replacement of replacements) {
      hydratedParts.push(markup.slice(sourceCursor, replacement.start), replacement.value);
      sourceCursor = replacement.end;
    }
    hydratedParts.push(markup.slice(sourceCursor));
    markup = hydratedParts.join("");
  }
  const hydratedBytes = Buffer.byteLength(markup, "utf8");
  if (hydratedBytes > MAX_HYDRATED_SVG_PAGE_BYTES) {
    throw new Error(
      `${receipt.path}: hydrated SVG is ${hydratedBytes} bytes, exceeding ` +
        `${MAX_HYDRATED_SVG_PAGE_BYTES} bytes.`,
    );
  }

  return {
    markup,
    sourcePath: normalizeWorkspacePath(receipt.path),
    sha256: sha256(markup),
    byteSize: hydratedBytes,
    resources,
    resourceContents,
  };
}

interface ImageStartTag {
  start: number;
  end: number;
  value: string;
}

interface ImageHrefAttribute {
  value: string;
  valueStart: number;
  valueEnd: number;
}

function findImageHrefAttribute(tag: string, svgPath: string): ImageHrefAttribute | undefined {
  let cursor = 1;
  while (/\s/.test(tag[cursor] ?? "")) cursor += 1;
  const tagName = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(tag.slice(cursor))?.[0];
  if (!tagName) return undefined;
  cursor += tagName.length;

  const hrefAttributes: ImageHrefAttribute[] = [];
  while (cursor < tag.length) {
    while (/\s/.test(tag[cursor] ?? "")) cursor += 1;
    if (cursor >= tag.length || tag[cursor] === ">" || tag[cursor] === "/") break;
    const attributeName = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(tag.slice(cursor))?.[0];
    if (!attributeName) break;
    cursor += attributeName.length;
    while (/\s/.test(tag[cursor] ?? "")) cursor += 1;
    if (tag[cursor] !== "=") break;
    cursor += 1;
    while (/\s/.test(tag[cursor] ?? "")) cursor += 1;
    const quote = tag[cursor];
    if (quote !== '"' && quote !== "'") break;
    cursor += 1;
    const valueStart = cursor;
    const valueEnd = tag.indexOf(quote, valueStart);
    if (valueEnd < 0) break;
    const normalizedName = attributeName.toLowerCase();
    if (normalizedName === "href" || normalizedName === "xlink:href") {
      hrefAttributes.push({
        value: tag.slice(valueStart, valueEnd),
        valueStart,
        valueEnd,
      });
    } else if (normalizedName.endsWith(":href")) {
      throw new Error(`${svgPath}: <image> may use only href or xlink:href, not ${attributeName}.`);
    }
    cursor = valueEnd + 1;
  }

  if (hrefAttributes.length > 1) {
    throw new Error(`${svgPath}: <image> must declare exactly one href or xlink:href.`);
  }
  return hrefAttributes[0];
}

function findImageStartTags(markup: string): ImageStartTag[] {
  const tags: ImageStartTag[] = [];
  let cursor = 0;
  while (cursor < markup.length) {
    const start = markup.indexOf("<", cursor);
    if (start < 0) break;
    if (markup.startsWith("<!--", start)) {
      const end = markup.indexOf("-->", start + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    if (markup.startsWith("<![CDATA[", start)) {
      const end = markup.indexOf("]]>", start + 9);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    if (markup.startsWith("<?", start)) {
      const end = markup.indexOf("?>", start + 2);
      if (end < 0) break;
      cursor = end + 2;
      continue;
    }
    const end = findTagEnd(markup, start + 1);
    if (end < 0) break;
    const value = markup.slice(start, end + 1);
    const name = value.match(/^<\s*([A-Za-z_][A-Za-z0-9_.:-]*)/)?.[1];
    const localName = name?.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
    if (localName?.toLowerCase() === "image") {
      tags.push({ start, end: end + 1, value });
    }
    cursor = end + 1;
  }
  return tags;
}

function findTagEnd(markup: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < markup.length; index += 1) {
    const character = markup[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function inspectEmbeddedRaster(href: string, svgPath: string): HydratedSvgPageResourceContent {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/]+={0,2})$/i.exec(href);
  if (!match) {
    throw new Error(
      `${svgPath}: embedded image must be a canonical PNG, JPEG, GIF, or WebP base64 data URI.`,
    );
  }
  const bytes = Buffer.from(match[2], "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_LOCAL_IMAGE_BYTES ||
    bytes.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")
  ) {
    throw new Error(
      `${svgPath}: embedded image base64 is invalid or exceeds ${MAX_LOCAL_IMAGE_BYTES} bytes.`,
    );
  }
  const actualMimeType = detectSvgRasterMime(bytes);
  const declaredMimeType = match[1].toLowerCase();
  if (!actualMimeType || actualMimeType !== declaredMimeType) {
    throw new Error(`${svgPath}: embedded image signature does not match ${declaredMimeType}.`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    resource: {
      sourcePath: `embedded:${digest}`,
      mimeType: actualMimeType,
      byteSize: bytes.byteLength,
      sha256: digest,
    },
    bytes,
  };
}

function detectSvgRasterMime(bytes: Uint8Array): SvgPageResource["mimeType"] | undefined {
  const supported = detectSupportedRasterMime(bytes.subarray(0, 8));
  if (supported) return supported;
  const isWebp =
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
  return isWebp ? "image/webp" : undefined;
}

async function readWorkspaceRaster(
  workspaceRoot: string,
  workspacePath: string,
): Promise<{
  dataUri: string;
  resource: SvgPageResource;
  bytes: Uint8Array;
}> {
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const canonicalRoot = await realpath(resolvedWorkspaceRoot);
  const candidate = resolve(canonicalRoot, workspacePath);
  assertPathInsideWorkspace(canonicalRoot, candidate, workspacePath);
  const canonicalPath = await realpath(candidate);
  assertPathInsideWorkspace(canonicalRoot, canonicalPath, workspacePath);

  const lexicalStat = await lstat(canonicalPath);
  assertRasterFileStat(lexicalStat, workspacePath);

  const handle = await open(
    canonicalPath,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW),
  );
  try {
    const before = await handle.stat();
    assertRasterFileStat(before, workspacePath);
    if (!sameFileIdentity(lexicalStat, before)) {
      throw new Error(`Image source changed before it could be read safely: ${workspacePath}`);
    }

    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(canonicalPath);
    assertRasterFileStat(after, workspacePath);
    assertRasterFileStat(pathAfter, workspacePath);
    if (
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, pathAfter) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw new Error(`Image source changed while it was being read: ${workspacePath}`);
    }

    const [canonicalRootAfter, canonicalPathAfter] = await Promise.all([
      realpath(resolvedWorkspaceRoot),
      realpath(candidate),
    ]);
    if (canonicalRootAfter !== canonicalRoot || canonicalPathAfter !== canonicalPath) {
      throw new Error(`Image path identity changed while it was being read: ${workspacePath}`);
    }

    const mimeType = detectSvgRasterMime(bytes);
    if (!mimeType) {
      throw new Error(
        `Unsupported raster image; expected PNG, JPEG, GIF, or WebP: ${workspacePath}`,
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    return {
      dataUri: `data:${mimeType};base64,${bytes.toString("base64")}`,
      resource: {
        sourcePath: workspacePath,
        mimeType,
        byteSize: bytes.byteLength,
        sha256: digest,
      },
      bytes,
    };
  } finally {
    await handle.close();
  }
}

function assertPathInsideWorkspace(
  canonicalRoot: string,
  candidate: string,
  workspacePath: string,
): void {
  const pathFromRoot = relative(canonicalRoot, candidate);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`Image path is outside the workspace: ${workspacePath}`);
  }
}

function assertRasterFileStat(stat: Stats, workspacePath: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Image source is not a regular file: ${workspacePath}`);
  }
  if (stat.size <= 0) throw new Error(`Image source is empty: ${workspacePath}`);
  if (stat.size > MAX_LOCAL_IMAGE_BYTES) {
    throw new Error(`Image source exceeds ${MAX_LOCAL_IMAGE_BYTES} bytes: ${workspacePath}`);
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function normalizeWorkspaceSvgPath(value: string): string {
  return normalizeWorkspacePath(value);
}

export function recordSvgPagePreview(
  fileService: WorkspaceFileService,
  page: Pick<HydratedSvgPage, "sourcePath" | "sha256">,
): void {
  const previewedPageKeys = previewReceiptSet(fileService);
  const key = previewReceiptKey(fileService.workspaceRoot, page);
  previewedPageKeys.delete(key);
  previewedPageKeys.add(key);
  if (previewedPageKeys.size > MAX_PREVIEW_RECEIPTS) {
    const oldest = previewedPageKeys.values().next().value;
    if (typeof oldest === "string") previewedPageKeys.delete(oldest);
  }
}

export function hasSvgPagePreviewReceipt(
  fileService: WorkspaceFileService,
  page: Pick<HydratedSvgPage, "sourcePath" | "sha256">,
): boolean {
  return previewReceiptSet(fileService).has(previewReceiptKey(fileService.workspaceRoot, page));
}

function normalizeWorkspacePath(value: string): string {
  const normalized = posix.normalize(value.replace(/\\/g, "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.includes(":")
  ) {
    throw new Error(`Path must stay inside the workspace: ${value}`);
  }
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function previewReceiptKey(
  workspaceRoot: string,
  page: Pick<HydratedSvgPage, "sourcePath" | "sha256">,
): string {
  return `${resolve(workspaceRoot)}\0${normalizeWorkspacePath(page.sourcePath)}\0${page.sha256}`;
}

function previewReceiptSet(fileService: WorkspaceFileService): Set<string> {
  let receipts = previewedPageKeysByFileService.get(fileService);
  if (!receipts) {
    receipts = new Set<string>();
    previewedPageKeysByFileService.set(fileService, receipts);
  }
  return receipts;
}
