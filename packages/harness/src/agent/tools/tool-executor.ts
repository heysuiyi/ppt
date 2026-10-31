import type { ModelToolCallContent, ModelToolSchema } from "../model/model-contract.js";
import type { InteractionResponse, VersionedData } from "../protocol-values.js";
import type { ToolCompletion, ToolExecutionContext, ToolSuspension } from "./tool-contract.js";

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
