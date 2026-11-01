import type {
  LogContext,
  LogData,
  LogInput,
  LogLevel,
  LogRecord,
  LogValue,
} from "../log-contract.js";

const MAX_DEPTH = 6;
const MAX_ITEMS = 50;
const MAX_STRING = 16_384;
const MAX_ENVELOPE_STRING = 256;
const MAX_RECORD_BYTES = 65_536;
const MAX_DATA_BYTES = 48_000;
const MAX_NODES = 2_048;
const REDACTED = "[REDACTED]";
const TRUNCATED = "[Truncated]";
const UNREADABLE = "[Unreadable]";
const OMITTED = "[Omitted]";
const budgetExceeded = Symbol("log budget exceeded");
const snapshotFailed = Symbol("log snapshot failed");
const encoder = new TextEncoder();
const emptyContext: LogContext = Object.freeze(Object.create(null) as LogContext);
const ownedContexts = new WeakSet<LogContext>([emptyContext]);
const unsafeProperties: Readonly<Record<string, true | undefined>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, true>, {
    ["__proto__"]: true,
    constructor: true,
    prototype: true,
    toJSON: true,
  }),
);
const contextFields = [
  "operation",
  "sessionId",
  "agentId",
  "threadId",
  "queryId",
  "runId",
  "requestId",
  "toolCallId",
] as const;

interface SnapshotBudget {
  bytes: number;
  nodes: number;
  readonly ancestors: WeakSet<object>;
}

function dictionary(): Record<string, LogValue> {
  return Object.create(null) as Record<string, LogValue>;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized.includes("apikey") ||
    normalized.includes("authorization") ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.endsWith("token") ||
    normalized.endsWith("bearer")
  );
}

