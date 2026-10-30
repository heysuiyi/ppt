import type { Agent, AgentDefinition } from "./agent-contract";
import type { AgentPlugin } from "./extensions/plugin-contract";
import type { ModelClientFactory, ModelSelection } from "./model/model-contract";
import type { CheckpointStore } from "./session/checkpoint-contract";
import type { SessionHistoryStore } from "./session/session-contract";
import type { ToolExecutor } from "./tools/tool-contract";

export interface AgentCreationOptions {
  readonly agentId: string;
  readonly definition: AgentDefinition;
  readonly model: ModelSelection;
  /** Positive maximum model steps per logical query, including restored committed steps. */
  readonly maxSteps: number;
  readonly plugins: readonly AgentPlugin[];
}

/** Host-supplied implementations; none of these ports expose credentials or business services. */
export interface AgentServices {
  readonly models: ModelClientFactory;
  /** Includes schema validation, host authorization and safe result projection before dispatch settles. */
  readonly tools: ToolExecutor;
  readonly checkpoints: CheckpointStore;
  readonly history: SessionHistoryStore;
}

export interface AgentFactory {
  /**
   * Assemble before publishing the Agent; do not start model or tool execution here.
   * Reject duplicate registrations and roll back acquired resources if setup fails.
   * The returned Agent owns its plugin scopes, not the borrowed host services.
   */
  create(options: AgentCreationOptions, services: AgentServices): Promise<Agent>;
}
