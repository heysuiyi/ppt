import type { ZodType } from "zod";
import type {
  ModelToolCallContent,
  ModelToolContent,
  ModelToolSchema,
} from "../model/model-contract";
import type {
  Disposable,
  InteractionRequest,
  InteractionResponse,
  JsonValue,
  ProtocolError,
  RunIdentity,
  VersionedData,
} from "../protocol-values";

export interface ToolExecutionContext {
  readonly identity: RunIdentity;
  readonly callId: string;
  readonly signal: AbortSignal;
}

export type ToolAuthorizationDecision =
  | { readonly type: "allow" }
  | { readonly type: "deny"; readonly reason: string }
  | { readonly type: "approval"; readonly interaction: InteractionRequest };

export type ToolAuthorizationPolicy = (
  call: ModelToolCallContent,
  context: ToolExecutionContext,
) => ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>;

/** applied 表示发生了某种影响，并不表示所有预期工作都已成功。 */
export type ToolSideEffects = "none" | "applied" | "unknown";

/** unknown 是不确定的结果，并非重试有副作用操作的许可。 */
export type ToolResult<T = unknown> =
  | { readonly status: "succeeded"; readonly output: T; readonly effects: ToolSideEffects }
  | { readonly status: "failed"; readonly error: ProtocolError; readonly effects: ToolSideEffects }
  | {
      readonly status: "unknown";
      readonly error: ProtocolError;
      readonly effects: ToolSideEffects;
    };

export interface ToolSuspension {
  readonly status: "waiting";
  readonly interaction: InteractionRequest;
  /** 属主必须将续传数据绑定到工具版本，并在恢复时校验它。 */
  readonly continuation: VersionedData;
  readonly effects: ToolSideEffects;
}

interface ToolDefinitionFields<TInput, TOutput> {
  readonly name: string;
  readonly version: string;
  readonly owner: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  /** 输出必须能在执行器的持久化边界上表示为 JSON。 */
  readonly outputSchema: ZodType<TOutput>;
  /** 省略表示串行。parallel 仅声明可用性，并不调度工作。 */
  readonly concurrency?: "serial" | "parallel";
  /** 投影与业务输出分离，失败/未知结果同样适用。 */
  readonly toModelContent: (
    result: ToolResult<TOutput>,
  ) => readonly ModelToolContent[] | Promise<readonly ModelToolContent[]>;
  readonly toPresentation?: (result: ToolResult<TOutput>) => VersionedData | Promise<VersionedData>;
}

export interface ImmediateToolDefinition<TInput = unknown, TOutput = unknown>
  extends ToolDefinitionFields<TInput, TOutput> {
  readonly mode: "immediate";
  readonly execute: (input: TInput, context: ToolExecutionContext) => Promise<ToolResult<TOutput>>;
}

export interface ResumableToolDefinition<TInput = unknown, TOutput = unknown>
  extends ToolDefinitionFields<TInput, TOutput> {
  readonly mode: "resumable";
  readonly execute: (
    input: TInput,
    context: ToolExecutionContext,
  ) => Promise<ToolResult<TOutput> | ToolSuspension>;
  /**
   * 恢复已存储的续传数据，绝不恢复不可信的客户端快照。
   * execute/resume 报告的影响对本次调用是累计的，包含挂起之前的影响。
   */
  readonly resume: (
    continuation: VersionedData,
    response: InteractionResponse,
    context: ToolExecutionContext,
  ) => Promise<ToolResult<TOutput> | ToolSuspension>;
}

/** 业务服务由定义的闭包捕获，而非注入上下文。 */
export type ToolDefinition<TInput = unknown, TOutput = unknown> =
  | ImmediateToolDefinition<TInput, TOutput>
  | ResumableToolDefinition<TInput, TOutput>;

/** 注册保留每个定义的输入/输出类型，而无需 unknown 类型的注册表。 */
export interface ToolRegistrar {
  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): Disposable;
}

/** 投影与结果一同持久化；重放不得重新执行工具或其投影。 */
export type ToolCompletion = ToolResult<JsonValue> & {
  readonly modelContent: readonly ModelToolContent[];
  readonly presentation?: VersionedData;
};

export type ToolExecutionResult = ToolCompletion | ToolSuspension;

/**
 * 实现负责异构类型擦除、模式校验以及 JSON 安全的完成投影。
 * 即使取消或投影失败，也必须保留影响。这是执行边界，而非工具授权策略引擎。
 */
export interface ToolExecutor {
  getSchemas(): readonly ModelToolSchema[];
  getVersion(name: string): string | undefined;
  /** 调用 ID 必须与 context.callId 匹配；调度由外部执行策略控制。 */
  execute(call: ModelToolCallContent, context: ToolExecutionContext): Promise<ToolExecutionResult>;
  /** 在调用恢复处理器之前，先解析已保存的调用及其版本绑定的续传数据。 */
  resume(
    call: ModelToolCallContent,
    continuation: VersionedData,
    response: InteractionResponse,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}
