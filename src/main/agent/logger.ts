import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type {
  AppLogEntry,
  AppLogLevel,
  LogManagerSettings,
  LogManagerStatus,
} from "@shared/logging";
import { getApplicationDataRoot } from "../application-data";

type LogDetail = "minimal" | "full";

type AgentLogData = Record<string, unknown>;

export interface LogContext {
  operation?: string;
  sessionId?: string;
  runId?: string;
  threadId?: string;
  queryId?: string;
}

export interface DiagnosticValuePreview {
  valueType: string;
  serializedLength: number;
  preview: string;
  truncated: boolean;
  keys?: string[];
}

const logContextStorage = new AsyncLocalStorage<LogContext>();
const MAX_DIAGNOSTIC_DEPTH = 6;
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 50;
const MAX_DIAGNOSTIC_OBJECT_KEYS = 50;
const MAX_DIAGNOSTIC_STRING_LENGTH = 16_384;
const BINARY_FIELD_PATTERN = /(?:base64|binary|blob|image_?data|png_?data|jpe?g_?data|bytes)$/i;

interface DailyLogFileState {
  dateKey: string;
}

// Tracks the active local day so retention pruning runs once per day switch.
let logFileState: DailyLogFileState | null | undefined;
let runtimeSettings: Partial<LogManagerSettings> = {};
const recentEntries: AppLogEntry[] = [];
const MAX_RECENT_ENTRIES = 300;
export const DEFAULT_LOG_RETENTION_DAYS = 7;
const MIN_LOG_RETENTION_DAYS = 1;
const MAX_LOG_RETENTION_DAYS = 90;
const SETTINGS_FILE_NAME = "settings.json";
const DAILY_LOG_FILE_PATTERN = /^agent-(\d{4})-(\d{2})-(\d{2})\.log$/;
const LEGACY_HISTORY_FILE_PATTERN = /^agent\.log\.txt$/;

function clampRetentionDays(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_LOG_RETENTION_DAYS, Math.max(MIN_LOG_RETENTION_DAYS, Math.trunc(value)));
}

export function getLogDirectory(): string {
  const override = process.env.AGENT_LOG_DIR?.trim();
  return override ? path.resolve(override) : path.join(getApplicationDataRoot(), "logs");
}

/**
 * Append one JSON line to the local-day log file.
 * Uses appendFileSync so a midnight rotation cannot lose a buffered WriteStream
 * write (Vitest fake timers / Windows CI previously left the prior-day file empty).
 */
function appendDailyLogLine(line: string, now = new Date()): boolean {
  const shouldWriteToFile = runtimeSettings.fileEnabled ?? process.env.AGENT_LOG_FILE !== "false";
  if (!shouldWriteToFile) {
    logFileState = null;
    return false;
  }

  const dateKey = localDateKey(now);
  const logDir = getLogDirectory();
  const logPath = path.join(logDir, `agent-${dateKey}.log`);

  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
    if (logFileState?.dateKey !== dateKey) {
      logFileState = { dateKey };
      void pruneExpiredLogFiles(now).catch((error) => {
        console.error("[agent] Failed to prune expired log files:", error);
      });
    }
    return true;
  } catch (error) {
    console.error("[agent] Failed to append to log file:", error);
    logFileState = null;
    return false;
  }
}

const levelPriority: Record<AppLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): AppLogLevel {
  if (runtimeSettings.level) return runtimeSettings.level;
  const value = process.env.AGENT_LOG_LEVEL?.trim().toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test" ? "error" : "info";
}

function configuredRetentionDays(): number {
  return runtimeSettings.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
}

function configuredDetail(): LogDetail {
  const value = process.env.AGENT_LOG_DETAIL?.trim().toLowerCase();
  return value === "full" ? "full" : "minimal";
}

