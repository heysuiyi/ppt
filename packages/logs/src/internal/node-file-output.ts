import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { LogFileStatus, LogRecord } from "../log-contract.js";

const dayMilliseconds = 86_400_000;
const dailyName = /^diagnostic-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function existing(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

function managedDay(name: string): string | undefined {
  const match = dailyName.exec(name);
  if (!match) return undefined;
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) {
    return undefined;
  }
  return match[1];
}

interface ManagedFile {
  readonly path: string;
  readonly day: string;
  readonly size: number;
}

/** 根目录由宿主信任；实例目录及托管文件每次使用前拒绝链接，不递归删除。 */
export class NodeFileOutput {
  private directory = "";
  private ownsDirectory = false;
  private readonly createdFiles = new Map<string, { readonly dev: number; readonly ino: number }>();
  private retentionDays = 7;
  private retainedDay: string | undefined;
  private failureCount = 0;
  private lastWrittenAt: string | undefined;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  bind(instanceId: string): void {
    this.directory = join(this.root, instanceId);
  }

  private checked<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      this.failureCount++;
      throw error;
    }
  }

  private requireDirectory(allowMissing: boolean): boolean {
    const stat = existing(this.directory);
    if (!stat && allowMissing) return false;
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("The managed logging directory is not a regular directory");
    }
    return true;
  }

  private files(): ManagedFile[] {
    if (!this.requireDirectory(true)) return [];
    const files: ManagedFile[] = [];
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      const day = managedDay(entry.name);
      if (!day || !entry.isFile() || entry.isSymbolicLink()) continue;
      const path = join(this.directory, entry.name);
      const stat = existing(path);
      if (stat?.isFile() && !stat.isSymbolicLink()) {
        files.push({ path, day, size: stat.size });
      }
    }
    return files;
  }

  private remove(files: readonly ManagedFile[]): number {
    let count = 0;
    for (const file of files) {
      this.requireDirectory(false);
      const stat = existing(file.path);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      unlinkSync(file.path);
      this.createdFiles.delete(file.path);
      count++;
    }
    return count;
  }

  private retain(day: string, retentionDays: number): void {
    const cutoff = new Date(
      new Date(`${day}T00:00:00.000Z`).getTime() - (retentionDays - 1) * dayMilliseconds,
    )
      .toISOString()
      .slice(0, 10);
    this.remove(this.files().filter((file) => file.day < day && file.day < cutoff));
  }

  private append(day: string, content?: string): void {
    this.requireDirectory(false);
    const path = join(this.directory, `diagnostic-${day}.jsonl`);
    const stat = existing(path);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      throw new Error("The managed logging file is not a regular file");
    }
    const flags =
      constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      (constants.O_NOFOLLOW ?? 0) |
      (stat ? 0 : constants.O_EXCL);
    const descriptor = openSync(path, flags, 0o600);
    try {
      if (!stat) {
        const identity = fstatSync(descriptor);
        this.createdFiles.set(path, { dev: identity.dev, ino: identity.ino });
      }
      if (content !== undefined) {
        const bytes = Buffer.from(content, "utf8");
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
          if (written === 0) throw new Error("The logging file write made no progress");
          offset += written;
        }
      }
    } finally {
      closeSync(descriptor);
    }
  }

  prepare(retentionDays: number): void {
    this.checked(() => {
      if (!this.ownsDirectory) {
        mkdirSync(this.root, { recursive: true });
        // 首次创建必须独占实例目录，不能接管预先存在的数据。
        mkdirSync(this.directory, { mode: 0o700 });
        this.ownsDirectory = true;
      }
      this.requireDirectory(false);
      const day = new Date().toISOString().slice(0, 10);
      this.append(day);
      this.retain(day, retentionDays);
    });
  }

  configure(retentionDays: number): void {
    this.retentionDays = retentionDays;
    this.retainedDay = undefined;
  }

  export(record: LogRecord): void {
    this.checked(() => {
      const day = record.timestamp.slice(0, 10);
      if (day !== this.retainedDay) {
        this.retain(day, this.retentionDays);
        this.retainedDay = day;
      }
      this.append(day, `${JSON.stringify(record)}\n`);
      this.lastWrittenAt = record.timestamp;
    });
  }

  async close(): Promise<void> {}

  status(enabled: boolean): LogFileStatus {
    return this.checked(() => {
      const files = this.files();
      return Object.freeze({
        directory: this.directory,
        enabled,
        fileCount: files.length,
        totalBytes: files.reduce((total, file) => total + file.size, 0),
        ...(this.lastWrittenAt === undefined ? {} : { lastWrittenAt: this.lastWrittenAt }),
        failureCount: this.failureCount,
      });
    });
  }

  clear(): number {
    return this.checked(() => {
      const day = new Date().toISOString().slice(0, 10);
      return this.remove(this.files().filter((file) => file.day < day));
    });
  }

  reset(): number {
    return this.checked(() => {
      if (!this.ownsDirectory) return 0;
      const removed = this.remove(this.files());
      this.retainedDay = undefined;
      this.lastWrittenAt = undefined;
      return removed;
    });
  }

  rollback(): void {
    if (!this.ownsDirectory) return;
    this.requireDirectory(false);
    for (const [path, identity] of this.createdFiles) {
      const stat = existing(path);
      if (
        stat?.isFile() &&
        !stat.isSymbolicLink() &&
        stat.dev === identity.dev &&
        stat.ino === identity.ino
      )
        unlinkSync(path);
    }
    // 非空目录（包括后来出现的未知数据）不能递归移除。
    try {
      rmdirSync(this.directory);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOTEMPTY" &&
        (error as NodeJS.ErrnoException).code !== "EEXIST"
      )
        throw error;
    }
  }
}
