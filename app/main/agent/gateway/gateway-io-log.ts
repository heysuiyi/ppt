import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { getLogContext } from "../../logging/log-context";
import type {
  AgentModelContentBlock,
  AgentModelImageBlock,
  AgentModelMessage,
  AgentModelResponse,
  AgentToolSchema,
  PreparedAgentModelRequest,
} from "./types";

export const GATEWAY_IO_LOG_DIRECTORY_NAME = "gateway";
export const GATEWAY_IO_LOG_ENV = "AGENT_GATEWAY_IO_LOG";

export type GatewayIoLogKind = "query" | "stream";
export type GatewayIoLogStatus = "completed" | "failed";

export interface GatewayIoLogRequestPayload {
  systemPrompt?: string;
  messages: AgentModelMessage[];
  tools?: AgentToolSchema[];
  maxOutputTokens: number;
  systemPromptLength: number;
  messageCount: number;
  toolNames: string[];
}

export interface GatewayIoLogResponsePayload {
  provider: string;
  model: string;
  content: AgentModelContentBlock[];
  stopReason?: string;
  usage?: Record<string, unknown>;
  requestId?: string;
  textLength: number;
}

export interface GatewayIoLogEntry {
  gatewayRequestId: string;
  kind: GatewayIoLogKind;
  status: GatewayIoLogStatus;
  provider: string;
  model: string;
  callPath: string;
  startedAt: string;
  durationMs: number;
  context: {
    operation?: string;
    sessionId?: string;
    runId?: string;
    threadId?: string;
    queryId?: string;
  };
  request: GatewayIoLogRequestPayload;
  response?: GatewayIoLogResponsePayload;
  error?: {
    name: string;
    message: string;
    code?: unknown;
    provider?: unknown;
  };
}

/**
 * End-to-end model I/O archive for design-skill verification.
 * Writes under the application logs root: `<logs>/gateway/YYYY-MM-DD/<id>.json`.
 * Logging is observational and must never fail the model call.
 */
export function isGatewayIoLogEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment[GATEWAY_IO_LOG_ENV]?.trim().toLowerCase();
  if (value === "false" || value === "0" || value === "off") return false;
  return true;
}

export function getGatewayIoLogDirectory(root: string): string {
  return path.join(root, GATEWAY_IO_LOG_DIRECTORY_NAME);
}

function sanitizeImageData<TMedia extends AgentModelImageBlock["mediaType"]>(
  mediaType: TMedia,
  data: string,
): AgentModelImageBlock {
  return {
    type: "image",
    mediaType,
    data: `[omitted ${data.length} characters]`,
  };
}

function sanitizeThinkingBlock(block: AgentModelContentBlock): AgentModelContentBlock {
  if (block.type === "thinking") {
    return {
      type: "thinking",
      thinking: block.thinking,
      signature:
        block.signature.length > 64
          ? `${block.signature.slice(0, 32)}...[${block.signature.length} characters]`
          : block.signature,
    };
  }
  if (block.type === "redacted_thinking") {
    return {
      type: "redacted_thinking",
      data: `[omitted ${block.data.length} characters]`,
    };
  }
  return block;
}

function sanitizeContentBlocks(blocks: AgentModelContentBlock[]): AgentModelContentBlock[] {
  return blocks.map((block) => {
    if (block.type === "image") {
      return sanitizeImageData(block.mediaType, block.data) as AgentModelContentBlock;
    }
    if (block.type === "tool_result") {
      return {
        ...block,
        content: block.content.map((item) =>
          item.type === "image" ? sanitizeImageData(item.mediaType, item.data) : item,
        ),
      };
    }
    return sanitizeThinkingBlock(block);
  });
}

function textLengthFromBlocks(blocks: AgentModelContentBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    if (block.type === "text") total += block.text.length;
  }
  return total;
}

export function buildGatewayIoLogRequest(
  prepared: PreparedAgentModelRequest,
): GatewayIoLogRequestPayload {
  return {
    ...(prepared.systemPrompt !== undefined ? { systemPrompt: prepared.systemPrompt } : {}),
    messages: structuredClone(prepared.messages),
    ...(prepared.tools ? { tools: structuredClone(prepared.tools) } : {}),
    maxOutputTokens: prepared.maxOutputTokens,
    systemPromptLength: prepared.systemPrompt?.length ?? 0,
    messageCount: prepared.messages.length,
    toolNames: prepared.tools?.map((tool) => tool.name) ?? [],
  };
}

