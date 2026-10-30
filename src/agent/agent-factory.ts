import type { Agent, AgentDefinition } from "./agent-contract";
import type { AgentPlugin } from "./extensions/plugin-contract";
import type { ModelClientFactory, ModelSelection } from "./model/model-contract";
import type { CheckpointStore } from "./session/checkpoint-contract";
import type { SessionHistoryStore } from "./session/session-contract";
import type { ToolAuthorizationPolicy } from "./tools/tool-contract";

export interface AgentCreationOptions {
  readonly agentId: string;
  readonly definition: AgentDefinition;
  readonly model: ModelSelection;
  /** 每个逻辑查询的最大模型步数（正数），包含已恢复的已提交步数。 */
  readonly maxSteps: number;
  readonly plugins: readonly AgentPlugin[];
  readonly signal?: AbortSignal;
}

/** 由宿主提供的实现；这些端口均不暴露凭据或业务服务。 */
export interface AgentServices {
  readonly models: ModelClientFactory;
  /** 不可被插件卸载或绕过的宿主派发策略。 */
  readonly authorizeTool: ToolAuthorizationPolicy;
  readonly checkpoints: CheckpointStore;
  readonly history: SessionHistoryStore;
}

export interface AgentFactory {
  /**
   * 在发布 Agent 之前完成组装；此处不得启动模型或工具执行。
   * 拒绝重复注册，若设置失败则回滚已获取的资源。
   * 返回的 Agent 拥有其插件作用域，但不拥有借用的宿主服务。
   */
  create(options: AgentCreationOptions): Promise<Agent>;
}
