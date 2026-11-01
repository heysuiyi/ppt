import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { sanitizeLogData } from "@agent-harness/logs/logs";
import type { LogRecord } from "@agent-harness/logs/node-logs";
import type { AppLogEntry } from "@shared/logging";
import { isLogLevel } from "./log-settings";

type Release = () => Promise<void>;
const lockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lock(
    filename: string,
    options: {
      realpath: boolean;
      stale: number;
      update: number;
      retries: number;
      onCompromised?: (error: Error) => void;
    },
  ): Promise<Release>;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const desktopName = "desktop";
const ownerName = "owner.json";
// Never steal an ownership lock based on elapsed wall time. Abruptly abandoned locks
// are deliberately skipped: a heartbeat timestamp cannot prove an owner is dead.
const lockOptions = { realpath: false, stale: Number.MAX_SAFE_INTEGER, update: 1000, retries: 0 };

export interface DesktopOwner {
  directory: string;
  ownerId: string;
  release: Release;
  markerIdentity?: { dev: number; ino: number };
}
export interface HistoryFile {
  filename: string;
  day?: string;
  legacy: boolean;
  instanceId?: string;
  owner?: string;
  size: number;
  modified: number;
}
export interface HistoricalOwner {
  directory: string;
  instanceId: string;
  files: HistoryFile[];
}
export interface HistoryInventory {
  files: HistoryFile[];
  owners: HistoricalOwner[];
  skipped: string[];
}

