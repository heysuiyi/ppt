import { mkdir, rmdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { LogInput } from "@agent-harness/logs/logs";
import { createNodeLogs, type Logger, type NodeLogs } from "@agent-harness/logs/node-logs";
import type {
  AppLogEntry,
  AppLogLevel,
  LogClearResult,
  LogManagerSettings,
  LogManagerStatus,
} from "@shared/logging";
import {
  clearGatewayIoLogFiles,
  GatewayIoLogManagementError,
  measureGatewayIoLogUsage,
  pruneGatewayIoLogFiles,
} from "../agent/gateway/gateway-io-log";
import { contextualLogger } from "./log-context";
import {
  acquireHistoricalOwner,
  createDesktopOwner,
  type DesktopOwner,
  type HistoryFile,
  identifyDesktopOwner,
  inventoryHistory,
  recentHistory,
  regularDirectory,
  removeDesktopOwnerMarker,
  removeHistoryFile,
  retentionCutoffs,
} from "./log-history";
import {
  isLogLevel,
  LogSettingsPersistenceError,
  levelPriority,
  loadLogSettings,
  saveLogSettings,
  snapshotSettingsPatch,
} from "./log-settings";

export { LogSettingsPersistenceError } from "./log-settings";

export interface DesktopLogs {
  readonly directory: string;
  getLogger(name: string): Logger;
  getStatus(): Promise<LogManagerStatus>;
  getRecentEntries(limit?: number, minimumLevel?: AppLogLevel): Promise<AppLogEntry[]>;
  updateSettings(patch: Partial<LogManagerSettings>): Promise<LogManagerSettings>;
  clear(): Promise<LogClearResult>;
  close(): Promise<void>;
}

function startupFailure(): void {
  try {
    process.stderr.write("Desktop diagnostic logging initialization failed\n");
  } catch {
    /* Independent, safe last resort. */
  }
}

export async function createDesktopLogs(options: {
  directory: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<DesktopLogs> {
  const directory = resolve(options.directory);
  try {
    await mkdir(directory, { recursive: true });
    if (!(await regularDirectory(directory)))
      throw new Error("Log root is not a regular directory");
  } catch (error) {
    startupFailure();
    throw error;
  }
  let settings = await loadLogSettings(directory, { ...(options.environment ?? process.env) });
  let owner: DesktopOwner | undefined;
  let logs: NodeLogs | undefined;
  let compromised = false;
  let instanceDirectory: string | undefined;

  async function rollbackInitialization(): Promise<unknown[]> {
    const failures: unknown[] = [];
    const cleanup = async (
      operation: () => Promise<unknown>,
      allowNonempty = false,
    ): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && !(allowNonempty && (code === "ENOTEMPTY" || code === "EEXIST"))) {
          failures.push(error);
        }
      }
    };
    try {
      const safelyOwned =
        owner &&
        !compromised &&
        (await regularDirectory(join(directory, "desktop"))) &&
        (await regularDirectory(owner.directory));
      if (logs) {
        const initializedLogs = logs;
        if (safelyOwned) {
          if (!instanceDirectory) {
            await cleanup(async () => {
              instanceDirectory = (await initializedLogs.getFileStatus()).directory;
            });
          }
          await cleanup(() => initializedLogs.reset());
        }
        await cleanup(() => initializedLogs.close());
      }
      if (owner && safelyOwned) {
        if (instanceDirectory) await cleanup(() => rmdir(instanceDirectory!), true);
        await cleanup(() => removeDesktopOwnerMarker(owner!));
        await cleanup(() => rmdir(owner!.directory), true);
      }
    } catch (error) {
      failures.push(error);
      await logs?.close().catch((closeError: unknown) => {
        failures.push(closeError);
      });
    } finally {
      // Keep cooperative ownership through every deletion, including the marker.
      if (owner) await cleanup(() => owner!.release());
    }
    return failures;
  }

  try {
    owner = await createDesktopOwner(directory, () => {
      compromised = true;
      try {
        process.stderr.write("Desktop diagnostic logging ownership was lost\n");
      } catch {
        /* No exception details. */
      }
      void logs?.close().catch(() => undefined);
    });
    logs = await createNodeLogs({
      directory: owner.directory,
      terminal: { enabled: true, minimumLevel: settings.level },
      file: {
        enabled: settings.fileEnabled,
        minimumLevel: settings.level,
        retentionDays: settings.retentionDays,
      },
      recent: { enabled: true, minimumLevel: settings.level, capacity: 300 },
    });
    const current = await logs.getFileStatus();
    instanceDirectory = current.directory;
    await identifyDesktopOwner(owner, basename(current.directory));
  } catch (error) {
    startupFailure();
    const failures = await rollbackInitialization();
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "Desktop logs initialization and cleanup failed",
      );
    throw error;
  }
  const nodeLogs = logs;
  const currentOwner = owner;
  let management: Promise<unknown> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let settingsPersistenceError = false;
  let maintenanceSkipped: string[] = [];
  let retainedDay = "";
  let scheduledDay = "";
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closePromise || compromised)
      return Promise.reject(new Error("Desktop logs are closing or ownership was lost"));
    const result = management.then(() => {
      if (compromised) throw new Error("Desktop logging ownership was lost");
      return operation();
    });
    management = result.catch(() => undefined);
    return result;
  };

  async function govern(clear: boolean): Promise<LogClearResult> {
    const result: LogClearResult = { removedFiles: 0, skipped: [] };
    if (clear) {
      const before = await nodeLogs.getFileStatus();
      try {
        result.removedFiles += await nodeLogs.reset();
      } catch {
        const after = await nodeLogs.getFileStatus().catch(() => undefined);
        if (after) result.removedFiles += Math.max(0, before.fileCount - after.fileCount);
        result.skipped.push(`${before.directory}: current instance reset failed`);
      }
    }
    const inventory = await inventoryHistory(directory);
    result.skipped.push(...inventory.skipped);
    const cutoff = retentionCutoffs(settings.retentionDays);
    const expired = (file: HistoryFile) =>
      clear ||
      (file.day
        ? file.day < (file.legacy ? cutoff.local : cutoff.utc)
        : file.modified < cutoff.localMs);
    for (const file of inventory.files.filter((file) => file.legacy && expired(file))) {
      try {
        if (await removeHistoryFile(file, directory)) result.removedFiles++;
        else result.skipped.push(`${file.filename}: file is no longer safely managed`);
      } catch {
        result.skipped.push(`${file.filename}: removal failed`);
      }
    }
    for (const historical of inventory.owners) {
      if (historical.directory === currentOwner.directory) continue;
      let release: (() => Promise<void>) | undefined;
      try {
        release = await acquireHistoricalOwner(historical);
        for (const file of historical.files.filter(expired)) {
          try {
            if (await removeHistoryFile(file, directory)) result.removedFiles++;
            else result.skipped.push(`${file.filename}: file is no longer safely managed`);
          } catch {
            result.skipped.push(`${file.filename}: removal failed`);
          }
        }
      } catch {
        result.skipped.push(
          `${historical.directory}: active owner or non-activity cannot be proven`,
        );
      } finally {
        if (release)
          await release().catch(() => {
            result.skipped.push(`${historical.directory}: ownership release failed`);
          });
      }
    }
    try {
      result.removedFiles += clear
        ? await clearGatewayIoLogFiles(directory)
        : await pruneGatewayIoLogFiles(settings.retentionDays, new Date(), directory);
    } catch (error) {
      if (error instanceof GatewayIoLogManagementError) {
        result.removedFiles += error.removedFiles;
        result.skipped.push(...error.skipped);
      } else {
        result.skipped.push(`${join(directory, "gateway")}: busy or archive management failed`);
      }
    }
    maintenanceSkipped = [...result.skipped];
    return result;
  }

  async function retain(): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    if (retainedDay === day) return;
    const result = await govern(false);
    if (result.skipped.some((reason) => reason.includes("failed"))) {
      try {
        process.stderr.write(
          "Desktop diagnostic retention could not remove some managed artifacts\n",
        );
      } catch {
        /* Independent diagnostic path. */
      }
    }
    retainedDay = day;
  }

  function managedLogger(logger: Logger): Logger {
    const write = (level: AppLogLevel, event: string, data?: LogInput): void => {
      if (compromised || closePromise) return;
      logger[level](event, data);
      const day = new Date().toISOString().slice(0, 10);
      if (day === retainedDay || day === scheduledDay) return;
      // A write stays synchronous; only the first write after a UTC day switch
      // schedules host governance. Failed attempts are not retried per entry.
      scheduledDay = day;
      void enqueue(retain).catch(() => {
        try {
          process.stderr.write("Desktop diagnostic retention failed\n");
        } catch {
          /* No recursive diagnostic logging. */
        }
      });
    };
    return {
      child: (context) => managedLogger(logger.child(context)),
      isEnabled: (level) => !compromised && !closePromise && logger.isEnabled(level),
      debug: (event, data) => write("debug", event, data),
      info: (event, data) => write("info", event, data),
      warn: (event, data) => write("warn", event, data),
      error: (event, data) => write("error", event, data),
    };
  }

  const desktop: DesktopLogs = {
    directory,
    getLogger: (name) => managedLogger(contextualLogger(nodeLogs.getLogger(name))),
    getStatus() {
      return enqueue(async () => {
        await retain();
        const inventory = await inventoryHistory(directory);
        const gateway = await measureGatewayIoLogUsage(directory);
        const current = await nodeLogs.getFileStatus();
        const lastWrittenMs = inventory.files.reduce(
          (latest, file) => Math.max(latest, file.modified),
          gateway.lastWrittenAt ? Date.parse(gateway.lastWrittenAt) : 0,
        );
        return {
          ...settings,
          directory,
          fileCount: inventory.files.length + gateway.fileCount,
          totalBytes:
            inventory.files.reduce((total, file) => total + file.size, 0) + gateway.totalBytes,
          ...(lastWrittenMs > 0 ? { lastWrittenAt: new Date(lastWrittenMs).toISOString() } : {}),
          failureCount: Math.max(
            current.failureCount,
            nodeLogs.getStatus().outputs.reduce((total, output) => total + output.failureCount, 0),
          ),
          settingsPersistenceError,
          maintenanceSkipped: [...maintenanceSkipped],
        };
      });
    },
    getRecentEntries(limit = 100, minimumLevel: AppLogLevel = "debug") {
      const safeLimit = Number.isFinite(limit)
        ? Math.max(1, Math.min(300, Math.trunc(limit) || 100))
        : 100;
      const minimum = isLogLevel(minimumLevel) ? minimumLevel : "debug";
      return enqueue(async () => {
        await retain();
        const inventory = await inventoryHistory(directory);
        const candidates = await recentHistory(
          inventory.files,
          nodeLogs.getRecentEntries({ limit: 300, minimumLevel: "debug" }),
        );
        return candidates
          .filter((entry) => levelPriority[entry.level] >= levelPriority[minimum])
          .slice(-safeLimit)
          .reverse();
      });
    },
    updateSettings(patch) {
      let snapshot: Partial<LogManagerSettings>;
      try {
        snapshot = snapshotSettingsPatch(patch);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueue(async () => {
        const next = { ...settings, ...snapshot };
        await nodeLogs.updateSettings({
          terminal: { minimumLevel: next.level },
          file: {
            enabled: next.fileEnabled,
            minimumLevel: next.level,
            retentionDays: next.retentionDays,
          },
          recent: { enabled: true, minimumLevel: next.level, capacity: 300 },
        });
        settings = next;
        retainedDay = "";
        scheduledDay = "";
        try {
          await saveLogSettings(directory, settings);
          settingsPersistenceError = false;
        } catch (cause) {
          settingsPersistenceError = true;
          throw new LogSettingsPersistenceError(settings, cause);
        }
        await retain();
        return { ...settings };
      });
    },
    clear: () => enqueue(() => govern(true)),
    close() {
      if (!closePromise) {
        closePromise = management.then(async () => {
          try {
            await nodeLogs.close();
          } finally {
            await currentOwner.release();
          }
        });
      }
      return closePromise;
    },
  };
  try {
    await retain();
    return desktop;
  } catch (error) {
    startupFailure();
    const failures = await rollbackInitialization();
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "Desktop logs initialization and cleanup failed",
      );
    throw error;
  }
}
