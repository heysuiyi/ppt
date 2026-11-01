import type {
  DurableRunCheckpoint,
  DurableRunCheckpointV2Payload,
} from "../persistence/durable-run-store";
import type { ToolContext, ToolDefinition } from "../tools/tool-definition";
import type { AgentRunScope } from "./lifecycle/agent-run-scope";
import type { AgentRuntimeOptions } from "./runtime-types";

export interface RuntimeDomainState {
  toolContext: Partial<ToolContext>;
  /** Preserve the existing domain payload without allowing replacement of host checkpoint facts. */
  checkpoint(): Pick<DurableRunCheckpointV2Payload, "baseRevision" | "pptTaskPlan">;
}

/** Trusted, statically assembled domain contribution; not a third-party code sandbox. */
export interface RuntimePlugin {
  readonly id: string;
  validateOptions(options: AgentRuntimeOptions): void;
  createRunState?(
    options: AgentRuntimeOptions,
    recovered?: DurableRunCheckpoint,
  ): RuntimeDomainState;
  promptRevision?(context: ToolContext): string | number | null;
  configureContext(scope: AgentRunScope, context: ToolContext): ToolContext;
  buildPrompt(
    scope: AgentRunScope,
    context: ToolContext,
    tools: ToolDefinition[],
  ): Promise<{ text: string; promptStage?: ToolContext["promptStage"] }>;
  clearSession(threadId: string): void;
}
