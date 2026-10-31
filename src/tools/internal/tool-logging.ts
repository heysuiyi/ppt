import type { ImmediateToolDefinition } from "@agent-ppt/harness/tools/tool-contract";
import type { Logger } from "../../logs/logs";

/** 只观察获准进入的工具体；不保存输入、路径、正文或模型投影。 */
export function withToolLogging<TInput, TOutput>(
  tool: ImmediateToolDefinition<TInput, TOutput>,
  logger?: Logger,
): ImmediateToolDefinition<TInput, TOutput> {
  if (!logger) return tool;
  return {
    ...tool,
    async execute(input, context) {
      const { agentId, threadId, queryId, runId } = context.identity;
      const log = logger.child({ agentId, threadId, queryId, runId, toolCallId: context.callId });
      const startedAt = performance.now();
      log.debug("tools.execution.started", { toolName: tool.name });
      try {
        const result = await tool.execute(input, context);
        const data = {
          toolName: tool.name,
          status: result.status,
          effects: result.effects,
          durationMs: Math.max(0, performance.now() - startedAt),
          ...(result.status === "succeeded" ? {} : { code: result.error.code }),
        };
        if (result.status === "succeeded") log.info("tools.execution.completed", data);
        else log.warn("tools.execution.completed", data);
        return result;
      } catch (error) {
        // 工具体未返回结果时不推断影响；原异常交回执行边界处理。
        log.error("tools.execution.failed", {
          toolName: tool.name,
          durationMs: Math.max(0, performance.now() - startedAt),
          code: "TOOL_EXECUTION_THROWN",
        });
        throw error;
      }
    },
  };
}
