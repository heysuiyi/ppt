import { writeSync } from "node:fs";
import type {
  LogExporter,
  NodeLogs,
  NodeLogsOptions,
  NodeLogsSettings,
  NodeLogsSettingsPatch,
} from "../log-contract";
import { createLogRuntime, type RuntimeOutputSetting } from "./log-runtime";
import { NodeFileOutput } from "./node-file-output";
import { initialSettings, patchSettings, RecentOutput, snapshotPatch } from "./node-settings";

function outputSettings(settings: NodeLogsSettings): readonly RuntimeOutputSetting[] {
  return (["terminal", "file", "recent"] as const).map((id) => ({
    id,
    ...settings[id],
  }));
}

export async function createNodeLogs(options: NodeLogsOptions): Promise<NodeLogs> {
  let settings = initialSettings(options);
  const recent = new RecentOutput(settings.recent.capacity);
  const file = new NodeFileOutput(options.directory);
  const terminal: LogExporter = {
    export(record) {
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(2, bytes, offset, bytes.length - offset);
        if (written === 0) throw new Error("The terminal log write made no progress");
        offset += written;
      }
    },
    async close() {},
  };
  const exporters = { terminal, file, recent };
  const runtime = createLogRuntime(
    outputSettings(settings).map((output) => ({
      ...output,
      exporter: exporters[output.id as keyof typeof exporters],
    })),
  );
  file.bind(runtime.instanceId);
  try {
    if (settings.file.enabled) file.prepare(settings.file.retentionDays);
    file.configure(settings.file.retentionDays);
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await runtime.logs.close();
    } catch (closeError) {
      failures.push(closeError);
    }
    try {
      file.rollback();
    } catch (rollbackError) {
      failures.push(rollbackError);
    }
    if (failures.length > 1) throw new AggregateError(failures, "Node logs initialization failed");
    throw error;
  }

  // 尾链吞掉已向调用方报告的错误，保证一次失败不阻断后来受理的管理操作。
  let management: Promise<unknown> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  const enqueue = <T>(operation: () => T): Promise<T> => {
    if (closePromise) return Promise.reject(new Error("Logs are closing"));
    const result = management.then(operation);
    management = result.catch(() => undefined);
    return result;
  };

  return {
    getLogger: runtime.logs.getLogger,
    getStatus: runtime.logs.getStatus,
    getSettings: () => settings,
    getRecentEntries: (query) => recent.query(query),
    async getFileStatus() {
      return file.status(settings.file.enabled);
    },
    updateSettings(patch: NodeLogsSettingsPatch) {
      if (closePromise) return Promise.reject(new Error("Logs are closing"));
      // 在受理时快照/校验补丁；在执行时基于最近成功提交的设置合并。
      // 不保留宿主可继续修改的补丁引用，也不能提前冻结另一项排队更新的结果。
      let snapshot: NodeLogsSettingsPatch;
      try {
        snapshot = snapshotPatch(patch);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueue(() => {
        const next = patchSettings(settings, snapshot);
        if (next.file.enabled) file.prepare(next.file.retentionDays);
        recent.resize(next.recent.capacity);
        file.configure(next.file.retentionDays);
        runtime.configure(outputSettings(next));
        settings = next;
        return settings;
      });
    },
    clearFiles() {
      return enqueue(() => file.clear());
    },
    close() {
      if (!closePromise) {
        runtime.stop();
        closePromise = management.then(() => runtime.logs.close());
      }
      return closePromise;
    },
  };
}
