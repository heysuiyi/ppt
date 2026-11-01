import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export const DEFAULT_MODEL_TOOL_RESULT_CHARS = 6_000;
const EMPTY_RESULT_MARKER = "[Tool completed successfully with no output.]";

export interface PreparedToolResult<T> {
  /** Rich local result retained for hooks, UI traces, and persistence. */
  data: T;
  /** Compact result sent back through the model protocol. */
  modelContent: string;
  originalChars: number;
  truncated: boolean;
  persistedPath?: string;
  persistenceError?: string;
}

export interface PrepareToolResultOptions<T> {
  data: T;
  modelContent?: string;
  workspaceRoot?: string;
  threadId: string;
  toolUseId: string;
  toolName: string;
  maxChars?: number;
}

function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

function serializeForStorage(value: unknown): string {
  if (value === undefined) return "null";
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return JSON.stringify({ unstructuredResult: String(value) }, null, 2);
  }
}

function safeSegment(value: string, fallback: string): string {
  const safe = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || fallback;
}

async function persistResult<T>(options: PrepareToolResultOptions<T>): Promise<string | undefined> {
  if (!options.workspaceRoot) return undefined;

  const thread = safeSegment(options.threadId, "thread");
  const tool = safeSegment(options.toolName, "tool");
  const call = safeSegment(options.toolUseId, "call");
  const filePath = join(
    options.workspaceRoot,
    ".task_outputs",
    "tool-results",
    thread,
    `${call}-${tool}-${Date.now()}.json`,
  );
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(temporaryPath, serializeForStorage(options.data), "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return relative(options.workspaceRoot, filePath).replace(/\\/g, "/");
}

/**
 * Separate the rich local tool result from the compact provider-facing result.
 * Oversized payloads are atomically stored under the workspace and only a
 * bounded preview plus recovery path is returned to the model.
 */
export async function prepareToolResultData<T>(
  options: PrepareToolResultOptions<T>,
): Promise<PreparedToolResult<T>> {
  const maxChars = options.maxChars ?? DEFAULT_MODEL_TOOL_RESULT_CHARS;
  const rawContent = (options.modelContent ?? stringifyResult(options.data)).trim();
  const content = rawContent || EMPTY_RESULT_MARKER;

  if (content.length <= maxChars) {
    return {
      data: options.data,
      modelContent: content,
      originalChars: content.length,
      truncated: false,
    };
  }

  let persistedPath: string | undefined;
  let persistenceError: string | undefined;
  try {
    persistedPath = await persistResult(options);
  } catch (error) {
    persistenceError = error instanceof Error ? error.message : String(error);
  }

  const location = persistedPath
    ? `Full structured result: ${persistedPath}`
    : "Full structured result was not persisted because no writable workspace was available.";
  const previewBudget = Math.max(0, maxChars - location.length - 80);
  const preview = content.slice(0, previewBudget);

  return {
    data: options.data,
    modelContent: [
      `[Tool result truncated from ${content.length} characters.]`,
      location,
      "Preview:",
      preview,
    ].join("\n"),
    originalChars: content.length,
    truncated: true,
    persistedPath,
    persistenceError,
  };
}
