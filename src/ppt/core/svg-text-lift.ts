/**
 * Lift SVG `<text>` nodes into PowerPoint-native text boxes and strip them from
 * the background SVG so hybrid export does not double-draw glyphs.
 *
 * Product dialect only: no foreignObject/CSS. Skips defs/symbol, textPath,
 * display:none, and text elements with a transform attribute.
 */

export const SVG_PAGE_WIDTH_PX = 1_280;
export const SVG_PAGE_HEIGHT_PX = 720;
export const PPTX_SLIDE_WIDTH_IN = 10;
export const PPTX_SLIDE_HEIGHT_IN = 5.625;

const PX_TO_IN = PPTX_SLIDE_WIDTH_IN / SVG_PAGE_WIDTH_PX;
const PX_TO_PT = 72 * PX_TO_IN;
const BASELINE_TO_TOP = 0.8;
const MIN_BOX_HEIGHT_IN = 0.2;
/** Full-width (CJK) glyphs advance about one em; proportional Latin about 0.58 em. */
const FULL_WIDTH_ADVANCE = 1;
const HALF_WIDTH_ADVANCE = 0.58;
const WIDTH_SAFETY = 1.04;
const DEFAULT_LINE_ADVANCE = 1.25;
const FULL_WIDTH_PATTERN =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE6F\uFF00-\uFF60]/;

export type LiftedTextAlign = "left" | "center" | "right";

export interface LiftedText {
  content: string;
  xIn: number;
  yIn: number;
  wIn: number;
  hIn: number;
  fontSizePt: number;
  fontFace: string;
  color: string;
  bold: boolean;
  align: LiftedTextAlign;
  charSpacingPt: number;
  lineSpacingPt: number;
}

export interface SvgTextLiftResult {
  backgroundSvg: string;
  texts: LiftedText[];
}

interface TextCandidate {
  start: number;
  end: number;
  openAttrs: string;
  inner: string;
}

const SKIP_REGION_TAGS = ["defs", "symbol", "clipPath", "mask"] as const;

export function liftSvgText(markup: string): SvgTextLiftResult {
  if (!markup.includes("<text")) {
    return { backgroundSvg: markup, texts: [] };
  }

  const skipRanges = collectSkipRanges(markup);
  const candidates = findTextElements(markup).filter(
    (candidate) => !isInsideAnyRange(candidate.start, skipRanges),
  );

  const texts: LiftedText[] = [];
  const removeRanges: Array<{ start: number; end: number }> = [];

  for (const candidate of candidates) {
    const lifted = tryLiftText(candidate.openAttrs, candidate.inner);
    if (!lifted) continue;
    texts.push(lifted);
    removeRanges.push({ start: candidate.start, end: candidate.end });
  }

  if (texts.length === 0) {
    return { backgroundSvg: markup, texts: [] };
  }

  const backgroundSvg = removeRangesFromString(markup, removeRanges);
  return { backgroundSvg, texts };
}

export function expectedExportSvgHashSource(markup: string): string {
  const lifted = liftSvgText(markup);
  return lifted.texts.length > 0 ? lifted.backgroundSvg : markup;
}

