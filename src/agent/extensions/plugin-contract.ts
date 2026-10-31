import type { ModelRegistrar } from "../model/model-contract";
import type { Disposable, RunIdentity } from "../protocol-values";
import type { ToolRegistrar } from "../tools/tool-contract";

export interface PromptContext {
  readonly identity: RunIdentity;
  readonly signal: AbortSignal;
}

export interface PromptContribution {
  readonly id: string;
  /** 在步骤边界调用；业务依赖保留在贡献者的闭包中。 */
  render(context: PromptContext): string | Promise<string>;
}

export interface PromptRegistrar {
  /** 拒绝同一作用域内的重复 ID；释放仅移除该注册。 */
  register(contribution: PromptContribution): Disposable;
}

export interface PluginScope {
  readonly signal: AbortSignal;
  own(resource: Disposable): void;
}

/** 带作用域的注册接口，而非服务定位器或共享的可变业务上下文。 */
export interface PluginContext {
  readonly scope: PluginScope;
  /** 在此进行的注册归该插件作用域所有，在设置失败或释放时被回收。 */
  readonly models: ModelRegistrar;
  readonly tools: ToolRegistrar;
  readonly prompts: PromptRegistrar;
}

export interface AgentPlugin {
  readonly id: string;
  /** 恢复时先检查已安装版本，再解释插件拥有的续传数据。 */
  readonly version: string;
  /** 仅限受信任的进程内组合；外部服务由插件工厂提供。 */
  setup(context: PluginContext): void | Promise<void>;
}
