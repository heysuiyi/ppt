import type { AgentStepLimits } from "@shared/agent-step-limits";
import type { Presentation } from "@shared/presentation";
import type { SkillRegistry } from "../../../agent/skills/loadSkillsDir";
import type { SkillCard } from "../../../agent/skills/skill-types";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";
import type { PptTaskPlan } from "../task/ppt-task-types";
import { buildSystemPromptContext, buildSystemPromptContextSync } from "./prompt-context";
import { type AssembledSystemPrompt, getSystemPrompt } from "./system-prompt-assembler";

export type { SystemPromptContext, SystemPromptContextInput } from "./prompt-context";
export { buildSystemPromptContext, buildSystemPromptContextSync } from "./prompt-context";
export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "./prompt-sections";
export type { PromptStage } from "./prompt-stage";
export { describePromptStage, normalizePromptStage, resolvePromptStage } from "./prompt-stage";
export type { AssembledSystemPrompt } from "./system-prompt-assembler";
export {
  clearSystemPromptCache,
  getSystemPrompt,
  getSystemPromptSections,
  registerSystemPromptSection,
  SystemPromptManager,
} from "./system-prompt-assembler";

export interface SystemPromptOptions {
  request: string;
  presentation: Presentation;
  coreTools: ToolDefinition<any, any>[];
  skillCatalog?: SkillCard[];
  skillRegistry?: SkillRegistry;
  currentSlideId?: string;
  messageHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  requiredOutcome?: "any" | "command_proposal";
  stepLimits?: AgentStepLimits;
  workspaceRoot?: string;
  memories?: string;
  threadId?: string;
  stageHint?: string;
  pptTaskPlan?: PptTaskPlan;
}

/**
 * Runtime system prompt harness. Prompt is assembled from sections, not a single hardcoded string.
 */
export class SystemPromptBuilder {
  static build(options: SystemPromptOptions): string {
    const context = buildSystemPromptContextSync({
      request: options.request,
      presentation: options.presentation,
      coreTools: options.coreTools,
      skillCatalog: options.skillCatalog,
      skillRegistry: options.skillRegistry,
      currentSlideId: options.currentSlideId,
      messageHistory: options.messageHistory,
      requiredOutcome: options.requiredOutcome,
      stepLimits: options.stepLimits,
      memories: options.memories,
      stageHint: options.stageHint,
      pptTaskPlan: options.pptTaskPlan,
    });
    return getSystemPrompt(context, options.threadId).text;
  }

  static async buildAsync(options: SystemPromptOptions): Promise<AssembledSystemPrompt> {
    const context = await buildSystemPromptContext({
      request: options.request,
      presentation: options.presentation,
      coreTools: options.coreTools,
      skillCatalog: options.skillCatalog,
      skillRegistry: options.skillRegistry,
      workspaceRoot: options.workspaceRoot,
      currentSlideId: options.currentSlideId,
      messageHistory: options.messageHistory,
      requiredOutcome: options.requiredOutcome,
      stepLimits: options.stepLimits,
      stageHint: options.stageHint,
      pptTaskPlan: options.pptTaskPlan,
    });
    return getSystemPrompt(context, options.threadId);
  }
}
