import type { AppLogLevel, RendererLogReport } from "@shared/logging";

function normalizeError(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return { message: typeof value === "string" ? value : String(value) };
}

function normalizeConsoleArgument(value: unknown): unknown {
  if (value instanceof Error) return normalizeError(value);
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) {
    return value;
  }
  try {
    const seen = new WeakSet<object>();
    return JSON.parse(
      JSON.stringify(value, (_key, item: unknown) => {
        if (item instanceof Error) return normalizeError(item);
        if (typeof item === "bigint") return item.toString();
        if (item && typeof item === "object") {
          if (seen.has(item)) return "[Circular]";
          seen.add(item);
        }
        return item;
      }),
    );
  } catch {
    return String(value);
  }
}

export function reportRendererLog(
  level: AppLogLevel,
  event: string,
  data?: Record<string, unknown>,
): void {
  const report: RendererLogReport = { level, event, data };
  try {
    window.desktopApi?.reportRendererLog(report);
  } catch {
    // Diagnostics must never turn a recoverable renderer error into an error loop.
  }
}

export function installRendererErrorReporting(): () => void {
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    originalError(...args);
    reportRendererLog("error", "console.error", { arguments: args.map(normalizeConsoleArgument) });
  };
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    reportRendererLog("warn", "console.warn", { arguments: args.map(normalizeConsoleArgument) });
  };
  const handleError = (event: ErrorEvent) => {
    reportRendererLog("error", "window.error", {
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      ...(event.error ? { error: normalizeError(event.error) } : {}),
    });
  };
  const handleRejection = (event: PromiseRejectionEvent) => {
    reportRendererLog("error", "unhandled-rejection", {
      reason: normalizeError(event.reason),
    });
  };

  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleRejection);
  reportRendererLog("info", "started", { href: window.location.href });

  return () => {
    console.error = originalError;
    console.warn = originalWarn;
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleRejection);
  };
}