export function buildGatewayIoLogResponse(
  response: AgentModelResponse,
): GatewayIoLogResponsePayload {
  return {
    provider: response.provider,
    model: response.model,
    content: sanitizeContentBlocks(structuredClone(response.content)),
    ...(response.stopReason !== undefined ? { stopReason: response.stopReason } : {}),
    ...(response.usage
      ? { usage: { ...(response.usage as unknown as Record<string, unknown>) } }
      : {}),
    ...(response.requestId !== undefined ? { requestId: response.requestId } : {}),
    textLength: textLengthFromBlocks(response.content),
  };
}

export function serializeGatewayIoLogError(error: unknown): GatewayIoLogEntry["error"] {
  if (error instanceof Error) {
    const details = error as Error & { code?: unknown; provider?: unknown };
    return {
      name: error.name,
      message: error.message,
      ...(details.code !== undefined ? { code: details.code } : {}),
      ...(details.provider !== undefined ? { provider: details.provider } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

export function buildGatewayIoLogEntry(input: {
  gatewayRequestId: string;
  kind: GatewayIoLogKind;
  status: GatewayIoLogStatus;
  provider: string;
  model: string;
  callPath: string;
  startedAt: Date;
  durationMs: number;
  request: GatewayIoLogRequestPayload;
  response?: AgentModelResponse;
  error?: unknown;
}): GatewayIoLogEntry {
  const context = getLogContext();
  return {
    gatewayRequestId: input.gatewayRequestId,
    kind: input.kind,
    status: input.status,
    provider: input.provider,
    model: input.model,
    callPath: input.callPath,
    startedAt: input.startedAt.toISOString(),
    durationMs: input.durationMs,
    context: {
      ...(context.operation !== undefined ? { operation: context.operation } : {}),
      ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
      ...(context.runId !== undefined ? { runId: context.runId } : {}),
      ...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
      ...(context.queryId !== undefined ? { queryId: context.queryId } : {}),
    },
    request: input.request,
    ...(input.response ? { response: buildGatewayIoLogResponse(input.response) } : {}),
    ...(input.error !== undefined ? { error: serializeGatewayIoLogError(input.error) } : {}),
  };
}

export function gatewayIoLogRelativePath(entry: GatewayIoLogEntry): string {
  const day = entry.startedAt.slice(0, 10);
  return path.join(GATEWAY_IO_LOG_DIRECTORY_NAME, day, `${entry.gatewayRequestId}.json`);
}

const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile") as {
  lock(
    file: string,
    options: {
      realpath: boolean;
      stale: number;
      update: number;
      retries: number;
      onCompromised(error: Error): void;
    },
  ): Promise<() => Promise<void>>;
};
const operations = new Map<string, Promise<unknown>>();
const DAY_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/;
const ARCHIVE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

function enqueueGatewayIoOperation<T>(
  root: string,
  task: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = path.resolve(getGatewayIoLogDirectory(root));
  const previous = operations.get(directory) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await fs.promises.mkdir(directory, { recursive: true });
      const stat = await fs.promises.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Gateway archive directory is not an owned directory.");
      }
      return await task(directory);
    });
  operations.set(directory, next);
  void next
    .finally(() => {
      if (operations.get(directory) === next) operations.delete(directory);
    })
    .catch(() => undefined);
  return next;
}

async function withGatewayFileLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  // A crashed writer protects only its own artifact, never future random request IDs.
  const release = await lockfile.lock(file, {
    realpath: false,
    stale: Number.MAX_SAFE_INTEGER,
    update: 10_000,
    retries: 0,
    onCompromised() {
      try {
        process.stderr.write("Gateway I/O archive lock compromised.\n");
      } catch {
        // Diagnostics cannot interrupt model execution.
      }
    },
  });
  try {
    return await task();
  } finally {
    await release();
  }
}

