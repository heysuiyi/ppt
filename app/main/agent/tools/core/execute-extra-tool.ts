import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolDelegationTarget } from "../tool-definition";
import { parseDefinedToolInput } from "../tool-input";

export const executeExtraToolSchema = z.object({
  toolName: z.string().describe("需要执行的目标延迟工具（Deferred Tool）的名称"),
  toolArgs: z.record(z.string(), z.any()).describe("传递给延迟工具的参数对象"),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run a slow eligible deferred tool in the background; result returns later as task_notification.",
    ),
});

function resolveDeferredTarget(
  args: z.infer<typeof executeExtraToolSchema>,
  context: ToolContext,
): ToolDelegationTarget {
  if (!context.discoverySession.discoveredToolNames.has(args.toolName)) {
    throw new Error(
      `Permission denied: Tool '${args.toolName}' has not been discovered in the current session. ` +
        "You must call SearchExtraTools to discover it first before execution.",
    );
  }

  const tool = context.registry.get(args.toolName);
  if (!tool) {
    throw new Error(`Tool not found: ${args.toolName}`);
  }
  if (tool.category !== "deferred" || tool.loadPolicy !== "deferred") {
    throw new Error(`Tool '${args.toolName}' is not an executable Deferred Tool.`);
  }
  if (tool.isEnabled && !tool.isEnabled(context)) {
    throw new Error(`Tool '${args.toolName}' is unavailable in the current runtime context.`);
  }

  return {
    toolName: tool.name,
    input: {
      ...args.toolArgs,
      ...(args.run_in_background === true ? { run_in_background: true } : {}),
    },
  };
}

/**
 * Core Tool: route an already-discovered Deferred Tool into the Runtime's
 * unified execution pipeline.
 *
 * This definition deliberately never invokes the target's execute function.
 * Permission, Pre/Post hooks, output validation, model mapping and side-effect
 * reporting all belong to the resolved target at the non-bypassable Runtime
 * boundary.
 *
 * 必须拒绝 core、runtime、disabled、未知和未经授权的工具。
 * 调用前必须确认 toolName 存在于当前 thread 的 ToolDiscoverySession.discoveredToolNames；
 * 仅知道或猜中工具名称不构成执行权限，其他会话中的发现记录也无效。
 * 工具输出仍是分析结果或候选 commands，不能借此直接写入真实 PPT。
 */
export const executeExtraToolTool: ToolDefinition<typeof executeExtraToolSchema, any> = {
  name: "ExecuteExtraTool",
  description: "执行此前已发现的延迟工具（Deferred Tool）。",
  category: "core",
  loadPolicy: "core",
  inputSchema: executeExtraToolSchema,
  behavior: {
    delegation: {
      resolve: resolveDeferredTarget,
      allowedCategories: ["deferred"],
      allowedLoadPolicies: ["deferred"],
    },
  },
  risk: "low",
  execute: async (args, context) => {
    const target = resolveDeferredTarget(args, context);
    const tool = context.registry.get(target.toolName);
    if (!tool) throw new Error(`Tool not found: ${target.toolName}`);
    const parsed = parseDefinedToolInput(tool, target.input);
    if (!parsed.success) {
      throw new Error(`Invalid arguments for '${args.toolName}': ${parsed.error.message}`);
    }

    // Direct callers can inspect the routing decision, but only the Runtime may
    // execute it. This keeps the public ToolDefinition safe by construction.
    return {
      toolName: args.toolName,
      risk: tool.risk,
      toolArgs: parsed.data,
      delegated: true,
    };
  },
};
