import type { JsonValue, ProtocolError } from "./protocol-values";

export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export function asProtocolError(error: unknown): ProtocolError {
  return error instanceof AgentError
    ? { code: error.code, message: error.message }
    : { code: "EXECUTION_FAILED", message: "Agent execution failed" };
}

/** 不接受会在 JSON 中静默丢失或变形的值。协议边界返回独立快照。 */
export function snapshot<T>(value: T): T {
  assertJson(value, new Set());
  return structuredClone(value);
}

function assertJson(value: unknown, parents: Set<object>): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null) {
    throw new AgentError("INVALID_PROTOCOL_VALUE", "Protocol values must be lossless JSON");
  }
  if (parents.has(value)) throw new AgentError("INVALID_PROTOCOL_VALUE", "Cyclic protocol value");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new AgentError("INVALID_PROTOCOL_VALUE", "Protocol objects must be plain JSON objects");
  }
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index))
          throw new AgentError("INVALID_PROTOCOL_VALUE", "Sparse protocol array");
        assertJson(value[index], parents);
      }
    } else {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string")
          throw new AgentError("INVALID_PROTOCOL_VALUE", "Symbol protocol key");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new AgentError(
            "INVALID_PROTOCOL_VALUE",
            "Protocol properties must be enumerable data",
          );
        }
        assertJson(descriptor.value, parents);
      }
    }
  } finally {
    parents.delete(value);
  }
}

export function sameValue(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value) ?? "undefined";
  };
  return canonical(left) === canonical(right);
}
