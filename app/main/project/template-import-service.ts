import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  projectDesignReferenceGuidance,
  projectDesignReferenceToDesignSystem,
} from "@shared/template-projection";
import {
  APPLICATION_TEMPLATE_LIBRARY_DIRECTORY,
  TEMPLATE_LIBRARY_ROOT,
  type TemplateDescriptor,
  type TemplateInspection,
  type TemplateLibraryIndex,
  templateDescriptorSchema,
  templateInspectionSchema,
  templateLibraryIndexSchema,
  templateRevisionSubPath,
} from "@shared/template-protocol";
import JSZip from "jszip";
import { getApplicationDataRoot } from "../application-data";

const MAX_PACKAGE_BYTES = 40 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4_000;
const MAX_UNCOMPRESSED_BYTES = 120 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

const DANGEROUS_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".bat",
  ".cmd",
  ".js",
  ".vbs",
  ".ps1",
  ".msi",
  ".com",
  ".scr",
]);

/**
 * A template library is any directory holding `index.json` plus immutable
 * `<template-id>/<revision-id>` revisions. The application library survives
 * project switches; each project keeps its own copy of the revisions it binds.
 */
export interface TemplateLibraryLocation {
  absoluteRoot: string;
  /** Prefix recorded in descriptors for owner-relative revision paths. */
  relativePrefix: string;
}

export function projectTemplateLibrary(projectRootPath: string): TemplateLibraryLocation {
  return {
    absoluteRoot: join(projectRootPath, TEMPLATE_LIBRARY_ROOT),
    relativePrefix: TEMPLATE_LIBRARY_ROOT,
  };
}

export function applicationTemplateLibrary(
  applicationDataRoot: string = getApplicationDataRoot(),
): TemplateLibraryLocation {
  return {
    absoluteRoot: join(applicationDataRoot, APPLICATION_TEMPLATE_LIBRARY_DIRECTORY),
    relativePrefix: APPLICATION_TEMPLATE_LIBRARY_DIRECTORY,
  };
}

export interface ImportTemplatePackageInput {
  library: TemplateLibraryLocation;
  sourceFilePath: string;
  displayName?: string;
}

export interface ImportTemplatePackageResult {
  descriptor: TemplateDescriptor;
  inspection: TemplateInspection;
  reusedExisting: boolean;
  relativeRoot: string;
}

