import { createLogRuntime } from "./internal/log-runtime";
import type { Logs, LogsOptions } from "./log-contract";

export type {
  LogContext,
  LogData,
  LogExporter,
  Logger,
  LogInput,
  LogLevel,
  LogOutput,
  LogOutputStatus,
  LogRecord,
  Logs,
  LogsOptions,
  LogsStatus,
  LogValue,
} from "./log-contract";

/** 创建只含通用机制的日志实例；配置成功后由实例拥有各输出。 */
export function createLogs(options: LogsOptions): Logs {
  if (!options || !Array.isArray(options.outputs)) {
    throw new TypeError("Logs requires explicit outputs.");
  }
  return createLogRuntime(options.outputs.map((output) => ({ ...output, enabled: true }))).logs;
}
