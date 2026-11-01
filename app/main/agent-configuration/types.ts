import type { ModelAdapterId } from "@agent-harness/models/model-contract";
import type {
  AgentExecutionStrategy,
  AgentModelSelection,
  AgentModelSettings,
} from "@shared/agent";
import type { ConfigurationManagement } from "@shared/agent-configuration";
import type {
  AgentGatewayConfig,
  AgentGatewayPreferences,
  AgentSearchConfig,
} from "@shared/agent-gateway-config";
import type { AgentStepLimits } from "@shared/agent-step-limits";

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