export async function writeGatewayIoLog(
  entry: GatewayIoLogEntry,
  root: string,
): Promise<string | undefined> {
  if (!isGatewayIoLogEnabled()) return undefined;
  try {
    if (
      !DAY_DIRECTORY.test(entry.startedAt.slice(0, 10)) ||
      !ARCHIVE_FILE.test(`${entry.gatewayRequestId}.json`)
    )
      return undefined;
    return await enqueueGatewayIoOperation(root, async (directory) => {
      const dayDirectory = path.join(directory, entry.startedAt.slice(0, 10));
      await fs.promises.mkdir(dayDirectory, { recursive: true });
      const stat = await fs.promises.lstat(dayDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
      const absolute = path.join(dayDirectory, `${entry.gatewayRequestId}.json`);
      return await withGatewayFileLock(absolute, async () => {
        await fs.promises.writeFile(absolute, `${JSON.stringify(entry, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        return absolute;
      });
    });
  } catch {
    try {
      process.stderr.write("Gateway I/O archive write failed.\n");
    } catch {
      // Observational path; never throw.
    }
    return undefined;
  }
}

export class GatewayIoLogManagementError extends Error {
  constructor(
    readonly removedFiles: number,
    readonly skipped: string[],
  ) {
    super("Gateway I/O archive management skipped unsafe or unavailable files.");
    this.name = "GatewayIoLogManagementError";
  }
}

async function visitGatewayIoFiles(
  directory: string,
  visit: (file: string, stat: fs.Stats) => Promise<void>,
  acceptDay: (day: string) => boolean = () => true,
  skipped?: string[],
): Promise<void> {
  const days = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const day of days) {
    const dayDirectory = path.join(directory, day.name);
    if (!day.isDirectory() || !DAY_DIRECTORY.test(day.name)) {
      skipped?.push(`${dayDirectory}: unknown archive entry or symbolic link`);
      continue;
    }
    if (!acceptDay(day.name)) continue;
    try {
      const dayStat = await fs.promises.lstat(dayDirectory);
      if (!dayStat.isDirectory() || dayStat.isSymbolicLink()) {
        skipped?.push(`${dayDirectory}: not an owned archive directory`);
        continue;
      }
      const files = await fs.promises.readdir(dayDirectory, { withFileTypes: true });
      for (const file of files) {
        const absolute = path.join(dayDirectory, file.name);
        if (!file.isFile() || !ARCHIVE_FILE.test(file.name)) {
          skipped?.push(`${absolute}: unknown archive file or symbolic link`);
          continue;
        }
        try {
          const stat = await fs.promises.lstat(absolute);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            skipped?.push(`${absolute}: not an owned archive file`);
            continue;
          }
          await visit(absolute, stat);
        } catch (error) {
          if (!skipped && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
          if (!skipped) throw error;
          skipped.push(`${absolute}: archive operation failed`);
        }
      }
    } catch (error) {
      if (!skipped && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (!skipped) throw error;
      skipped.push(`${dayDirectory}: archive directory operation failed`);
    }
  }
}

async function removeGatewayIoFiles(
  root: string,
  acceptDay?: (day: string) => boolean,
): Promise<number> {
  return await enqueueGatewayIoOperation(root, async (directory) => {
    let removed = 0;
    const skipped: string[] = [];
    try {
      await visitGatewayIoFiles(
        directory,
        async (file) => {
          await withGatewayFileLock(file, async () => {
            const stat = await fs.promises.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink()) {
              throw new Error("Gateway archive file is no longer an owned file.");
            }
            await fs.promises.unlink(file);
            removed += 1;
          });
        },
        acceptDay,
        skipped,
      );
    } catch {
      skipped.push(`${directory}: archive enumeration failed`);
    }
    if (skipped.length > 0) throw new GatewayIoLogManagementError(removed, skipped);
    return removed;
  });
}

export async function clearGatewayIoLogFiles(root: string): Promise<number> {
  return await removeGatewayIoFiles(root);
}

export async function pruneGatewayIoLogFiles(
  retentionDays: number,
  now: Date,
  root: string,
): Promise<number> {
  // Archive dates derive from startedAt.toISOString(), so retention uses UTC too.
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(1, Math.trunc(retentionDays)) + 1);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  return await removeGatewayIoFiles(root, (day) => day < cutoffKey);
}

export async function measureGatewayIoLogUsage(root: string): Promise<{
  fileCount: number;
  totalBytes: number;
  lastWrittenAt?: string;
}> {
  const directory = path.resolve(getGatewayIoLogDirectory(root));
  // Await this process's already-enqueued mutations, but never acquire or steal a writer lock.
  await operations.get(directory)?.catch(() => undefined);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { fileCount: 0, totalBytes: 0 };
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Gateway archive directory is not an owned directory.");
  }
  let fileCount = 0;
  let totalBytes = 0;
  let lastWrittenMs = 0;
  try {
    await visitGatewayIoFiles(directory, async (_file, fileStat) => {
      fileCount += 1;
      totalBytes += fileStat.size;
      lastWrittenMs = Math.max(lastWrittenMs, fileStat.mtimeMs);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    fileCount,
    totalBytes,
    ...(lastWrittenMs > 0 ? { lastWrittenAt: new Date(lastWrittenMs).toISOString() } : {}),
  };
}