function tryLiftText(openAttrs: string, inner: string): LiftedText | null {
  if (/\btransform\s*=/i.test(openAttrs)) return null;
  if (/display\s*:\s*none/i.test(openAttrs)) return null;
  if (/\bdisplay\s*=\s*["']none["']/i.test(openAttrs)) return null;
  if (/<textPath\b/i.test(inner)) return null;

  const attrs = parseXmlAttributes(openAttrs);
  const style = parseStyleAttribute(attrs.get("style") ?? "");
  const fontSizePx = parseFontSize(attrs.get("font-size") ?? style["font-size"] ?? "16");
  if (!(fontSizePx > 0)) return null;

  const extracted = extractTextContent(inner);
  const content = extracted.content;
  if (!content.trim()) return null;

  const xPx = parseNumber(attrs.get("x") ?? style.x ?? "0") ?? 0;
  const yPx = parseNumber(attrs.get("y") ?? style.y ?? "0") ?? 0;
  const anchor = (attrs.get("text-anchor") ?? style["text-anchor"] ?? "start").trim().toLowerCase();
  const align = anchorToAlign(anchor);
  const fill = normalizeColor(attrs.get("fill") ?? style.fill ?? "#000000");
  const fontFace = firstFontFamily(attrs.get("font-family") ?? style["font-family"] ?? "Arial");
  const bold = isBold(attrs.get("font-weight") ?? style["font-weight"] ?? "normal");
  const letterSpacingPx =
    parseNumber(attrs.get("letter-spacing") ?? style["letter-spacing"] ?? "0") ?? 0;

  const lines = content.split("\n");
  const lineAdvancePx = extracted.lineAdvancePx ?? fontSizePx * DEFAULT_LINE_ADVANCE;
  const estimatedWidthPx =
    Math.max(
      ...lines.map((line) => measureLineWidthPx(line, fontSizePx, letterSpacingPx)),
      fontSizePx,
    ) * WIDTH_SAFETY;
  const heightPx = lineAdvancePx * lines.length;

  let leftPx = xPx;
  if (align === "center") leftPx = xPx - estimatedWidthPx / 2;
  if (align === "right") leftPx = xPx - estimatedWidthPx;

  // PowerPoint places the first baseline about 0.8 of a line box below the top,
  // so anchor the frame on the SVG baseline using the same line advance.
  const topPx = yPx - lineAdvancePx * BASELINE_TO_TOP;
  const clamped = clampBox(leftPx, topPx, estimatedWidthPx, heightPx);

  return {
    content,
    xIn: clamped.x * PX_TO_IN,
    yIn: clamped.y * PX_TO_IN,
    wIn: clamped.w * PX_TO_IN,
    hIn: Math.max(clamped.h * PX_TO_IN, MIN_BOX_HEIGHT_IN),
    fontSizePt: fontSizePx * PX_TO_PT,
    fontFace,
    color: fill,
    bold,
    align,
    charSpacingPt: letterSpacingPx * PX_TO_PT,
    lineSpacingPt: lineAdvancePx * PX_TO_PT,
  };
}

function findTextElements(markup: string): TextCandidate[] {
  const results: TextCandidate[] = [];
  const openRe = /<text\b([^>]*)>/gi;
  let openMatch = openRe.exec(markup);
  while (openMatch !== null) {
    const start = openMatch.index;
    const openAttrs = openMatch[1] ?? "";
    const afterOpen = start + openMatch[0].length;
    if (/\/>\s*$/.test(openMatch[0])) {
      openMatch = openRe.exec(markup);
      continue;
    }

    const closeIndex = findMatchingClose(markup, afterOpen, "text");
    if (closeIndex < 0) {
      openMatch = openRe.exec(markup);
      continue;
    }
    const end = closeIndex + "</text>".length;
    const inner = markup.slice(afterOpen, closeIndex);
    results.push({ start, end, openAttrs, inner });
    openRe.lastIndex = end;
    openMatch = openRe.exec(markup);
  }
  return results;
}

function findMatchingClose(markup: string, from: number, tag: string): number {
  const openPattern = new RegExp(`<${tag}\\b`, "gi");
  const closePattern = new RegExp(`</${tag}\\s*>`, "gi");
  let depth = 1;
  let cursor = from;
  while (depth > 0 && cursor < markup.length) {
    openPattern.lastIndex = cursor;
    closePattern.lastIndex = cursor;
    const nextOpen = openPattern.exec(markup);
    const nextClose = closePattern.exec(markup);
    if (!nextClose) return -1;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
      continue;
    }
    depth -= 1;
    if (depth === 0) return nextClose.index;
    cursor = nextClose.index + nextClose[0].length;
  }
  return -1;
}

function collectSkipRanges(markup: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const tag of SKIP_REGION_TAGS) {
    const openRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    let match = openRe.exec(markup);
    while (match !== null) {
      if (/\/>\s*$/.test(match[0])) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
        match = openRe.exec(markup);
        continue;
      }
      const closeIndex = findMatchingClose(markup, match.index + match[0].length, tag);
      if (closeIndex < 0) {
        match = openRe.exec(markup);
        continue;
      }
      const end = closeIndex + `</${tag}>`.length;
      ranges.push({ start: match.index, end });
      openRe.lastIndex = end;
      match = openRe.exec(markup);
    }
  }
  return ranges;
}

function isInsideAnyRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function removeRangesFromString(
  value: string,
  ranges: Array<{ start: number; end: number }>,
): string {
  const sorted = [...ranges].sort((a, b) => b.start - a.start);
  let result = value;
  for (const range of sorted) {
    result = result.slice(0, range.start) + result.slice(range.end);
  }
  return result;
}

function extractTextContent(inner: string): { content: string; lineAdvancePx?: number } {
  // Prefer tspan-aware extraction so dy-separated lines become newlines.
  const tspanRe = /<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/gi;
  const tspans: Array<{ attrs: string; body: string; index: number }> = [];
  let match = tspanRe.exec(inner);
  while (match !== null) {
    tspans.push({
      attrs: match[1] ?? "",
      body: match[2] ?? "",
      index: match.index,
    });
    match = tspanRe.exec(inner);
  }

  if (tspans.length > 0) {
    const lines: string[] = [];
    let lineAdvancePx: number | undefined;
    for (const tspan of tspans) {
      const attrs = parseXmlAttributes(tspan.attrs);
      const dy = parseNumber(attrs.get("dy") ?? "");
      const piece = decodeXmlEntities(stripTags(tspan.body)).trim();
      if (!piece) continue;
      if (lines.length > 0 && dy !== null && dy !== 0) {
        lines.push(piece);
        lineAdvancePx ??= Math.abs(dy);
      } else if (lines.length === 0) {
        lines.push(piece);
      } else {
        lines[lines.length - 1] = `${lines[lines.length - 1]} ${piece}`;
      }
    }
    return {
      content: lines.join("\n"),
      ...(lineAdvancePx !== undefined ? { lineAdvancePx } : {}),
    };
  }

  return {
    content: decodeXmlEntities(stripTags(inner)).replace(/\s+/g, " ").trim(),
  };
}

/**
 * Approximate the advance width of one rendered line. Without real font
 * metrics this only needs to be close enough that centered boxes stay centered;
 * export disables wrapping so a small underestimate cannot reflow the text.
 */
function measureLineWidthPx(line: string, fontSizePx: number, letterSpacingPx: number): number {
  let width = 0;
  for (const char of line) {
    width += fontSizePx * (FULL_WIDTH_PATTERN.test(char) ? FULL_WIDTH_ADVANCE : HALF_WIDTH_ADVANCE);
    width += letterSpacingPx;
  }
  return width;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function parseXmlAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = re.exec(raw);
  while (match !== null) {
    attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? "");
    match = re.exec(raw);
  }
  return attrs;
}

function parseStyleAttribute(style: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function parseNumber(value: string): number | null {
  const match = value.trim().match(/^[-+]?(?:\d+\.?\d*|\.\d+)/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function parseFontSize(value: string): number {
  return parseNumber(value) ?? 16;
}

function anchorToAlign(anchor: string): LiftedTextAlign {
  if (anchor === "middle") return "center";
  if (anchor === "end") return "right";
  return "left";
}

function firstFontFamily(value: string): string {
  const first = value.split(",")[0]?.trim() ?? "Arial";
  return first.replace(/^["']|["']$/g, "") || "Arial";
}

function isBold(weight: string): boolean {
  const normalized = weight.trim().toLowerCase();
  if (normalized === "bold" || normalized === "bolder") return true;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric >= 600;
}

function normalizeColor(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.slice(1).toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  const rgb = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    return [rgb[1], rgb[2], rgb[3]]
      .map((part) => Number(part).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }
  if (/^[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toUpperCase();
  return "000000";
}

function clampBox(
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  let left = x;
  let top = y;
  let width = w;
  let height = h;
  if (left < 0) {
    width += left;
    left = 0;
  }
  if (top < 0) {
    height += top;
    top = 0;
  }
  if (left + width > SVG_PAGE_WIDTH_PX) {
    width = SVG_PAGE_WIDTH_PX - left;
  }
  if (top + height > SVG_PAGE_HEIGHT_PX) {
    height = SVG_PAGE_HEIGHT_PX - top;
  }
  return {
    x: left,
    y: top,
    w: Math.max(width, 1),
    h: Math.max(height, 1),
  };
}
