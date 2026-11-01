import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "@agent-harness/tools/atomic-files";
import type { AppLogLevel, LogManagerSettings } from "@shared/logging";

export const levelPriority: Record<AppLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: unknown): value is AppLogLevel {
  return typeof value === "string" && Object.hasOwn(levelPriority, value);
}

function retention(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(90, Math.trunc(value)))
    : undefined;
}

/** Historical settings are normalized field by field; invalid fields do not erase defaults. */
export async function loadLogSettings(directory: string, environment: NodeJS.ProcessEnv): Promise<LogManagerSettings> {
  const envLevel = environment.AGENT_LOG_LEVEL?.trim().toLowerCase();
  const defaults: LogManagerSettings = {
    level: isLogLevel(envLevel) ? envLevel : environment.VITEST === "true" || environment.NODE_ENV === "test" ? "error" : "info",
    fileEnabled: environment.AGENT_LOG_FILE !== "false",
    retentionDays: 7,
  };
  const filename = join(directory, "settings.json");
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) return defaults;
    const parsed: unknown = JSON.parse(await readFile(filename, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
    const values = parsed as Record<string, unknown>;
    return {
      level: isLogLevel(values.level) ? values.level : defaults.level,
      fileEnabled: typeof values.fileEnabled === "boolean" ? values.fileEnabled : defaults.fileEnabled,
      retentionDays: retention(values.retentionDays) ?? defaults.retentionDays,
    };
  } catch {
    return defaults;
  }
}

export function snapshotSettingsPatch(patch: Partial<LogManagerSettings>): Partial<LogManagerSettings> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("Invalid log settings patch");
  const result: Partial<LogManagerSettings> = {};
  for (const key of Object.keys(patch)) {
    if (key !== "level" && key !== "fileEnabled" && key !== "retentionDays") throw new TypeError("Unknown log setting");
  }
  if (patch.level !== undefined) {
    if (!isLogLevel(patch.level)) throw new TypeError("Invalid log level");
    result.level = patch.level;
  }
  if (patch.fileEnabled !== undefined) {
    if (typeof patch.fileEnabled !== "boolean") throw new TypeError("Invalid log file setting");
    result.fileEnabled = patch.fileEnabled;
  }
  if (patch.retentionDays !== undefined) {
    const days = retention(patch.retentionDays);
    if (days === undefined) throw new TypeError("Invalid log retention");
    result.retentionDays = days;
  }
  return result;
}

export async function saveLogSettings(directory: string, settings: LogManagerSettings): Promise<void> {
  const filename = join(directory, "settings.json");
  try {
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Log settings path is not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeJsonFileAtomic(filename, settings);
}

export class LogSettingsPersistenceError extends Error {
  readonly settings: LogManagerSettings;
  constructor(settings: LogManagerSettings, cause: unknown) {
    super("Log settings are active, but saving them failed", { cause });
    this.name = "LogSettingsPersistenceError";
    this.settings = { ...settings };
  }
}
