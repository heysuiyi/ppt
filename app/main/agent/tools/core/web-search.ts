import {
  executeWebSearch,
  formatWebSearchOutput,
  type WebSearchOutput,
  webSearchSchema,
} from "../../search/web-search";
import type { ToolDefinition } from "../tool-definition";

export const webSearchTool: ToolDefinition<typeof webSearchSchema, WebSearchOutput> = {
  name: "WebSearch",
  description:
    "搜索互联网以获取最新或可核验的事实、数据、来源及可选图片候选。" +
    "用户给出网页链接时，可将完整 URL 作为 query 检索该页面，再评价或总结内容。" +
    "引用事实时必须保留来源链接；图片使用前必须核对授权并保留来源。",
  category: "core",
  loadPolicy: "core",
  inputSchema: webSearchSchema,
  behavior: { concurrency: { mode: "parallel" } },
  risk: "low",
  permission: {
    profile: "web-search",
    description: "Send a query to the configured web search provider.",
    scopes: ["main"],
    effects: ["network.access"],
    sandbox: "none",
    approval: "never",
  },
  execute: async (args, context) =>
    executeWebSearch(args, {
      searchConfig: context.searchConfig,
      signal: context.signal,
    }),
  mapResultToModelContent: formatWebSearchOutput,
};
