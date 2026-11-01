import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_RESULT_BUDGET_BYTES, TOOL_RESULT_PREVIEW_CHARS, TOOL_RESULTS_DIR } from "./config";
import { measureToolResultBytes } from "./micro-compact";
import type { TranscriptEntry } from "./types";

function isToolResultEntry(entry: TranscriptEntry): boolean {
  return (
    entry.role === "tool" ||
    entry.kind === "tool_result" ||
    (entry.role === "user" && entry.kind === "tool_result")
  );
}

/** Indices of the trailing tool-result block (since last non-tool entry). */
export function findLastToolResultBlock(transcript: TranscriptEntry[]): number[] {
  const indices: number[] = [];
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (isToolResultEntry(transcript[index])) {
      indices.unshift(index);
    } else {
      break;
    }
  }
  return indices;
}

function serializeFullResult(entry: TranscriptEntry): string {
  if (entry.result !== undefined) {
    return typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result, null, 2);
  }
  if (entry.content !== undefined) {
    return typeof entry.content === "string"
      ? entry.content
      : JSON.stringify(entry.content, null, 2);
  }
  if (entry.error !== undefined) return String(entry.error);
  return "";
}

function buildPersistedMarker(relativePath: string, toolName: string, preview: string): string {
  return `<persisted-output path="${relativePath}" tool="${toolName}">\n${preview}\n</persisted-output>`;
}

async function persistToolResult(
  workspaceRoot: string,
  _entry: TranscriptEntry,
  fullText: string,
): Promise<{ relativePath: string; preview: string }> {
  const id = randomUUID();
  const relativePath = `${TOOL_RESULTS_DIR}/${id}.txt`;
  const absolutePath = join(workspaceRoot, relativePath);
  await mkdir(join(workspaceRoot, TOOL_RESULTS_DIR), { recursive: true });
  await writeFile(absolutePath, fullText, "utf8");

  const preview =
    fullText.length <= TOOL_RESULT_PREVIEW_CHARS
      ? fullText
      : `${fullText.slice(0, TOOL_RESULT_PREVIEW_CHARS)}…`;

  return { relativePath, preview };
}

function applyPersistedResult(
  entry: TranscriptEntry,
  relativePath: string,
  preview: string,
): TranscriptEntry {
  const toolName = typeof entry.toolName === "string" ? entry.toolName : "tool";
  const marker = buildPersistedMarker(relativePath, toolName, preview);
  const next: TranscriptEntry = { ...entry, persisted: true };
  if (entry.result !== undefined) {
    next.result = marker;
  } else {
    next.content = marker;
  }
  return next;
}

/**
 * L3: tool_result_budget — spill oversized trailing tool results to disk.
 */
export async function toolResultBudget(
  transcript: TranscriptEntry[],
  workspaceRoot: string | undefined,
  budgetBytes = TOOL_RESULT_BUDGET_BYTES,
): Promise<{ transcript: TranscriptEntry[]; notes: string[] }> {
  const notes: string[] = [];
  if (!workspaceRoot) return { transcript, notes };

  const blockIndices = findLastToolResultBlock(transcript);
  if (blockIndices.length === 0) return { transcript, notes };

  let totalBytes = blockIndices.reduce(
    (sum, index) => sum + measureToolResultBytes(transcript[index]),
    0,
  );
  if (totalBytes <= budgetBytes) return { transcript, notes };

  const sorted = [...blockIndices].sort(
    (left, right) =>
      measureToolResultBytes(transcript[right]) - measureToolResultBytes(transcript[left]),
  );

  const next = [...transcript];
  for (const index of sorted) {
    if (totalBytes <= budgetBytes) break;
    const entry = next[index];
    if (entry.persisted) continue;

    const fullText = serializeFullResult(entry);
    const entryBytes = new TextEncoder().encode(fullText).length;
    if (entryBytes === 0) continue;

    const { relativePath, preview } = await persistToolResult(workspaceRoot, entry, fullText);
    next[index] = applyPersistedResult(entry, relativePath, preview);
    totalBytes -= entryBytes - new TextEncoder().encode(preview).length;
    notes.push(`Persisted oversized tool result to ${relativePath}.`);
  }

  return { transcript: next, notes };
}