function contentHash(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function extractAttribute(fragment: string, name: string): string | undefined {
  const match = fragment.match(new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? decodeXmlEntities(match[2]) : undefined;
}

function extractThemeColor(xml: string, name: string): string | undefined {
  const block =
    xml.match(new RegExp(`<a:${name}\\b[^>]*>[\\s\\S]*?<\\/a:${name}>`, "i")) ??
    xml.match(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, "i"));
  if (!block) return undefined;
  const srgb = block[0].match(/srgbClr[^>]*val\s*=\s*(["'])([0-9A-Fa-f]{6,8})\1/i);
  if (srgb) return srgb[2];
  const sys = block[0].match(/sysClr[^>]*lastClr\s*=\s*(["'])([0-9A-Fa-f]{6,8})\1/i);
  return sys?.[2];
}

function extractTypeface(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<a:${tag}\\b[^>]*typeface\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? decodeXmlEntities(match[2]) : undefined;
}

const DEFAULT_SLIDE_WIDTH_EMU = 9_144_000;
const DEFAULT_SLIDE_HEIGHT_EMU = 5_143_500;

function emuToCanvas(emu: number, axis: "x" | "y", widthEmu: number, heightEmu: number): number {
  if (axis === "x") return (emu / widthEmu) * 1280;
  return (emu / heightEmu) * 720;
}

function extractTransform(xmlFragment: string): {
  x?: number;
  y?: number;
  cx?: number;
  cy?: number;
} {
  const off = xmlFragment.match(/<a:off\b[^>]*>/i)?.[0];
  const ext = xmlFragment.match(/<a:ext\b[^>]*>/i)?.[0];
  return {
    x: off ? Number(extractAttribute(off, "x")) : undefined,
    y: off ? Number(extractAttribute(off, "y")) : undefined,
    cx: ext ? Number(extractAttribute(ext, "cx")) : undefined,
    cy: ext ? Number(extractAttribute(ext, "cy")) : undefined,
  };
}

function extractPlaceholderType(phTag: string): string | undefined {
  return extractAttribute(phTag, "type")?.toLowerCase();
}

function extractTextSnippet(xmlFragment: string): string | undefined {
  const texts = [...xmlFragment.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi)]
    .map((match) => decodeXmlEntities(match[1]).trim())
    .filter(Boolean);
  if (texts.length === 0) return undefined;
  return texts.join(" ").slice(0, 120);
}

function extractSolidFill(xmlFragment: string): string | undefined {
  const srgb = xmlFragment.match(
    /<a:solidFill[^>]*>[\s\S]*?<a:srgbClr[^>]*val\s*=\s*(["'])([0-9A-Fa-f]{6,8})\1/i,
  );
  if (srgb) {
    const value = srgb[2].length === 8 ? srgb[2].slice(2) : srgb[2];
    return `#${value.toLowerCase()}`;
  }
  return undefined;
}

async function extractChromeAndMedia(
  zip: JSZip,
  widthEmu: number,
  heightEmu: number,
): Promise<{
  chrome: TemplateInspection["chrome"];
  mediaCandidates: NonNullable<TemplateInspection["mediaCandidates"]>;
}> {
  const masterFiles = Object.keys(zip.files)
    .filter((name) => /ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(name))
    .slice(0, 4);
  const layoutFiles = Object.keys(zip.files)
    .filter((name) => /ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(name))
    .slice(0, 8);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /ppt\/slides\/slide\d+\.xml$/i.test(name))
    .slice(0, 3);
  const probeFiles = [...masterFiles, ...layoutFiles, ...slideFiles];

  let header: NonNullable<TemplateInspection["chrome"]>["header"] | undefined;
  let footer: NonNullable<TemplateInspection["chrome"]>["footer"] | undefined;
  let titleFrame: NonNullable<TemplateInspection["chrome"]>["titleFrame"] | undefined;
  let background: NonNullable<TemplateInspection["chrome"]>["background"] | undefined;
  const margins = { top: 48, right: 56, bottom: 48, left: 56 };
  const referencedMedia = new Set<string>();

  for (const file of probeFiles) {
    const xml = await zip.file(file)?.async("string");
    if (!xml) continue;

    if (!background) {
      const bgFill = extractSolidFill(xml.match(/<p:bg\b[\s\S]*?<\/p:bg>/i)?.[0] ?? "");
      if (bgFill) background = { kind: "solid", fill: bgFill };
      else if (/gradFill/i.test(xml)) background = { kind: "gradient" };
    }

    for (const rel of xml.matchAll(/Target="([^"]+)"/gi)) {
      const target = decodeXmlEntities(rel[1]).replace(/\\/g, "/");
      if (/media\//i.test(target)) {
        const entry = target.startsWith("../")
          ? `ppt/${target.replace(/^(\.\.\/)+/, "")}`
          : target.startsWith("ppt/")
            ? target
            : `ppt/${target.replace(/^\.?\/?/, "")}`;
        referencedMedia.add(entry.replace(/\/+/g, "/"));
      }
    }

    const shapes = xml.split(/<p:sp\b/i).slice(1);
    for (const shape of shapes) {
      const ph = shape.match(/<p:ph\b[^>]*>/i)?.[0];
      if (!ph) continue;
      const type = extractPlaceholderType(ph);
      const transform = extractTransform(shape);
      if (
        transform.x === undefined ||
        transform.y === undefined ||
        transform.cx === undefined ||
        transform.cy === undefined ||
        Number.isNaN(transform.x) ||
        Number.isNaN(transform.y) ||
        Number.isNaN(transform.cx) ||
        Number.isNaN(transform.cy)
      ) {
        continue;
      }
      const frame = {
        x: Math.max(0, Math.min(1280, emuToCanvas(transform.x, "x", widthEmu, heightEmu))),
        y: Math.max(0, Math.min(720, emuToCanvas(transform.y, "y", widthEmu, heightEmu))),
        w: Math.max(1, Math.min(1280, emuToCanvas(transform.cx, "x", widthEmu, heightEmu))),
        h: Math.max(1, Math.min(720, emuToCanvas(transform.cy, "y", widthEmu, heightEmu))),
      };
      const text = extractTextSnippet(shape);
      if ((type === "hdr" || type === "header") && !header) {
        header = {
          text,
          y: frame.y,
          height: Math.max(18, Math.min(120, frame.h)),
          align: frame.x > 640 ? "right" : frame.x > 320 ? "center" : "left",
        };
        margins.top = Math.max(margins.top, Math.round(frame.y + frame.h + 8));
      }
      if ((type === "ftr" || type === "footer") && !footer) {
        footer = {
          text,
          y: frame.y,
          height: Math.max(18, Math.min(120, frame.h)),
          align: frame.x > 640 ? "right" : frame.x > 320 ? "center" : "left",
        };
        margins.bottom = Math.max(margins.bottom, Math.round(720 - frame.y + 8));
      }
      if ((type === "sldnum" || type === "slidenum") && footer) {
        footer = { ...footer, pageNumber: true };
      }
      if ((type === "title" || type === "ctrTitle") && !titleFrame) {
        titleFrame = frame;
        margins.left = Math.max(margins.left, Math.round(Math.min(120, frame.x)));
        margins.right = Math.max(
          margins.right,
          Math.round(Math.min(120, 1280 - (frame.x + frame.w))),
        );
      }
    }
  }

  // Also scan bare media directory when relationship targets were sparse.
  for (const name of Object.keys(zip.files)) {
    if (/^ppt\/media\//i.test(name) && !zip.files[name]?.dir) {
      referencedMedia.add(name.replace(/\\/g, "/"));
    }
  }

  const mediaCandidates: NonNullable<TemplateInspection["mediaCandidates"]> = [];
  for (const entry of [...referencedMedia].slice(0, 24)) {
    const file = zip.file(entry);
    if (!file || file.dir) continue;
    const bytes = await file.async("nodebuffer");
    if (bytes.byteLength <= 0 || bytes.byteLength > MAX_ENTRY_BYTES) continue;
    const lower = entry.toLowerCase();
    const roleHint = /logo|brand|mark/i.test(lower)
      ? ("logo" as const)
      : /bg|background|cover/i.test(lower)
        ? ("background" as const)
        : bytes.byteLength < 120_000
          ? ("logo" as const)
          : ("decoration" as const);
    mediaCandidates.push({
      entry,
      roleHint,
      byteLength: bytes.byteLength,
    });
  }

  if (!mediaCandidates.some((item) => item.roleHint === "logo") && mediaCandidates.length > 0) {
    const smallest = [...mediaCandidates].sort(
      (left, right) => (left.byteLength ?? 0) - (right.byteLength ?? 0),
    )[0];
    if (smallest && (smallest.byteLength ?? 0) < 250_000) {
      smallest.roleHint = "logo";
    }
  }

  return {
    chrome: {
      header,
      footer,
      titleFrame,
      margins,
      background,
    },
    mediaCandidates,
  };
}

function revisionDirectory(
  library: TemplateLibraryLocation,
  templateId: string,
  revisionId: string,
): string {
  return join(library.absoluteRoot, templateRevisionSubPath(templateId, revisionId));
}

async function readLibraryIndex(library: TemplateLibraryLocation): Promise<TemplateLibraryIndex> {
  try {
    const raw = await readFile(join(library.absoluteRoot, "index.json"), "utf8");
    return templateLibraryIndexSchema.parse(JSON.parse(raw));
  } catch {
    return { version: 1, templates: [] };
  }
}

async function writeLibraryIndex(
  library: TemplateLibraryLocation,
  index: TemplateLibraryIndex,
): Promise<void> {
  await mkdir(library.absoluteRoot, { recursive: true });
  await writeFile(
    join(library.absoluteRoot, "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
    "utf8",
  );
}

function detectPackageKind(filePath: string): "pptx" | "potx" {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".potx") return "potx";
  if (extension === ".pptx") return "pptx";
  throw new Error("Only .pptx / .potx packages are accepted.");
}

function assertSafeZipEntries(zip: JSZip): { warnings: string[]; entryCount: number } {
  const warnings: string[] = [];
  let entryCount = 0;
  let uncompressed = 0;

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    entryCount += 1;
    if (entryCount > MAX_ZIP_ENTRIES) {
      throw new Error(`ZIP entry count exceeds limit (${MAX_ZIP_ENTRIES}).`);
    }
    const normalized = name.replace(/\\/g, "/");
    if (normalized.includes("..") || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) {
      throw new Error(`Unsafe ZIP entry path: ${name}`);
    }
    const lower = normalized.toLowerCase();
    if (lower.includes("vbaProject") || lower.endsWith(".bin")) {
      throw new Error("Packages with macros or binary ActiveX projects are rejected.");
    }
    const extension = extname(lower);
    if (DANGEROUS_EXTENSIONS.has(extension)) {
      throw new Error(`Rejected embedded executable entry: ${name}`);
    }
    if (lower.includes("http://") || lower.includes("https://")) {
      warnings.push(`External relationship hint in entry name: ${name}`);
    }
    // Prefer declared uncompressed size when present; otherwise defer to async reads.
    const declaredSize = Number(
      (entry as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0,
    );
    if (declaredSize > MAX_ENTRY_BYTES) {
      throw new Error(`ZIP entry too large: ${name}`);
    }
    uncompressed += declaredSize;
    if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("Uncompressed ZIP payload exceeds safety limit.");
    }
  }

  return { warnings, entryCount };
}

async function inspectPackage(
  bytes: Buffer,
  packageKind: "pptx" | "potx",
  hash: string,
): Promise<TemplateInspection> {
  const zip = await JSZip.loadAsync(bytes);
  const { warnings } = assertSafeZipEntries(zip);

  const contentTypes = await zip.file("[Content_Types].xml")?.async("string");
  if (!contentTypes?.includes("presentationml")) {
    throw new Error("File is not a valid OOXML presentation package.");
  }

  const themeFile = Object.keys(zip.files).find((name) => /theme\/theme\d*\.xml$/i.test(name));
  const themeXml = themeFile ? await zip.file(themeFile)?.async("string") : undefined;

  const themeColors: TemplateInspection["themeColors"] = {};
  if (themeXml) {
    for (const key of [
      "dk1",
      "lt1",
      "dk2",
      "lt2",
      "accent1",
      "accent2",
      "accent3",
      "accent4",
      "accent5",
      "accent6",
      "hlink",
      "folHlink",
    ] as const) {
      const value = extractThemeColor(themeXml, key);
      if (value) themeColors[key] = value;
    }
  } else {
    warnings.push("theme XML missing; color projection will use fallbacks.");
  }

  const fonts = {
    major: themeXml ? extractTypeface(themeXml, "latin") : undefined,
    minor: themeXml
      ? extractTypeface(themeXml.replace(/majorFont[\s\S]*?minorFont/, "minorFont"), "latin")
      : undefined,
    used: [] as string[],
  };
  if (themeXml) {
    const typefaces = [...themeXml.matchAll(/typeface\s*=\s*(["'])(.*?)\1/gi)]
      .map((match) => decodeXmlEntities(match[2]))
      .filter((name) => name && name !== "+mj-lt" && name !== "+mn-lt");
    fonts.used = [...new Set(typefaces)].slice(0, 24);
    fonts.major = fonts.major ?? fonts.used[0];
    fonts.minor = fonts.minor ?? fonts.used[1] ?? fonts.used[0];
  }

  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string");
  let widthEmu: number | undefined;
  let heightEmu: number | undefined;
  if (presentationXml) {
    const size = presentationXml.match(/<p:sldSz\b[^>]*>/i)?.[0];
    if (size) {
      const cx = extractAttribute(size, "cx");
      const cy = extractAttribute(size, "cy");
      widthEmu = cx ? Number(cx) : undefined;
      heightEmu = cy ? Number(cy) : undefined;
    }
  }

  let aspectRatio: string | undefined;
  if (widthEmu && heightEmu && heightEmu > 0) {
    const ratio = widthEmu / heightEmu;
    aspectRatio =
      Math.abs(ratio - 16 / 9) < 0.03
        ? "16:9"
        : Math.abs(ratio - 4 / 3) < 0.03
          ? "4:3"
          : ratio.toFixed(3);
    if (aspectRatio !== "16:9") {
      warnings.push(`Source aspect ${aspectRatio} will be regenerated on 16:9 SVG canvas.`);
    }
  }

  const masterFiles = Object.keys(zip.files).filter((name) =>
    /ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(name),
  );
  const layoutFiles = Object.keys(zip.files).filter((name) =>
    /ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(name),
  );
  const slideFiles = Object.keys(zip.files).filter((name) =>
    /ppt\/slides\/slide\d+\.xml$/i.test(name),
  );

  const masters = [];
  for (const file of masterFiles.slice(0, 32)) {
    const xml = await zip.file(file)?.async("string");
    const name =
      xml?.match(/<p:cSld\b[^>]*name\s*=\s*(["'])(.*?)\1/i)?.[2] ?? basename(file, ".xml");
    const layoutCount = xml ? (xml.match(/slideLayoutId/gi)?.length ?? 0) : 0;
    masters.push({ name: decodeXmlEntities(name), layoutCount });
  }

  const layouts = [];
  for (const file of layoutFiles.slice(0, 64)) {
    const xml = await zip.file(file)?.async("string");
    const name =
      xml?.match(/<p:cSld\b[^>]*name\s*=\s*(["'])(.*?)\1/i)?.[2] ?? basename(file, ".xml");
    const placeholderCount = xml ? (xml.match(/<p:ph\b/gi)?.length ?? 0) : 0;
    layouts.push({ name: decodeXmlEntities(name), placeholderCount });
  }

  if (Object.keys(zip.files).some((name) => /external(Link|Resource)/i.test(name))) {
    warnings.push("External links detected; they were not fetched during import.");
  }

  const resolvedWidth = widthEmu && widthEmu > 0 ? widthEmu : DEFAULT_SLIDE_WIDTH_EMU;
  const resolvedHeight = heightEmu && heightEmu > 0 ? heightEmu : DEFAULT_SLIDE_HEIGHT_EMU;
  const { chrome, mediaCandidates } = await extractChromeAndMedia(
    zip,
    resolvedWidth,
    resolvedHeight,
  );

  if (!themeColors.accent1 && !themeColors.dk1 && !themeColors.lt1) {
    warnings.push("Theme colors incomplete; pack palette uses documented fallback HEX anchors.");
  }
  if (!fonts.major && !fonts.minor) {
    warnings.push("No theme fonts detected; typography roles fall back to Inter/Segoe stacks.");
  }
  if (!chrome?.header && !chrome?.footer) {
    warnings.push("No header/footer placeholders detected; chrome inheritance disabled.");
  }
  if (!chrome?.titleFrame) {
    warnings.push("No title placeholder frame detected; titleFrame inheritance disabled.");
  }
  if (mediaCandidates.length === 0) {
    warnings.push("No reusable media candidates extracted from masters/layouts.");
  }

  return templateInspectionSchema.parse({
    version: 1,
    packageKind,
    contentHash: hash,
    byteLength: bytes.byteLength,
    importedAt: new Date().toISOString(),
    slideSize: { widthEmu, heightEmu, aspectRatio },
    themeColors,
    fonts,
    masters,
    layouts,
    sampleSlideCount: slideFiles.length,
    mediaCandidates,
    chrome,
    warnings,
    supportLevel: "design-reference",
  });
}

/**
 * Import a PPTX/POTX package as an immutable design-reference template revision.
 * Never claims master-backed fidelity.
 */
export async function importTemplatePackage(
  input: ImportTemplatePackageInput,
): Promise<ImportTemplatePackageResult> {
  const packageKind = detectPackageKind(input.sourceFilePath);
  const bytes = await readFile(input.sourceFilePath);
  if (bytes.byteLength <= 0) {
    throw new Error("Template package is empty.");
  }
  if (bytes.byteLength > MAX_PACKAGE_BYTES) {
    throw new Error(`Template package exceeds ${MAX_PACKAGE_BYTES} byte limit.`);
  }

  const hash = contentHash(bytes);
  const index = await readLibraryIndex(input.library);
  const existing = index.templates.find((item) => item.contentHash === hash);
  if (existing) {
    const revisionRoot = revisionDirectory(input.library, existing.id, existing.revisionId);
    const descriptorRaw = await readFile(join(revisionRoot, "descriptor.json"), "utf8");
    const inspectionRaw = await readFile(join(revisionRoot, "inspection.json"), "utf8");
    return {
      descriptor: templateDescriptorSchema.parse(JSON.parse(descriptorRaw)),
      inspection: templateInspectionSchema.parse(JSON.parse(inspectionRaw)),
      reusedExisting: true,
      relativeRoot:
        `${input.library.relativePrefix}/` +
        templateRevisionSubPath(existing.id, existing.revisionId),
    };
  }

  const inspection = await inspectPackage(bytes, packageKind, hash);
  const designSystem = projectDesignReferenceToDesignSystem(inspection);
  const authoringGuidance = projectDesignReferenceGuidance(inspection);
  const templateId = `uploaded/${randomUUID()}`;
  const revisionId = hash.slice("sha256:".length, "sha256:".length + 12);
  const subPath = templateRevisionSubPath(templateId, revisionId);
  const relativeRoot = `${input.library.relativePrefix}/${subPath}`;
  const absoluteRoot = join(input.library.absoluteRoot, subPath);
  await mkdir(join(absoluteRoot, "preview"), { recursive: true });

  const originalFileName = basename(input.sourceFilePath);
  const displayName =
    input.displayName?.trim() ||
    originalFileName.replace(/\.(pptx|potx)$/i, "") ||
    "Imported reference";

  const descriptor = templateDescriptorSchema.parse({
    id: templateId,
    revisionId,
    kind: "uploaded",
    supportLevel: "design-reference",
    name: displayName.slice(0, 120),
    description:
      "Uploaded PPTX/POTX design-reference. Pages are regenerated as SVG; " +
      "PowerPoint masters/placeholders are not reused.",
    designSystem,
    matching: {
      topics: ["brand", "custom", "uploaded"],
      audiences: ["指定品牌受众"],
      deliveryContexts: ["品牌定制"],
      argumentModes: [designSystem.argumentMode],
      readingModes: [designSystem.readingMode],
      density: ["standard"],
      capabilities: ["image", "chart", "table", "diagram", "long-text"],
    },
    authoringGuidance,
    source: {
      originalFileName,
      contentHash: hash,
      sourcePath: `${relativeRoot}/source.${packageKind}`,
      importedAt: inspection.importedAt,
      packageKind,
      byteLength: bytes.byteLength,
    },
    autoPoolEligible: false,
    fallbackEligible: false,
  });

  await writeFile(join(absoluteRoot, `source.${packageKind}`), bytes);
  await writeFile(
    join(absoluteRoot, "descriptor.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(absoluteRoot, "inspection.json"),
    `${JSON.stringify(inspection, null, 2)}\n`,
    "utf8",
  );

  index.templates.push({
    id: templateId,
    revisionId,
    contentHash: hash,
    name: descriptor.name,
    supportLevel: "design-reference",
    importedAt: inspection.importedAt,
  });
  await writeLibraryIndex(input.library, index);

  return {
    descriptor,
    inspection,
    reusedExisting: false,
    relativeRoot,
  };
}

export async function readTemplateRevision(
  library: TemplateLibraryLocation,
  templateId: string,
  revisionId: string,
): Promise<{
  descriptor: TemplateDescriptor;
  inspection: TemplateInspection;
  absoluteRoot: string;
}> {
  const absoluteRoot = revisionDirectory(library, templateId, revisionId);
  const descriptor = templateDescriptorSchema.parse(
    JSON.parse(await readFile(join(absoluteRoot, "descriptor.json"), "utf8")),
  );
  const inspection = templateInspectionSchema.parse(
    JSON.parse(await readFile(join(absoluteRoot, "inspection.json"), "utf8")),
  );
  return { descriptor, inspection, absoluteRoot };
}

export async function listTemplateDescriptors(
  library: TemplateLibraryLocation,
): Promise<TemplateDescriptor[]> {
  const index = await readLibraryIndex(library);
  const descriptors: TemplateDescriptor[] = [];
  for (const entry of index.templates) {
    try {
      const raw = await readFile(
        join(revisionDirectory(library, entry.id, entry.revisionId), "descriptor.json"),
        "utf8",
      );
      descriptors.push(templateDescriptorSchema.parse(JSON.parse(raw)));
    } catch {
      // Skip corrupt entries; caller can re-import.
    }
  }
  return descriptors;
}

export function listUploadedTemplateDescriptors(
  projectRootPath: string,
): Promise<TemplateDescriptor[]> {
  return listTemplateDescriptors(projectTemplateLibrary(projectRootPath));
}

/**
 * Copies an immutable revision between libraries, keeping the template id and
 * revision id so existing policy references stay valid. Idempotent per content
 * hash so re-applying a template never duplicates the package.
 */
export async function copyTemplateRevision(input: {
  from: TemplateLibraryLocation;
  to: TemplateLibraryLocation;
  templateId: string;
  revisionId: string;
}): Promise<TemplateDescriptor> {
  const sourceRoot = revisionDirectory(input.from, input.templateId, input.revisionId);
  const descriptor = templateDescriptorSchema.parse(
    JSON.parse(await readFile(join(sourceRoot, "descriptor.json"), "utf8")),
  );
  const inspectionRaw = await readFile(join(sourceRoot, "inspection.json"), "utf8");
  const inspection = templateInspectionSchema.parse(JSON.parse(inspectionRaw));

  const targetIndex = await readLibraryIndex(input.to);
  const existing = targetIndex.templates.find(
    (item) => item.contentHash === inspection.contentHash,
  );
  if (existing) {
    const existingRoot = revisionDirectory(input.to, existing.id, existing.revisionId);
    return templateDescriptorSchema.parse(
      JSON.parse(await readFile(join(existingRoot, "descriptor.json"), "utf8")),
    );
  }

  const subPath = templateRevisionSubPath(descriptor.id, descriptor.revisionId);
  const targetRoot = join(input.to.absoluteRoot, subPath);
  await mkdir(join(targetRoot, "preview"), { recursive: true });

  const packageKind = descriptor.source?.packageKind ?? inspection.packageKind;
  const packageFileName = `source.${packageKind}`;
  await writeFile(
    join(targetRoot, packageFileName),
    await readFile(join(sourceRoot, packageFileName)),
  );

  const copied = templateDescriptorSchema.parse({
    ...descriptor,
    source: descriptor.source
      ? {
          ...descriptor.source,
          sourcePath: `${input.to.relativePrefix}/${subPath}/${packageFileName}`,
        }
      : undefined,
  });
  await writeFile(
    join(targetRoot, "descriptor.json"),
    `${JSON.stringify(copied, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(targetRoot, "inspection.json"), inspectionRaw, "utf8");

  targetIndex.templates.push({
    id: copied.id,
    revisionId: copied.revisionId,
    contentHash: inspection.contentHash,
    name: copied.name,
    supportLevel: "design-reference",
    importedAt: inspection.importedAt,
  });
  await writeLibraryIndex(input.to, targetIndex);
  return copied;
}
