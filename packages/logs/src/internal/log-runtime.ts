import type {
  LogContext,
  LogExporter,
  Logger,
  LogInput,
  LogLevel,
  Logs,
  LogsStatus,
} from "../log-contract.js";
import { createLogRecord, snapshotContext } from "./log-safety.js";

export const levelPriority: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

export function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

export interface RuntimeOutputSetting {
  readonly id: string;
  readonly minimumLevel: LogLevel;
  readonly enabled: boolean;
}

export interface RuntimeOutput extends RuntimeOutputSetting {
  readonly exporter: LogExporter;
}

export interface LogRuntime {
  readonly logs: Logs;
  readonly instanceId: string;
  stop(): void;
  configure(settings: readonly RuntimeOutputSetting[]): void;
}

interface OutputState {
  readonly id: string;
  readonly exporter: LogExporter;
  minimumLevel: LogLevel;
  enabled: boolean;
  failureCount: number;
  lastFailure?: {
    readonly timestamp: string;
    readonly operation: "export" | "close";
  };
}

const identifierPattern = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const emptyContext: LogContext = Object.freeze({});

function validateSettings(settings: readonly RuntimeOutputSetting[]): void {
  if (!Array.isArray(settings) || settings.length === 0) {
    throw new TypeError("Logs requires at least one output.");
  }
  const ids = new Set<string>();
  let enabled = false;
  for (const setting of settings) {
    if (
      !setting ||
      typeof setting.id !== "string" ||
      !identifierPattern.test(setting.id) ||
      ids.has(setting.id) ||
      !isLogLevel(setting.minimumLevel) ||
      typeof setting.enabled !== "boolean"
    ) {
      throw new TypeError("Invalid logs output configuration.");
    }
    ids.add(setting.id);
    enabled ||= setting.enabled;
  }
  if (!enabled) throw new TypeError("Logs requires an enabled output.");
}

/** 输出的配置与资源在校验成功后一次交接，不提供模块外动态注册。 */
export function createLogRuntime(configuration: readonly RuntimeOutput[]): LogRuntime {
  validateSettings(configuration);
  const exporters = new Set<LogExporter>();
  for (const output of configuration) {
    if (
      !output.exporter ||
      typeof output.exporter.export !== "function" ||
      typeof output.exporter.close !== "function" ||
      output.exporter.export.constructor.name === "AsyncFunction" ||
      exporters.has(output.exporter)
    ) {
      throw new TypeError("Outputs require distinct synchronous log exporters.");
    }
    exporters.add(output.exporter);
  }
  const instanceId = globalThis.crypto.randomUUID();
  const outputs: OutputState[] = configuration.map((output) => ({
    id: output.id,
    exporter: output.exporter,
    minimumLevel: output.minimumLevel,
    enabled: output.enabled,
    failureCount: 0,
  }));
  let state: LogsStatus["state"] = "open";
  let sequence = 0;
  let lateWriteCount = 0;
  let disposal: Promise<void> | undefined;

  function failure(output: OutputState, operation: "export" | "close"): void {
    output.failureCount++;
    output.lastFailure = Object.freeze({ timestamp: new Date().toISOString(), operation });
  }

  function isEnabled(level: LogLevel): boolean {
    return (
      state === "open" &&
      isLogLevel(level) &&
      outputs.some(
        (output) => output.enabled && levelPriority[level] >= levelPriority[output.minimumLevel],
      )
    );
  }

  function record(
    name: string,
    context: LogContext,
    level: LogLevel,
    event: string,
    data?: LogInput,
  ): void {
    if (state !== "open") {
      lateWriteCount++;
      return;
    }
    if (!isEnabled(level)) return;
    const entry = createLogRecord(instanceId, ++sequence, name, event, level, context, data);
    for (const output of outputs) {
      if (!output.enabled || levelPriority[level] < levelPriority[output.minimumLevel]) continue;
      try {
        const result: unknown = output.exporter.export(entry);
        // TypeScript 的 void 也可接收异步函数；运行时拒绝违约的异步输出。
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(result).catch(() => undefined);
          throw new TypeError("Log exporter must complete synchronously.");
        }
      } catch {
        failure(output, "export");
      }
    }
  }

  function logger(name: string, context: LogContext): Logger {
    return Object.freeze({
      child: (child: LogContext) => logger(name, snapshotContext(context, child)),
      isEnabled,
      debug: (event: string, data?: LogInput) => record(name, context, "debug", event, data),
      info: (event: string, data?: LogInput) => record(name, context, "info", event, data),
      warn: (event: string, data?: LogInput) => record(name, context, "warn", event, data),
      error: (event: string, data?: LogInput) => record(name, context, "error", event, data),
    });
  }

  function stop(): void {
    if (state === "open") state = "closing";
  }

  function close(): Promise<void> {
    if (disposal) return disposal;
    const completion = Promise.withResolvers<void>();
    disposal = completion.promise;
    stop();
    void (async () => {
      const errors: unknown[] = [];
      for (const output of outputs) {
        try {
          await output.exporter.close();
        } catch (error) {
          failure(output, "close");
          errors.push(error);
        }
      }
      state = "closed";
      if (errors.length) throw new AggregateError(errors, "Log outputs failed to close.");
    })().then(completion.resolve, completion.reject);
    return disposal;
  }

  const logs: Logs = Object.freeze({
    getLogger(name: string) {
      if (typeof name !== "string" || !identifierPattern.test(name)) {
        throw new TypeError("Logger name must be a stable identifier of at most 128 characters.");
      }
      return logger(name, emptyContext);
    },
    getStatus() {
      return Object.freeze({
        state,
        lateWriteCount,
        outputs: Object.freeze(
          outputs.map((output) =>
            Object.freeze({
              id: output.id,
              failureCount: output.failureCount,
              ...(output.lastFailure ? { lastFailure: output.lastFailure } : {}),
            }),
          ),
        ),
      });
    },
    close,
  });

  return {
    logs,
    instanceId,
    stop,
    configure(settings) {
      validateSettings(settings);
      if (
        settings.length !== outputs.length ||
        settings.some((setting, index) => setting.id !== outputs[index].id)
      ) {
        throw new TypeError("Log output identities cannot change.");
      }
      // 校验整组设置后才发布；允许已受理的 Node 管理操作在 closing 阶段结算。
      for (let index = 0; index < outputs.length; index++) {
        outputs[index].enabled = settings[index].enabled;
        outputs[index].minimumLevel = settings[index].minimumLevel;
      }
    },
  };
}
