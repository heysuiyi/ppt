import {
  MICRO_COMPACT_ALWAYS_PRESERVE_TOOLS,
  MICRO_COMPACT_KEEP_TOOL_RESULTS,
  MICRO_COMPACT_MIN_RESULT_CHARS,
  MICRO_COMPACT_PRESERVE_LATEST_TOOLS,
  MICRO_COMPACT_PREVIEW_HEAD_CHARS,
  MICRO_COMPACT_PREVIEW_TAIL_CHARS,
} from "./config";
import type { TranscriptEntry } from "./types";

const alwaysPreserveTools = new Set<string>(MICRO_COMPACT_ALWAYS_PRESERVE_TOOLS);
const preserveLatestTools = new Set<string>(MICRO_COMPACT_PRESERVE_LATEST_TOOLS);

function isToolResultEntry(entry: TranscriptEntry): boolean {
  return (
    entry.role === "tool" ||
    entry.kind === "tool_result" ||
    (entry.role === "user" && entry.kind === "tool_result")
  );
}

function serializeResult(entry: TranscriptEntry): string {
  if (entry.result !== undefined) return JSON.stringify(entry.result);
  if (entry.error !== undefined) return String(entry.error);
  if (entry.content !== undefined) return String(entry.content);
  return "";
}

function getToolName(entry: TranscriptEntry): string {
  return typeof entry.toolName === "string" ? entry.toolName : "tool";
}

function getPersistedPath(entry: TranscriptEntry): string | undefined {
  if (!entry.modelResult || typeof entry.modelResult !== "object") return undefined;
  const persistedPath = (entry.modelResult as { persistedPath?: unknown }).persistedPath;
  return typeof persistedPath === "string" && persistedPath.trim() ? persistedPath : undefined;
}

function buildCompactedResult(entry: TranscriptEntry, serialized: string): string {
  const toolName = getToolName(entry);
  const persistedPath = getPersistedPath(entry);
  const head = serialized.slice(0, MICRO_COMPACT_PREVIEW_HEAD_CHARS);
  const tailStart = Math.max(
    MICRO_COMPACT_PREVIEW_HEAD_CHARS,
    serialized.length - MICRO_COMPACT_PREVIEW_TAIL_CHARS,
  );
  const tail = serialized.slice(tailStart);
  const omitted = Math.max(0, serialized.length - head.length - tail.length);

  return [
    `[Earlier tool result for ${toolName} was compacted under context pressure.]`,
    `Original characters: ${serialized.length}.`,
    ...(persistedPath ? [`Full structured result: ${persistedPath}`] : []),
    "Preserved preview:",
    head,
    ...(omitted > 0 ? [`\n[${omitted} characters omitted]\n`, tail] : []),
  ].join("\n");
}

function compactToolEntry(entry: TranscriptEntry): TranscriptEntry {
  const serialized = serializeResult(entry);
  const persistedPath = getPersistedPath(entry);
  const compacted: TranscriptEntry = {
    ...entry,
    compacted: true,
    compaction: {
      originalChars: serialized.length,
      ...(persistedPath ? { persistedPath } : {}),
    },
  };
  if (entry.result !== undefined) {
    compacted.result = buildCompactedResult(entry, serialized);
  }
  if (entry.content !== undefined) {
    compacted.content = buildCompactedResult(entry, serialized);
  }
  return compacted;
}

/**
 * L2: micro_compact — compact only sizeable, older tool results.
 *
 * Small results, errors, loaded skills, the latest durable workflow state, and
 * the most recent N tool results remain intact so the model can continue
 * without immediately re-reading the same state.
 */
export function microCompactTranscript(
  transcript: TranscriptEntry[],
  keepRecent = MICRO_COMPACT_KEEP_TOOL_RESULTS,
): TranscriptEntry[] {
  const toolIndices: number[] = [];
  for (let index = 0; index < transcript.length; index += 1) {
    if (isToolResultEntry(transcript[index])) {
      toolIndices.push(index);
    }
  }

  if (toolIndices.length <= keepRecent) return transcript;

  const keepSet = new Set(toolIndices.slice(-keepRecent));
  const latestPreservedToolIndices = new Map<string, number>();
  for (let index = toolIndices.length - 1; index >= 0; index -= 1) {
    const transcriptIndex = toolIndices[index];
    const toolName = getToolName(transcript[transcriptIndex]);
    if (preserveLatestTools.has(toolName) && !latestPreservedToolIndices.has(toolName)) {
      latestPreservedToolIndices.set(toolName, transcriptIndex);
    }
  }
  for (const index of latestPreservedToolIndices.values()) keepSet.add(index);

  return transcript.map((entry, index) => {
    if (!toolIndices.includes(index)) return entry;
    if (keepSet.has(index)) return entry;
    if (alwaysPreserveTools.has(getToolName(entry))) return entry;
    if (entry.error !== undefined) return entry;
    if (entry.compacted) return entry;
    if (serializeResult(entry).length < MICRO_COMPACT_MIN_RESULT_CHARS) return entry;
    return compactToolEntry(entry);
  });
}

export function measureToolResultBytes(entry: TranscriptEntry): number {
  return new TextEncoder().encode(serializeResult(entry)).length;
}
