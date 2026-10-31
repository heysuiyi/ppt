import type {
  LogLevel,
  LogRecord,
  NodeLogsOptions,
  NodeLogsSettings,
  NodeLogsSettingsPatch,
  RecentLogQuery,
} from "../log-contract";
import { isLogLevel, levelPriority } from "./log-runtime";

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected a logging configuration object");
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new TypeError(`Unknown logging option: ${key}`);
  }
  return value as Record<string, unknown>;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("Expected a logging boolean");
  return value;
}

function level(value: unknown): LogLevel {
  if (!isLogLevel(value)) throw new TypeError("Invalid logging level");
  return value;
}

function integer(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new RangeError("Invalid logging integer option");
  }
  return value as number;
}

export function freezeSettings(settings: NodeLogsSettings): NodeLogsSettings {
  return Object.freeze({
    terminal: Object.freeze({ ...settings.terminal }),
    file: Object.freeze({ ...settings.file }),
    recent: Object.freeze({ ...settings.recent }),
  });
}

function requireOutput(settings: NodeLogsSettings): NodeLogsSettings {
  if (!settings.terminal.enabled && !settings.file.enabled && !settings.recent.enabled) {
    throw new TypeError("At least one logging output must be enabled");
  }
  return freezeSettings(settings);
}

export function initialSettings(options: NodeLogsOptions): NodeLogsSettings {
  const input = object(options, ["directory", "terminal", "file", "recent"]);
  if (
    typeof input.directory !== "string" ||
    !input.directory.trim() ||
    input.directory.includes("\0")
  ) {
    throw new TypeError("An explicit logging directory is required");
  }
  const terminal = object(input.terminal, ["enabled", "minimumLevel"]);
  const file = object(input.file, ["enabled", "minimumLevel", "retentionDays"]);
  const recent =
    input.recent === undefined ? {} : object(input.recent, ["enabled", "minimumLevel", "capacity"]);
  return requireOutput({
    terminal: {
      enabled: boolean(terminal.enabled),
      minimumLevel: level(terminal.minimumLevel === undefined ? "info" : terminal.minimumLevel),
    },
    file: {
      enabled: boolean(file.enabled),
      minimumLevel: level(file.minimumLevel === undefined ? "info" : file.minimumLevel),
      retentionDays: integer(file.retentionDays === undefined ? 7 : file.retentionDays, 90),
    },
    recent: {
      enabled: recent.enabled === undefined ? true : boolean(recent.enabled),
      minimumLevel: level(recent.minimumLevel === undefined ? "info" : recent.minimumLevel),
      capacity: integer(recent.capacity === undefined ? 300 : recent.capacity, 0xffffffff),
    },
  });
}

export function snapshotPatch(patch: NodeLogsSettingsPatch): NodeLogsSettingsPatch {
  const input = object(patch, ["terminal", "file", "recent"]);
  const result: Record<string, Record<string, boolean | number | LogLevel>> = {};
  for (const slot of ["terminal", "file", "recent"] as const) {
    if (!Object.hasOwn(input, slot)) continue;
    const keys =
      slot === "file"
        ? ["enabled", "minimumLevel", "retentionDays"]
        : slot === "recent"
          ? ["enabled", "minimumLevel", "capacity"]
          : ["enabled", "minimumLevel"];
    const values = object(input[slot], keys);
    const copied: Record<string, boolean | number | LogLevel> = {};
    if (Object.hasOwn(values, "enabled")) copied.enabled = boolean(values.enabled);
    if (Object.hasOwn(values, "minimumLevel")) copied.minimumLevel = level(values.minimumLevel);
    if (Object.hasOwn(values, "retentionDays"))
      copied.retentionDays = integer(values.retentionDays, 90);
    if (Object.hasOwn(values, "capacity")) copied.capacity = integer(values.capacity, 0xffffffff);
    result[slot] = Object.freeze(copied);
  }
  return Object.freeze(result) as NodeLogsSettingsPatch;
}

export function patchSettings(
  current: NodeLogsSettings,
  patch: NodeLogsSettingsPatch,
): NodeLogsSettings {
  return requireOutput({
    terminal: { ...current.terminal, ...patch.terminal },
    file: { ...current.file, ...patch.file },
    recent: { ...current.recent, ...patch.recent },
  });
}

/** 环形缓冲只保留运行时已封闭的安全记录，不复制原始输入。 */
export class RecentOutput {
  private records: LogRecord[] = [];
  private start = 0;
  private size = 0;

  constructor(private capacity: number) {}

  export(record: LogRecord): void {
    this.records[(this.start + this.size) % this.capacity] = record;
    if (this.size < this.capacity) this.size++;
    else this.start = (this.start + 1) % this.capacity;
  }

  async close(): Promise<void> {}

  resize(capacity: number): void {
    if (capacity === this.capacity) return;
    const count = Math.min(this.size, capacity);
    const records: LogRecord[] = [];
    for (let offset = this.size - count; offset < this.size; offset++) {
      records.push(this.records[(this.start + offset) % this.capacity]);
    }
    this.records = records;
    this.start = 0;
    this.size = count;
    this.capacity = capacity;
  }

  query(query: RecentLogQuery = {}): readonly LogRecord[] {
    const input = object(query, ["limit", "minimumLevel"]);
    const minimum = input.minimumLevel === undefined ? "debug" : level(input.minimumLevel);
    const limit = input.limit === undefined ? this.capacity : integer(input.limit, this.capacity);
    const result: LogRecord[] = [];
    for (let offset = this.size - 1; offset >= 0 && result.length < limit; offset--) {
      const record = this.records[(this.start + offset) % this.capacity];
      if (levelPriority[record.level] >= levelPriority[minimum]) result.push(record);
    }
    return Object.freeze(result);
  }
}