function sanitizeString(value: string, limit = MAX_STRING): string {
  const shortened = value.length > limit;
  let text = shortened ? value.slice(0, limit - TRUNCATED.length) : value;
  // 截断可能发生在 URL 的 @ 之前，不能把被截断的 userinfo 当作主机名留下。
  if (shortened) {
    text = text.replace(/(?:[a-z][a-z0-9+.-]{0,31}:)?\/\/[^\s]*$/gi, REDACTED);
  }
  text = text
    .replace(/((?:[a-z][a-z0-9+.-]{0,31}:)?\/\/)[^\s/?#]*@/gi, `$1${REDACTED}@`)
    .replace(/([?&;])([^=?\s&#;]{1,256})=([^&#\s;]*)/g, (match, separator: string, key: string) => {
      let decoded = key;
      try {
        decoded = decodeURIComponent(key.replace(/\+/g, " "));
      } catch {
        // 无效的 URL 编码不携带诊断异常原文。
      }
      return isSensitiveKey(decoded) ? `${separator}${key}=${REDACTED}` : match;
    })
    .replace(/\bbearer(?:\s+|%20)[^\s"'<>\\,;}]+/gi, REDACTED)
    .replace(/(^|[^a-z0-9])(?:sk|tvly|ttp|tp)-[a-z0-9_-]+/gi, `$1${REDACTED}`);
  if (shortened || text.length > limit) {
    return text.slice(0, limit - TRUNCATED.length) + TRUNCATED;
  }
  return text;
}

function projectContext(parent: LogContext, child: LogContext): LogContext {
  let result: Record<string, string | number> | undefined;
  for (const source of [parent, child]) {
    if (source === null || typeof source !== "object") continue;
    for (const field of contextFields) {
      const descriptor = Object.getOwnPropertyDescriptor(source, field);
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
        result ??= Object.create(null) as Record<string, string | number>;
        result[field] = sanitizeString(descriptor.value, MAX_ENVELOPE_STRING);
      }
    }
    const step = Object.getOwnPropertyDescriptor(source, "step");
    if (
      step &&
      "value" in step &&
      typeof step.value === "number" &&
      Number.isFinite(step.value) &&
      Number.isInteger(step.value) &&
      step.value >= 0
    ) {
      result ??= Object.create(null) as Record<string, string | number>;
      result.step = step.value;
    }
  }
  if (result === undefined) return emptyContext;
  Object.freeze(result);
  ownedContexts.add(result);
  return result;
}

/** 绑定时仅投影已知的自身数据字段，不保留调用方上下文引用。 */
export function snapshotContext(parent: LogContext, child: LogContext): LogContext {
  try {
    return projectContext(parent, child);
  } catch {
    return emptyContext;
  }
}

function spend(budget: SnapshotBudget, bytes: number): void {
  budget.bytes += bytes;
  if (budget.bytes > MAX_DATA_BYTES) throw budgetExceeded;
}

function stringValue(value: string, budget: SnapshotBudget, limit = MAX_STRING): string {
  const safe = sanitizeString(value, limit);
  spend(budget, encoder.encode(JSON.stringify(safe)).length);
  return safe;
}

function marker(value: string, budget: SnapshotBudget): string {
  spend(budget, value.length + 2);
  return value;
}

function inheritedData(value: object, key: string): unknown {
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < MAX_DEPTH; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function snapshotError(value: Error, budget: SnapshotBudget): LogData {
  const result = dictionary();
  spend(budget, 16);
  const name = inheritedData(value, "name");
  result.name = stringValue(typeof name === "string" ? name : "Error", budget, MAX_ENVELOPE_STRING);
  const code = inheritedData(value, "code");
  if (
    code === null ||
    typeof code === "string" ||
    typeof code === "boolean" ||
    (typeof code === "number" && Number.isFinite(code))
  ) {
    result.code = snapshotValue(code, 0, budget);
  }
  return Object.freeze(result);
}

function snapshotArray(
  value: unknown[],
  depth: number,
  budget: SnapshotBudget,
): readonly LogValue[] {
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || typeof length.value !== "number") {
    throw snapshotFailed;
  }
  const result: LogValue[] = [];
  // 保留数组的正常读取 API，但封住 JSON.stringify 的隐式 toJSON 查找。
  Object.defineProperty(result, "toJSON", { value: undefined });
  spend(budget, 2);
  const truncated = length.value > MAX_ITEMS;
  const count = Math.min(length.value, truncated ? MAX_ITEMS - 1 : MAX_ITEMS);
  for (let index = 0; index < count; index += 1) {
    spend(budget, 1);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    result.push(
      !descriptor
        ? snapshotValue(null, depth + 1, budget)
        : "value" in descriptor
          ? snapshotValue(descriptor.value, depth + 1, budget)
          : marker(UNREADABLE, budget),
    );
  }
  if (truncated) result.push(marker(TRUNCATED, budget));
  return Object.freeze(result);
}

function snapshotObject(value: object, depth: number, budget: SnapshotBudget): LogData {
  const result = dictionary();
  spend(budget, 2);
  // 只枚举一次键；不建立包含所有原始值的 entries 快照。
  const keys = Object.keys(value);
  const truncated = keys.length > MAX_ITEMS;
  const count = Math.min(keys.length, truncated ? MAX_ITEMS - 1 : MAX_ITEMS);
  for (let index = 0; index < count; index += 1) {
    const key = keys[index];
    if (key.length > MAX_ENVELOPE_STRING) {
      spend(budget, 32);
      result[`[Omitted key ${index}]`] = marker(OMITTED, budget);
      continue;
    }
    if (unsafeProperties[key]) continue;
    const safeKey = sanitizeString(key, MAX_ENVELOPE_STRING);
    if (unsafeProperties[safeKey] || Object.hasOwn(result, safeKey)) continue;
    spend(budget, encoder.encode(JSON.stringify(safeKey)).length + 2);
    if (isSensitiveKey(key) || safeKey !== key) {
      result[safeKey] = marker(REDACTED, budget);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    result[safeKey] =
      descriptor && "value" in descriptor
        ? snapshotValue(descriptor.value, depth + 1, budget)
        : marker(UNREADABLE, budget);
  }
  if (truncated) {
    spend(budget, 16);
    result[TRUNCATED] = marker(TRUNCATED, budget);
  }
  return Object.freeze(result);
}

function snapshotValue(value: unknown, depth: number, budget: SnapshotBudget): LogValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) throw budgetExceeded;
  if (value === null || typeof value === "boolean") {
    spend(budget, 5);
    return value;
  }
  if (typeof value === "string") return stringValue(value, budget);
  if (typeof value === "number" && Number.isFinite(value)) {
    spend(budget, 25);
    return value;
  }
  if (typeof value !== "object") return marker(OMITTED, budget);
  if (budget.ancestors.has(value)) return marker("[Circular]", budget);
  if (depth >= MAX_DEPTH) return marker(TRUNCATED, budget);
  if (ArrayBuffer.isView(value)) return marker(OMITTED, budget);
  const array = Array.isArray(value);
  if (!array) {
    let prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== null && prototype !== Object.prototype) {
      // instanceof 会无界遍历代理提供的原型链；这里只做有界的 Error 品牌投影。
      for (let hops = 0; prototype !== null && hops < MAX_DEPTH; hops += 1) {
        if (prototype === Error.prototype) return snapshotError(value as Error, budget);
        if (prototype === Object.prototype) break;
        prototype = Object.getPrototypeOf(prototype) as object | null;
      }
      return marker(OMITTED, budget);
    }
  }
  budget.ancestors.add(value);
  try {
    return array
      ? snapshotArray(value as unknown[], depth, budget)
      : snapshotObject(value, depth, budget);
  } finally {
    budget.ancestors.delete(value);
  }
}

function summary(value: string): LogData {
  const result = dictionary();
  result.summary = value;
  return Object.freeze(result);
}

function snapshotInput(input: LogInput): LogData {
  const value = snapshotValue(input, 0, {
    bytes: 0,
    nodes: 0,
    ancestors: new WeakSet(),
  });
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as LogData)
    : summary(OMITTED);
}

/** 仅在运行时已决定受理后调用；任何快照异常都不能成为执行异常。 */
export function createLogRecord(
  instanceId: string,
  sequence: number,
  name: string,
  event: string,
  level: LogLevel,
  context: LogContext,
  input?: LogInput,
): LogRecord {
  const envelope = {
    schemaVersion: 1 as const,
    timestamp: new Date().toISOString(),
    instanceId,
    sequence,
    level,
    name: typeof name === "string" ? sanitizeString(name, MAX_ENVELOPE_STRING) : OMITTED,
    event: typeof event === "string" ? sanitizeString(event, MAX_ENVELOPE_STRING) : OMITTED,
  };
  let safeContext: LogContext;
  let data: LogData | undefined;
  try {
    safeContext = ownedContexts.has(context) ? context : projectContext(context, {});
    if (input !== undefined) {
      try {
        data = snapshotInput(input);
      } catch (error) {
        if (error !== budgetExceeded) throw error;
        data = summary(TRUNCATED);
      }
    }
  } catch {
    safeContext = emptyContext;
    data = summary(UNREADABLE);
  }
  const record = Object.assign(Object.create(null) as LogRecord, envelope, {
    context: safeContext,
    ...(data === undefined ? {} : { data }),
  });
  if (encoder.encode(JSON.stringify(record)).length > MAX_RECORD_BYTES) {
    Object.defineProperty(record, "data", { value: summary(TRUNCATED), enumerable: true });
  }
  return Object.freeze(record);
}
