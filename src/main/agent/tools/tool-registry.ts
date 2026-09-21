import type { ToolContext, ToolDefinition } from "./tool-definition";
import { ToolLoader } from "./tool-loader";

/**
 * 工具注册表与唯一查询入口。
 *
 * 负责注册、按名称获取、列出 Core/Deferred 工具，以及只在 Deferred Tools 中进行模糊或精确搜索。
 * Runtime Tools 可以登记供系统使用，但绝对不能通过模型搜索结果或执行器暴露给外部。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<any, any>>();

  /**
   * 注册单个工具，注册时进行基本安全约束检查
   */
  register(tool: ToolDefinition<any, any>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    // 安全校验：核心工具和延迟工具不允许混淆 category 和 loadPolicy
    if (tool.category === "core" && tool.loadPolicy === "runtime") {
      throw new Error("Core tools cannot have runtime load policy");
    }
    if (
      tool.category === "runtime" &&
      (tool.loadPolicy === "core" || tool.loadPolicy === "deferred")
    ) {
      throw new Error("Runtime-only tools cannot be exposed as core or deferred to the model");
    }
    if (!tool.permission && !tool.risk) {
      throw new Error(
        `Tool ${tool.name} must declare a permission profile or risk classification.`,
      );
    }

    const terminalResult = tool.behavior?.completion?.terminalResult;
    const requiredCapability =
      terminalResult === "command_proposal"
        ? "command_proposal"
        : terminalResult === "ask_user"
          ? "user_interaction"
          : undefined;
    if (requiredCapability && !tool.behavior?.capabilities?.includes(requiredCapability)) {
      throw new Error(
        `Tool ${tool.name} completion '${terminalResult}' requires capability '${requiredCapability}'.`,
      );
    }

    this.tools.set(tool.name, tool);
  }

  /**
   * 获取任意已注册的工具（供系统或 ExecuteExtraTool 使用，ExecuteExtraTool 需做额外权限判定）
   */
  get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  /**
   * 列出所有核心工具
   */
  getCoreTools(context?: ToolContext): ToolDefinition<any, any>[] {
    return ToolLoader.loadCoreTools(Array.from(this.tools.values()))
      .filter((tool) => !context || !tool.isEnabled || tool.isEnabled(context))
      .sort(stableToolOrder);
  }

  /**
   * 获取所有注册的延迟工具
   */
  getDeferredTools(context?: ToolContext): ToolDefinition<any, any>[] {
    return ToolLoader.loadDeferredTools(Array.from(this.tools.values()))
      .filter((tool) => !context || !tool.isEnabled || tool.isEnabled(context))
      .sort(stableToolOrder);
  }

  /**
   * 搜索可发现的延迟工具（Deferred Tools），排除 core、runtime 和 disabled。
   * 支持模糊匹配名称或描述。
   */
  searchDeferredTools(query: string, context?: ToolContext): ToolDefinition<any, any>[] {
    const deferred = this.getDeferredTools(context);
    const trimmed = query.trim();
    if (!trimmed) {
      return deferred;
    }
    if (trimmed.toLowerCase().startsWith("select:")) {
      const names = new Set(
        trimmed
          .slice("select:".length)
          .split(/\s+/)
          .filter(Boolean)
          .map((name) => name.toLowerCase()),
      );
      return deferred.filter((tool) => names.has(tool.name.toLowerCase()));
    }
    const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    return deferred.filter((tool) => {
      const searchable = `${tool.name} ${tool.description}`.toLowerCase();
      return words.some((word) => searchable.includes(word));
    });
  }
}

function stableToolOrder(left: ToolDefinition<any, any>, right: ToolDefinition<any, any>): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}
