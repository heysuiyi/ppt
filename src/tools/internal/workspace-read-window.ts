import { WorkspaceFileError } from "./workspace-file-types";

export function assertReadWindowNumber(
  name: "offset" | "limit",
  value: number,
  bounds: { min: number; max?: number },
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < bounds.min ||
    (bounds.max !== undefined && value > bounds.max)
  ) {
    const range =
      bounds.max === undefined
        ? `at least ${bounds.min}`
        : `between ${bounds.min} and ${bounds.max}`;
    throw new WorkspaceFileError(
      "INVALID_READ_RANGE",
      `ReadFile ${name} must be a safe integer ${range}.`,
    );
  }
}

export function splitsSurrogatePair(content: string, offset: number): boolean {
  if (offset <= 0 || offset >= content.length) return false;
  const previous = content.charCodeAt(offset - 1);
  const current = content.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
}

export function unicodeSafeEndOffset(content: string, offset: number, limit: number): number {
  let end = Math.min(content.length, offset + limit);
  if (!splitsSurrogatePair(content, end)) return end;
  if (end === offset + 1) {
    end += 1;
  } else {
    end -= 1;
  }
  return end;
}

export function mergeCoverageRanges(
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = ranges
    .filter((range) => range.end >= range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}