function redactSensitiveValue(key: string, value: unknown): unknown {
  const sensitiveKeys = [
    "apiKey",
    "api_key",
    "apikey",
    "authorization",
    "password",
    "secret",
    "token",
    "bearer",
  ];

  if (typeof value === "string" && sensitiveKeys.some((k) => key.toLowerCase().includes(k))) {
    return value.length > 8 ? `${value.slice(0, 4)}...${value.slice(-4)}` : "***";
  }

  if (typeof value === "string") {
    return value
      .replace(/(bearer\s+)[a-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
      .replace(/\b(?:sk|tvly)-[a-z0-9_-]{12,}\b/gi, "[REDACTED]");
  }

  return value;
}

export function withLogContext<T>(context: LogContext, task: () => T): T {
  const current = logContextStorage.getStore();
  return logContextStorage.run({ ...current, ...context }, task);
}

export function getLogContext(): LogContext {
  return { ...logContextStorage.getStore() };
}

export function diagnosticValuePreview(
  value: unknown,
  maxCharacters: number,
): DiagnosticValuePreview {
  const safeLimit = Math.max(1, Math.trunc(maxCharacters));
  const normalized = normalizeDiagnosticValue(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(normalized);
  } catch (error) {
    serialized = JSON.stringify({
      logSerializationError: error instanceof Error ? error.message : String(error),
    });
  }
  const truncated = serialized.length > safeLimit;
  return {
    valueType: diagnosticValueType(value),
    serializedLength: serialized.length,
    preview: truncated ? `${serialized.slice(0, Math.max(0, safeLimit - 3))}...` : serialized,
    truncated,
    ...(isPlainRecord(value)
      ? { keys: Object.keys(value).slice(0, MAX_DIAGNOSTIC_OBJECT_KEYS) }
      : {}),
  };
}

function normalizeDiagnosticValue(
  value: unknown,
  parentKey = "",
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value instanceof Error) return serializeValue(value);
  if (typeof value === "string") {
    const redacted = redactSensitiveValue(parentKey, value) as string;
    if (
      (BINARY_FIELD_PATTERN.test(parentKey) && redacted.length > 128) ||
      /^data:[^;,]+;base64,/i.test(redacted) ||
      (parentKey.toLowerCase() === "data" &&
        redacted.length > 512 &&
        /^[a-z0-9+/=_-]+$/i.test(redacted))
    ) {
      return `[Binary data omitted: ${redacted.length} characters]`;
    }
    return redacted.length > MAX_DIAGNOSTIC_STRING_LENGTH
      ? `${redacted.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)}...[${redacted.length} characters]`
      : redacted;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (!value || typeof value !== "object") return redactSensitiveValue(parentKey, value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DIAGNOSTIC_DEPTH) return "[Depth limit reached]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS)
      .map((item) => normalizeDiagnosticValue(item, parentKey, depth + 1, seen));
    if (value.length > MAX_DIAGNOSTIC_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_DIAGNOSTIC_ARRAY_ITEMS} more items]`);
    }
    return items;
  }
  const entries = Object.entries(value).slice(0, MAX_DIAGNOSTIC_OBJECT_KEYS);
  const normalized = Object.fromEntries(
    entries.map(([key, entry]) => [key, normalizeDiagnosticValue(entry, key, depth + 1, seen)]),
  );
  if (Object.keys(value).length > MAX_DIAGNOSTIC_OBJECT_KEYS) {
    normalized.__truncatedKeys = Object.keys(value).length - MAX_DIAGNOSTIC_OBJECT_KEYS;
  }
  return normalized;
}

function diagnosticValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Error) return "error";
  return typeof value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Error)
  );
}

function localIsoTimestamp(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteOffset / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absoluteOffset % 60).toString().padStart(2, "0");
  const localTime = new Date(date.getTime() + offsetMinutes * 60_000).toISOString().slice(0, -1);
  return `${localTime}${sign}${hours}:${minutes}`;
}

function localDateKey(date = new Date()): string {
  return [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-");
}

function serializeValue(value: unknown, parentKey = "", seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    const details = value as Error & { code?: unknown; provider?: unknown };
    return {
      name: value.name,
      message: redactSensitiveValue("message", value.message),
      stack: redactSensitiveValue("stack", value.stack),
      code: serializeValue(details.code, "code", seen),
      provider: serializeValue(details.provider, "provider", seen),
    };
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((item) => serializeValue(item, parentKey, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, redactSensitiveValue(key, serializeValue(entry, key, seen))]),
    );
  }
  return redactSensitiveValue(parentKey, value);
}

function write(level: AppLogLevel, event: string, data: AgentLogData = {}): void {
  if (levelPriority[level] < levelPriority[configuredLevel()]) return;

  let serializedData: AgentLogData;
  let serializedContext: AgentLogData;
  try {
    serializedData = serializeValue(data) as AgentLogData;
    serializedContext = serializeValue(logContextStorage.getStore() ?? {}) as AgentLogData;
  } catch (error) {
    serializedData = {
      logSerializationError: error instanceof Error ? error.message : String(error),
    };
    serializedContext = {};
  }
  const entry = {
    ...serializedData,
    ...serializedContext,
    timestamp: localIsoTimestamp(),
    level,
    scope: "agent",
    event: redactSensitiveValue("event", event) as string,
  };
  recentEntries.push(entry);
  if (recentEntries.length > MAX_RECENT_ENTRIES) recentEntries.shift();
  const json = JSON.stringify(entry);
  const line = `[agent] ${json}`;

  // The development launcher configures Windows consoles for UTF-8.
  try {
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else if (level === "debug") {
      console.debug(line);
    } else {
      console.info(line);
    }
  } catch {
    // Logging is observational and must never replace application control flow.
  }

  // File output (with original Unicode, no escaping needed)
  try {
    appendDailyLogLine(json);
  } catch (error) {
    try {
      console.error("[agent] Failed to append log entry:", error);
    } catch {
      // There is no safe fallback if both sinks fail.
    }
  }
}

async function closeLogFileStream(): Promise<void> {
  logFileState = undefined;
}

function isLogFile(name: string): boolean {
  return (
    DAILY_LOG_FILE_PATTERN.test(name) ||
    name === "agent.log" ||
    name.endsWith(".log") ||
    name.endsWith(".log.gz")
  );
}

function isManagedLogArtifact(name: string): boolean {
  return isLogFile(name) || LEGACY_HISTORY_FILE_PATTERN.test(name);
}

const GATEWAY_IO_DIRECTORY_NAME = "gateway";

async function removeDirectoryTree(directory: string): Promise<number> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removed += await removeDirectoryTree(target);
      await fs.promises.rmdir(target).catch(() => undefined);
      continue;
    }
    if (!entry.isFile()) continue;
    await fs.promises.unlink(target).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

async function measureDirectoryTree(directory: string): Promise<{
  fileCount: number;
  totalBytes: number;
  lastWrittenMs: number;
}> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  let fileCount = 0;
  let totalBytes = 0;
  let lastWrittenMs = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await measureDirectoryTree(target);
      fileCount += nested.fileCount;
      totalBytes += nested.totalBytes;
      lastWrittenMs = Math.max(lastWrittenMs, nested.lastWrittenMs);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.promises.stat(target).catch(() => undefined);
    if (!stat) continue;
    fileCount += 1;
    totalBytes += stat.size;
    lastWrittenMs = Math.max(lastWrittenMs, stat.mtimeMs);
  }
  return { fileCount, totalBytes, lastWrittenMs };
}

function dateKeyFromDailyLogFile(name: string): string | undefined {
  const match = DAILY_LOG_FILE_PATTERN.exec(name);
  if (!match) return undefined;
  const [, year, month, day] = match;
  const parsed = new Date(Number(year), Number(month) - 1, Number(day));
  return localDateKey(parsed) === `${year}-${month}-${day}` ? `${year}-${month}-${day}` : undefined;
}

function retentionCutoff(now = new Date()): Date {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  cutoff.setDate(cutoff.getDate() - configuredRetentionDays() + 1);
  return cutoff;
}

async function pruneExpiredLogFiles(now = new Date()): Promise<void> {
  const directory = getLogDirectory();
  const files = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  const cutoff = retentionCutoff(now);
  const cutoffKey = localDateKey(cutoff);
  await Promise.all(
    files
      .filter((entry) => entry.isFile() && isLogFile(entry.name))
      .map(async (entry) => {
        const dateKey = dateKeyFromDailyLogFile(entry.name);
        if (dateKey) {
          if (dateKey < cutoffKey) await fs.promises.unlink(path.join(directory, entry.name));
          return;
        }
        const filename = path.join(directory, entry.name);
        const stat = await fs.promises.stat(filename);
        if (stat.mtimeMs < cutoff.getTime()) await fs.promises.unlink(filename);
      }),
  );

  const gatewayDirectory = path.join(directory, GATEWAY_IO_DIRECTORY_NAME);
  const gatewayDays = await fs.promises
    .readdir(gatewayDirectory, { withFileTypes: true })
    .catch(() => []);
  for (const dayEntry of gatewayDays) {
    if (!dayEntry.isDirectory() || dayEntry.name >= cutoffKey) continue;
    const dayDirectory = path.join(gatewayDirectory, dayEntry.name);
    await removeDirectoryTree(dayDirectory);
    await fs.promises.rmdir(dayDirectory).catch(() => undefined);
  }
}

function parseLogLine(line: string): AppLogEntry | undefined {
  if (!line.trim()) return undefined;
  try {
    const entry = JSON.parse(line) as AppLogEntry;
    if (
      entry &&
      typeof entry.timestamp === "string" &&
      typeof entry.event === "string" &&
      entry.level in levelPriority
    ) {
      return entry;
    }
  } catch {
    // A partially written final line should not make diagnostics unavailable.
  }
  return undefined;
}

async function readNewestLogEntries(filename: string, limit: number): Promise<AppLogEntry[]> {
  const handle = await fs.promises.open(filename, "r");
  try {
    const { size } = await handle.stat();
    const entries: AppLogEntry[] = [];
    let position = size;
    let suffix = Buffer.alloc(0);
    const chunkSize = 64 * 1024;

    while (position > 0 && entries.length < limit) {
      const bytesToRead = Math.min(chunkSize, position);
      position -= bytesToRead;
      const chunk = Buffer.allocUnsafe(bytesToRead);
      await handle.read(chunk, 0, bytesToRead, position);
      const content = Buffer.concat([chunk, suffix]);
      let lineEnd = content.length;
      for (let index = content.length - 1; index >= 0 && entries.length < limit; index -= 1) {
        if (content[index] !== 0x0a) continue;
        const entry = parseLogLine(content.subarray(index + 1, lineEnd).toString("utf8"));
        if (entry) entries.push(entry);
        lineEnd = index;
      }
      suffix = Buffer.from(content.subarray(0, lineEnd));
    }

    if (position === 0 && entries.length < limit) {
      const entry = parseLogLine(suffix.toString("utf8"));
      if (entry) entries.push(entry);
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function loadRecentLogEntries(): Promise<void> {
  recentEntries.length = 0;
  const directory = getLogDirectory();
  const files = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  const dailyFiles = files
    .filter((entry) => entry.isFile() && dateKeyFromDailyLogFile(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  const sourceFiles =
    dailyFiles.length > 0
      ? dailyFiles
      : files.some((entry) => entry.isFile() && entry.name === "agent.log")
        ? ["agent.log"]
        : [];
  const newestFirst: AppLogEntry[] = [];
  for (const name of sourceFiles) {
    const entries = await readNewestLogEntries(
      path.join(directory, name),
      MAX_RECENT_ENTRIES - newestFirst.length,
    );
    newestFirst.push(...entries);
    if (newestFirst.length >= MAX_RECENT_ENTRIES) break;
  }
  recentEntries.push(...newestFirst.reverse());
}

export function getLogManagerSettings(): LogManagerSettings {
  return {
    level: configuredLevel(),
    fileEnabled: runtimeSettings.fileEnabled ?? process.env.AGENT_LOG_FILE !== "false",
    retentionDays: configuredRetentionDays(),
  };
}

export async function initializeLogManager(): Promise<LogManagerSettings> {
  await closeLogFileStream();
  const settingsPath = path.join(getLogDirectory(), SETTINGS_FILE_NAME);
  runtimeSettings = {};
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(settingsPath, "utf8"),
    ) as Partial<LogManagerSettings>;
    const retentionDays = clampRetentionDays(parsed.retentionDays);
    runtimeSettings = {
      ...(parsed.level && parsed.level in levelPriority ? { level: parsed.level } : {}),
      ...(typeof parsed.fileEnabled === "boolean" ? { fileEnabled: parsed.fileEnabled } : {}),
      ...(retentionDays !== undefined ? { retentionDays } : {}),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.error("[agent] Failed to load log settings:", error);
  }
  try {
    await pruneExpiredLogFiles();
    await loadRecentLogEntries();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.error("[agent] Failed to load recent logs:", error);
  }
  return getLogManagerSettings();
}

export async function updateLogManagerSettings(
  patch: Partial<LogManagerSettings>,
): Promise<LogManagerSettings> {
  const previous = getLogManagerSettings();
  if (patch.level && patch.level in levelPriority) runtimeSettings.level = patch.level;
  if (typeof patch.fileEnabled === "boolean") {
    runtimeSettings.fileEnabled = patch.fileEnabled;
  }
  const retentionDays = clampRetentionDays(patch.retentionDays);
  if (retentionDays !== undefined) runtimeSettings.retentionDays = retentionDays;

  const next = getLogManagerSettings();
  const streamConfigChanged = next.fileEnabled !== previous.fileEnabled;
  if (streamConfigChanged) await closeLogFileStream();
  if (next.retentionDays !== previous.retentionDays) await pruneExpiredLogFiles();

  const directory = getLogDirectory();
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(
    path.join(directory, SETTINGS_FILE_NAME),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
  return next;
}

export async function getLogManagerStatus(): Promise<LogManagerStatus> {
  const directory = getLogDirectory();
  const files = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  const stats = await Promise.all(
    files
      .filter((entry) => entry.isFile() && isManagedLogArtifact(entry.name))
      .map((entry) => fs.promises.stat(path.join(directory, entry.name))),
  );
  const gatewayUsage = await measureDirectoryTree(path.join(directory, GATEWAY_IO_DIRECTORY_NAME));
  const lastWrittenMs = stats.reduce(
    (latest, stat) => Math.max(latest, stat.mtimeMs),
    gatewayUsage.lastWrittenMs,
  );
  const settings = getLogManagerSettings();
  return {
    ...settings,
    directory,
    fileCount: stats.length + gatewayUsage.fileCount,
    totalBytes: stats.reduce((total, stat) => total + stat.size, gatewayUsage.totalBytes),
    ...(lastWrittenMs > 0 ? { lastWrittenAt: new Date(lastWrittenMs).toISOString() } : {}),
  };
}

export function getRecentLogEntries(
  limit = 100,
  minimumLevel: AppLogLevel = "debug",
): AppLogEntry[] {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 100, MAX_RECENT_ENTRIES));
  const safeMinimumLevel = minimumLevel in levelPriority ? minimumLevel : "debug";
  return recentEntries
    .filter((entry) => levelPriority[entry.level] >= levelPriority[safeMinimumLevel])
    .slice(-safeLimit)
    .reverse()
    .map((entry) => ({ ...entry }));
}

export async function clearLogFiles(): Promise<number> {
  const directory = getLogDirectory();
  await closeLogFileStream();
  const files = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  const targets = files.filter((entry) => entry.isFile() && isManagedLogArtifact(entry.name));
  await Promise.all(targets.map((entry) => fs.promises.unlink(path.join(directory, entry.name))));
  const gatewayRemoved = await removeDirectoryTree(path.join(directory, GATEWAY_IO_DIRECTORY_NAME));
  await fs.promises.rmdir(path.join(directory, GATEWAY_IO_DIRECTORY_NAME)).catch(() => undefined);
  recentEntries.length = 0;
  return targets.length + gatewayRemoved;
}

export const agentLogger = {
  debug: (event: string, data?: AgentLogData) => write("debug", event, data),
  info: (event: string, data?: AgentLogData) => write("info", event, data),
  warn: (event: string, data?: AgentLogData) => write("warn", event, data),
  error: (event: string, data?: AgentLogData) => write("error", event, data),
};

export function createModuleLogger(module: string) {
  return {
    debug: (event: string, data?: AgentLogData) => write("debug", event, { ...data, module }),
    info: (event: string, data?: AgentLogData) => write("info", event, { ...data, module }),
    warn: (event: string, data?: AgentLogData) => write("warn", event, { ...data, module }),
    error: (event: string, data?: AgentLogData) => write("error", event, { ...data, module }),
  };
}

export function requestSummary(
  request: string,
  forceDetail?: LogDetail,
): { requestLength: number; requestPreview: string; requestFull?: string } {
  const detail = forceDetail ?? configuredDetail();
  const normalized = request.replace(/\s+/g, " ").trim();
  const preview = normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;

  return {
    requestLength: request.length,
    requestPreview: preview,
    ...(detail === "full" && { requestFull: request }),
  };
}
