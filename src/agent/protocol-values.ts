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
