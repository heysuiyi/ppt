import type { ToolDefinition } from "./tool-definition";

/**
 * 工具加载策略判定器。
 * 负责根据 loadPolicy 规则对注册工具进行分类，生成首轮携带的工具集，或过滤发现工具。
 */
export class ToolLoader {
  /**
   * 根据加载策略过滤出核心工具集（Core Tools）
   * 核心工具在模型请求时默认被携带
   */
  static loadCoreTools(tools: ToolDefinition<any, any>[]): ToolDefinition<any, any>[] {
    return tools.filter((tool) => tool.loadPolicy === "core" && tool.category === "core");
  }

  /**
   * 过滤出延迟加载工具集（Deferred Tools）
   * 延迟工具模型无法初始见到，需要 SearchExtraTools 发现后通过 ExecuteExtraTool 执行
   */
  static loadDeferredTools(tools: ToolDefinition<any, any>[]): ToolDefinition<any, any>[] {
    return tools.filter((tool) => tool.loadPolicy === "deferred" && tool.category === "deferred");
  }
}
