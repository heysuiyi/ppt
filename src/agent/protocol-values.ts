import { AgentError } from "./protocol-errors";

/** 可跨持久化与插件协议边界传递的值；排除服务与密钥。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** 带版本的载荷归属于其命名的生产者，而非执行循环。 */
export interface VersionedData {
  readonly type: string;
  readonly version: number;
  readonly data: JsonValue;
}

/** 一个查询可在同一会话线程内跨越多次运行激活而存活。 */
export interface RunIdentity {
  readonly agentId: string;
  readonly threadId: string;
  readonly queryId: string;
  readonly runId: string;
}

/** 安全的公开错误数据；原生错误、凭据与堆栈跟踪保留在宿主侧。 */
export interface ProtocolError {
  readonly code: string;
  readonly message: string;
}

/** 由属主校验载荷并解释响应；内核仅负责路由。 */
export interface InteractionRequest {
  readonly id: string;
  readonly owner: string;
  readonly payload: VersionedData;
}

/** 仅解析已存储的待处理交互；这不是来自客户端的执行快照。 */
export type InteractionResponse =
  | { readonly interactionId: string; readonly type: "answer"; readonly value: JsonValue }
  | { readonly interactionId: string; readonly type: "reject" | "cancel" };

export interface Disposable {
  /** 幂等；在所拥有的工作与注册被释放后完成。 */
  dispose(): Promise<void>;
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