export async function regularDirectory(directory: string): Promise<boolean> {
  try {
    const stat = await lstat(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function entries(directory: string) {
  return await readdir(directory, { withFileTypes: true });
}

export function managedDate(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
}

export function retentionCutoffs(
  days: number,
  now = new Date(),
): { utc: string; local: string; localMs: number } {
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  local.setDate(local.getDate() - days + 1);
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() - days + 1);
  return {
    utc: utc.toISOString().slice(0, 10),
    local: localDateKey(local),
    localMs: local.getTime(),
  };
}

export async function createDesktopOwner(
  root: string,
  onCompromised: (error: Error) => void,
): Promise<DesktopOwner> {
  const desktop = join(root, desktopName);
  await mkdir(desktop, { recursive: true });
  if (!(await regularDirectory(desktop)))
    throw new Error("Desktop logs root is not a regular directory");
  const ownerId = randomUUID();
  const directory = join(desktop, ownerId);
  await mkdir(directory, { mode: 0o700 });
  try {
    const release = await lockfile.lock(directory, { ...lockOptions, onCompromised });
    return { directory, ownerId, release };
  } catch (error) {
    await rmdir(directory).catch(() => undefined);
    throw error;
  }
}

export async function identifyDesktopOwner(owner: DesktopOwner, instanceId: string): Promise<void> {
  if (!uuid.test(instanceId)) throw new Error("Invalid desktop logs instance identity");
  const handle = await open(join(owner.directory, ownerName), "wx", 0o600);
  try {
    const stat = await handle.stat();
    owner.markerIdentity = { dev: stat.dev, ino: stat.ino };
    await handle.writeFile(
      `${JSON.stringify({ schemaVersion: 1, kind: "desktop-diagnostic-owner", ownerId: owner.ownerId, instanceId })}\n`,
      "utf8",
    );
  } finally {
    await handle.close();
  }
}

export async function removeDesktopOwnerMarker(owner: DesktopOwner): Promise<void> {
  if (!owner.markerIdentity || !(await regularDirectory(owner.directory))) return;
  const filename = join(owner.directory, ownerName);
  try {
    const stat = await lstat(filename);
    if (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.dev === owner.markerIdentity.dev &&
      stat.ino === owner.markerIdentity.ino
    )
      await unlink(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function acquireHistoricalOwner(owner: HistoricalOwner): Promise<Release> {
  if (!(await regularDirectory(owner.directory)))
    throw new Error("Historical logs owner is not a regular directory");
  return lockfile.lock(owner.directory, lockOptions);
}

async function boundedText(filename: string, maximumBytes: number): Promise<string> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes)
    throw new Error("Invalid ownership marker");
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > maximumBytes)
      throw new Error("Ownership marker changed");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function inspectFile(
  filename: string,
  fields: Omit<HistoryFile, "filename" | "size" | "modified">,
): Promise<HistoryFile | undefined> {
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return { filename, size: stat.size, modified: stat.mtimeMs, ...fields };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function inventoryHistory(root: string): Promise<HistoryInventory> {
  const result: HistoryInventory = { files: [], owners: [], skipped: [] };
  if (!(await regularDirectory(root))) throw new Error("Log root is not a regular directory");
  for (const entry of await entries(root)) {
    const filename = join(root, entry.name);
    if (
      entry.name === "settings.json" ||
      entry.name === "settings.json.bak" ||
      entry.name === "settings.json.lock" ||
      entry.name === "gateway" ||
      entry.name === "gateway.lock" ||
      entry.name === desktopName
    )
      continue;
    const match = /^agent-(\d{4}-\d{2}-\d{2})\.log$/.exec(entry.name);
    const day = match && managedDate(match[1]);
    if (
      (!day && entry.name !== "agent.log" && entry.name !== "agent.log.txt") ||
      !entry.isFile() ||
      entry.isSymbolicLink()
    ) {
      result.skipped.push(`${filename}: unowned artifact`);
      continue;
    }
    const file = await inspectFile(filename, { legacy: true, ...(day ? { day } : {}) });
    if (file) result.files.push(file);
  }
  const desktop = join(root, desktopName);
  if (!(await regularDirectory(desktop))) {
    result.skipped.push(`${desktop}: missing or unsafe ownership root`);
    return result;
  }
  for (const entry of await entries(desktop)) {
    if (/^[0-9a-f-]{36}\.lock$/i.test(entry.name)) continue;
    const directory = join(desktop, entry.name);
    if (
      !uuid.test(entry.name) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !(await regularDirectory(directory))
    ) {
      result.skipped.push(`${directory}: unowned artifact`);
      continue;
    }
    let instanceId: string;
    try {
      const marker = JSON.parse(await boundedText(join(directory, ownerName), 4096)) as Record<
        string,
        unknown
      >;
      if (
        marker.schemaVersion !== 1 ||
        marker.kind !== "desktop-diagnostic-owner" ||
        marker.ownerId !== entry.name ||
        typeof marker.instanceId !== "string" ||
        !uuid.test(marker.instanceId)
      )
        throw new Error("Unproven identity");
      instanceId = marker.instanceId;
    } catch {
      result.skipped.push(`${directory}: ownership cannot be verified`);
      continue;
    }
    const owner: HistoricalOwner = { directory, instanceId, files: [] };
    result.owners.push(owner);
    for (const child of await entries(directory)) {
      if (child.name === ownerName) continue;
      const target = join(directory, child.name);
      if (
        child.name !== instanceId ||
        !child.isDirectory() ||
        child.isSymbolicLink() ||
        !(await regularDirectory(target))
      ) {
        result.skipped.push(`${target}: unowned artifact`);
        continue;
      }
      for (const artifact of await entries(target)) {
        const filename = join(target, artifact.name);
        const match = /^diagnostic-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(artifact.name);
        const day = match && managedDate(match[1]);
        if (!day || !artifact.isFile() || artifact.isSymbolicLink()) {
          result.skipped.push(`${filename}: unmanaged diagnostic artifact`);
          continue;
        }
        const file = await inspectFile(filename, {
          legacy: false,
          day,
          instanceId,
          owner: directory,
        });
        if (file) {
          owner.files.push(file);
          result.files.push(file);
        }
      }
    }
  }
  return result;
}

/** Re-check every owned parent and the file itself immediately before unlinking. */
export async function removeHistoryFile(file: HistoryFile, root: string): Promise<boolean> {
  if (!(await regularDirectory(root))) return false;
  if (
    file.owner &&
    (!(await regularDirectory(join(root, desktopName))) ||
      !(await regularDirectory(file.owner)) ||
      !(await regularDirectory(join(file.owner, file.instanceId!))))
  )
    return false;
  const stat = await lstat(file.filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat?.isFile() || stat.isSymbolicLink()) return false;
  await unlink(file.filename);
  return true;
}

interface Candidate {
  identity: string;
  entry: AppLogEntry;
}

export function projectRecord(record: LogRecord): AppLogEntry {
  const data = sanitizeLogData(record.data ?? {});
  const context = sanitizeLogData({ ...record.context });
  const envelope = sanitizeLogData({ module: record.name, event: record.event });
  return {
    ...data,
    ...context,
    id: `${record.instanceId}:${record.sequence}`,
    timestamp: record.timestamp,
    level: record.level,
    event: typeof envelope.event === "string" ? envelope.event : "diagnostic",
    scope: "agent",
    module: typeof envelope.module === "string" ? envelope.module : "diagnostic",
  };
}

function parseLine(line: string, file: HistoryFile, offset: number): Candidate | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.timestamp !== "string" ||
      !Number.isFinite(Date.parse(value.timestamp)) ||
      !isLogLevel(value.level) ||
      typeof value.event !== "string"
    )
      return undefined;
    if (!file.legacy) {
      if (
        value.schemaVersion !== 1 ||
        value.instanceId !== file.instanceId ||
        !Number.isSafeInteger(value.sequence) ||
        (value.sequence as number) < 1 ||
        typeof value.name !== "string" ||
        !value.context ||
        typeof value.context !== "object" ||
        Array.isArray(value.context)
      )
        return undefined;
      return {
        identity: `${value.instanceId}:${value.sequence}`,
        entry: projectRecord(value as unknown as LogRecord),
      };
    }
    const safe = sanitizeLogData(value);
    const envelope = sanitizeLogData({ event: value.event });
    const identity = `${file.filename}:${offset}`;
    return {
      identity,
      entry: {
        ...safe,
        id: identity,
        timestamp: value.timestamp,
        level: value.level,
        event: typeof envelope.event === "string" ? envelope.event : "diagnostic",
        scope: "agent",
      },
    };
  } catch {
    return undefined;
  }
}

/** Read at most 300 safe-record budgets, in fixed chunks; malformed long lines cannot grow memory. */
async function readTail(file: HistoryFile): Promise<Candidate[]> {
  const result: Candidate[] = [];
  if (
    file.owner &&
    (!(await regularDirectory(file.owner)) ||
      !(await regularDirectory(join(file.owner, file.instanceId!))))
  )
    return result;
  const stat = await lstat(file.filename);
  if (!stat.isFile() || stat.isSymbolicLink()) return result;
  const handle = await open(file.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) return result;
    let position = opened.size;
    let remaining = 301 * 65_537;
    let suffix = Buffer.alloc(0);
    let droppingLongLine = false;
    while (position > 0 && remaining > 0 && result.length < 300) {
      const length = Math.min(position, remaining, 64 * 1024);
      position -= length;
      remaining -= length;
      const bytes = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(bytes, 0, length, position);
      const content = Buffer.concat([bytes.subarray(0, bytesRead), suffix]);
      let lineEnd = content.length;
      for (let index = content.length - 1; index >= 0 && result.length < 300; index--) {
        if (content[index] !== 0x0a) continue;
        if (!droppingLongLine && lineEnd - index - 1 <= 65_536) {
          const candidate = parseLine(
            content.subarray(index + 1, lineEnd).toString("utf8"),
            file,
            position + index + 1,
          );
          if (candidate) result.push(candidate);
        }
        droppingLongLine = false;
        lineEnd = index;
      }
      if (lineEnd > 65_536) {
        suffix = Buffer.alloc(0);
        droppingLongLine = true;
      } else {
        suffix = Buffer.from(content.subarray(0, lineEnd));
      }
    }
    if (position === 0 && !droppingLongLine && result.length < 300) {
      const candidate = parseLine(suffix.toString("utf8"), file, 0);
      if (candidate) result.push(candidate);
    }
    return result.reverse();
  } finally {
    await handle.close();
  }
}

