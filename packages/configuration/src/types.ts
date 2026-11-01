import type { ModelAdapterId } from "@agent-harness/models/model-contract";
import type { ConfigurationManagement } from "./configuration-contract.js";
import type {
  AgentGatewayConfig,
  AgentGatewayPreferences,
  AgentSearchConfig,
} from "./gateway-settings.js";
import type {
  AgentExecutionStrategy,
  AgentModelSelection,
  AgentModelSettings,
} from "./model-contract.js";
import type { AgentStepLimits } from "./step-limits.js";

export interface ExecutionPlan {
  modelAdapter?: ModelAdapterId;
  model: AgentModelSelection;
  services: Omit<AgentGatewayPreferences, "fallbackModelId"> & {
    fallbackModel?: AgentModelSelection;
  };
  stepLimits: AgentStepLimits;
  executionStrategy: AgentExecutionStrategy;
  defaultTemplateId: string;
}
export interface ResolvedRunConfiguration {
  modelAdapter?: ModelAdapterId;
  primary: AgentModelSettings;
  gateway: AgentGatewayConfig;
  search: AgentSearchConfig;
}
export interface AgentConfiguration {
  management: ConfigurationManagement;
  runtime: {
    loadExecutionPlan(modelId: string, reasoningEffort?: string): Promise<ExecutionPlan>;
    resolveRuntime(plan: ExecutionPlan): Promise<ResolvedRunConfiguration>;
  };
}
