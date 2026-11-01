import fs from "node:fs";
import path from "node:path";
import { getLogContext, getLogDirectory } from "../logger";
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

export function getGatewayIoLogDirectory(): string {
  return path.join(getLogDirectory(), GATEWAY_IO_LOG_DIRECTORY_NAME);
}

function localDateKey(date: Date): string {
  return [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-");
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

export async function writeGatewayIoLog(entry: GatewayIoLogEntry): Promise<string | undefined> {
  if (!isGatewayIoLogEnabled()) return undefined;
  const relative = gatewayIoLogRelativePath(entry);
  const absolute = path.join(getLogDirectory(), relative);
  try {
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
    await fs.promises.writeFile(absolute, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    return absolute;
  } catch (error) {
    try {
      console.error("[gateway] Failed to write gateway I/O log:", error);
    } catch {
      // Observational path; never throw.
    }
    return undefined;
  }
}

export async function clearGatewayIoLogFiles(): Promise<number> {
  const directory = getGatewayIoLogDirectory();
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await fs.promises.readdir(target, { withFileTypes: true }).catch(() => []);
      for (const file of nested) {
        if (!file.isFile()) continue;
        await fs.promises.unlink(path.join(target, file.name)).catch(() => undefined);
        removed += 1;
      }
      await fs.promises.rmdir(target).catch(() => undefined);
      continue;
    }
    if (!entry.isFile()) continue;
    await fs.promises.unlink(target).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

export async function pruneGatewayIoLogFiles(
  retentionDays: number,
  now = new Date(),
): Promise<number> {
  const directory = getGatewayIoLogDirectory();
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  cutoff.setDate(cutoff.getDate() - Math.max(1, Math.trunc(retentionDays)) + 1);
  const cutoffKey = localDateKey(cutoff);
  const days = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const dayEntry of days) {
    if (!dayEntry.isDirectory()) continue;
    if (dayEntry.name >= cutoffKey) continue;
    const dayDirectory = path.join(directory, dayEntry.name);
    const files = await fs.promises.readdir(dayDirectory, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile()) continue;
      await fs.promises.unlink(path.join(dayDirectory, file.name)).catch(() => undefined);
      removed += 1;
    }
    await fs.promises.rmdir(dayDirectory).catch(() => undefined);
  }
  return removed;
}

export async function measureGatewayIoLogUsage(): Promise<{
  fileCount: number;
  totalBytes: number;
  lastWrittenAt?: string;
}> {
  const directory = getGatewayIoLogDirectory();
  const days = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  let fileCount = 0;
  let totalBytes = 0;
  let lastWrittenMs = 0;
  for (const dayEntry of days) {
    if (!dayEntry.isDirectory()) continue;
    const dayDirectory = path.join(directory, dayEntry.name);
    const files = await fs.promises.readdir(dayDirectory, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile()) continue;
      const stat = await fs.promises
        .stat(path.join(dayDirectory, file.name))
        .catch(() => undefined);
      if (!stat) continue;
      fileCount += 1;
      totalBytes += stat.size;
      lastWrittenMs = Math.max(lastWrittenMs, stat.mtimeMs);
    }
  }
  return {
    fileCount,
    totalBytes,
    ...(lastWrittenMs > 0 ? { lastWrittenAt: new Date(lastWrittenMs).toISOString() } : {}),
  };
}