function chronological(left: AppLogEntry, right: AppLogEntry): number {
  const time = Date.parse(left.timestamp) - Date.parse(right.timestamp);
  if (time || !left.id || !right.id) return time;
  const leftSeparator = left.id.lastIndexOf(":");
  const rightSeparator = right.id.lastIndexOf(":");
  if (left.id.slice(0, leftSeparator) !== right.id.slice(0, rightSeparator)) return 0;
  return Number(left.id.slice(leftSeparator + 1)) - Number(right.id.slice(rightSeparator + 1));
}

export async function recentHistory(
  files: HistoryFile[],
  recent: readonly LogRecord[],
): Promise<AppLogEntry[]> {
  const candidates = new Map<string, AppLogEntry>();
  const newestFiles = [...files].sort(
    (a, b) => b.modified - a.modified || basename(b.filename).localeCompare(basename(a.filename)),
  );
  for (const file of newestFiles) {
    try {
      for (const candidate of await readTail(file))
        candidates.set(candidate.identity, candidate.entry);
      if (candidates.size > 300) {
        const retained = [...candidates.entries()]
          .sort((left, right) => chronological(left[1], right[1]))
          .slice(-300);
        candidates.clear();
        for (const [identity, entry] of retained) candidates.set(identity, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const record of recent)
    candidates.set(`${record.instanceId}:${record.sequence}`, projectRecord(record));
  return [...candidates.values()].sort(chronological).slice(-300);
}
