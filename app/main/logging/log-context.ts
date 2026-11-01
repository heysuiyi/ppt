import { AsyncLocalStorage } from "node:async_hooks";
import type { LogContext, Logger, LogLevel, LogInput } from "@agent-harness/logs/log-contract";
import { sanitizeLogData } from "@agent-harness/logs/logs";

const storage = new AsyncLocalStorage<LogContext>();

/** 上下文属于桌面宿主；诊断日志和独立 Gateway 档案共享执行身份。 */
export function withLogContext<T>(context: LogContext, task: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, task);
}

export function getLogContext(): LogContext {
  return { ...storage.getStore() };
}

/** 显式 child 身份优先于异步环境，data 始终不能覆盖规范 context。 */
export function contextualLogger(logger: Logger): Logger {
  const wrap = (fixed: LogContext): Logger => {
    const write = (level: LogLevel, event: string, data?: LogInput) => {
      // 先过滤，避免对不记录的事件进行上下文或数据快照。
      if (!logger.isEnabled(level)) return;
      logger.child(getLogContext()).child(fixed)[level](event, data);
    };
    return {
      child(context) {
        // 不捕获调用方后续可修改的对象，不执行访问器。
        const snapshot = sanitizeLogData(context as LogInput) as unknown as LogContext;
        return wrap({ ...fixed, ...snapshot });
      },
      isEnabled: (level) => logger.isEnabled(level),
      debug: (event, data) => write("debug", event, data),
      info: (event, data) => write("info", event, data),
      warn: (event, data) => write("warn", event, data),
      error: (event, data) => write("error", event, data),
    };
  };
  return wrap({});
}
