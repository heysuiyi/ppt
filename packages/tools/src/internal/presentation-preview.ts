/** 展示副本独立于规范结果；UTF-16 行宽与 UTF-8 总预算都不影响执行/模型结果。 */
export const PRESENTATION_MAX_LINES = 200;
export const PRESENTATION_MAX_LINE_LENGTH = 2000;
export const PRESENTATION_MAX_BYTES = 128 * 1024;

/** 截断只发生在 Unicode 码点边界；省略号也计入预算。 */
export function presentationLabel(text: string, maxBytes = PRESENTATION_MAX_BYTES): string {
  let end = 0;
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (end + character.length > PRESENTATION_MAX_LINE_LENGTH || bytes + size > maxBytes) break;
    end += character.length;
    bytes += size;
  }
  if (end === text.length) return text;
  if (maxBytes < 3) return "";
  while (end > 0 && (end + 1 > PRESENTATION_MAX_LINE_LENGTH || bytes + 3 > maxBytes)) {
    const last = text.charCodeAt(end - 1);
    const size = last >= 0xdc00 && last <= 0xdfff && end > 1 ? 2 : 1;
    bytes -= Buffer.byteLength(text.slice(end - size, end), "utf8");
    end -= size;
  }
  return `${text.slice(0, end)}…`;
}

/** CRLF 是换行；孤立 CR 采用终端最后一次覆盖后的段，绝不保留控制符。 */
export function presentationLine(text: string): string {
  const withoutEnding = text.endsWith("\r") ? text.slice(0, -1) : text;
  return withoutEnding.slice(withoutEnding.lastIndexOf("\r") + 1);
}

function* textLines(text: string): Generator<string> {
  let offset = 0;
  while (true) {
    const end = text.indexOf("\n", offset);
    yield text.slice(offset, end < 0 ? text.length : end);
    if (end < 0) return;
    offset = end + 1;
  }
}

export function presentationPreview(text: string | readonly string[]): {
  preview: string[];
  previewTruncated: boolean;
} {
  const preview: string[] = [];
  let remaining = PRESENTATION_MAX_BYTES;
  let previewTruncated = false;
  for (const source of typeof text === "string" ? textLines(text) : text) {
    if (preview.length === PRESENTATION_MAX_LINES || remaining < 4) {
      previewTruncated = true;
      break;
    }
    const value = presentationLine(source);
    const clipped = presentationLabel(value, remaining - 1);
    preview.push(clipped);
    remaining -= Buffer.byteLength(clipped, "utf8") + 1;
    previewTruncated ||= clipped !== value;
  }
  return { preview, previewTruncated };
}
