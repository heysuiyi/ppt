import { z } from "zod";
import type { ToolCard } from "../tool-card";
import { toToolCard } from "../tool-card";
import type { ToolDefinition } from "../tool-definition";

export const searchExtraToolsSchema = z.object({
  query: z.string().describe("搜索词，支持按延迟工具名称或核心功能描述进行搜索"),
});

/**
 * Core Tool: 搜索未默认加载的 Deferred Tools。
 * 仅在 Core Tools 无法完成任务时使用，支持按名称精确选择和按能力关键词查询。
 * 搜索范围排除 core、runtime、disabled 和当前 Context 不可用的工具。
 * 每次实际返回的工具名必须写入当前 thread 的 ToolDiscoverySession。
 */
export const searchExtraToolsTool: ToolDefinition<
  typeof searchExtraToolsSchema,
  { tools: ToolCard[]; baseEditingAvailable: boolean; guidance: string }
> = {
  name: "SearchExtraTools",
  description: "发现并搜索其他未默认加载的延迟工具（Deferred Tools）。",
  category: "core",
  loadPolicy: "core",
  inputSchema: searchExtraToolsSchema,
  behavior: {
    capabilities: ["tool_discovery"],
  },
  risk: "low",
  execute: async (args, context) => {
    const matches: ToolCard[] = context.registry
      .searchDeferredTools(args.query, context)
      .map(toToolCard);
    const proposalTools = context.registry
      .getCoreTools(context)
      .filter((tool) => tool.behavior?.capabilities?.includes("command_proposal"))
      .map((tool) => tool.name);

    for (const match of matches) {
      context.discoverySession.discoveredToolNames.add(match.name);
    }

    const proposalGuidance =
      proposalTools.length > 0
        ? `Core command-proposal capability remains available through: ${proposalTools.join(", ")}.`
        : "No command-proposal capability is currently available; do not claim that Presentation changes were applied.";
    return {
      tools: matches,
      baseEditingAvailable: proposalTools.length > 0,
      guidance:
        matches.length > 0
          ? `Deferred tools are optional enhancements. ${proposalGuidance}`
          : `No matching Deferred Tool was found. ${proposalGuidance}`,
    };
  },
};
