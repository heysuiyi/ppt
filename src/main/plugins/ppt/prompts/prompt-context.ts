import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentStepLimits } from "@shared/agent-step-limits";
import type { Presentation } from "@shared/presentation";
import type { SkillRegistry } from "../../../agent/skills/loadSkillsDir";
import type { SkillCard } from "../../../agent/skills/skill-types";
import { toToolCard } from "../../../agent/tools/tool-card";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";
import { toToolInputSchema } from "../../../agent/tools/tool-schema";
import {
  probeWorkspaceArtifactDetails,
  type WorkspaceArtifactProbeDetails,
  type WorkspaceArtifacts,
} from "../presentation/workspace-artifacts";
import { resolveSkillTiers } from "../task/ppt-task-composer";
import type { PptTaskPlan } from "../task/ppt-task-types";
import { type PromptStage, resolvePromptStage } from "./prompt-stage";

export const MEMORY_INDEX_RELATIVE_PATH = ".memory/MEMORY.md";
export const DURABLE_MEMORY_STATE_RELATIVE_PATH = ".memory/STATE.md";

export interface SystemPromptContextInput {
  request: string;
  presentation: Presentation;
  coreTools: ToolDefinition<any, any>[];
  skillCatalog?: SkillCard[];
  skillRegistry?: SkillRegistry;
  workspaceRoot?: string;
  currentSlideId?: string;
  messageHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  requiredOutcome?: "any" | "command_proposal";
  stepLimits?: AgentStepLimits;
  memories?: string;
  artifacts?: WorkspaceArtifacts;
  artifactDetails?: WorkspaceArtifactProbeDetails;
  stageHint?: string;
  pptTaskPlan?: PptTaskPlan;
}

export interface SystemPromptContext {
  stage: PromptStage;
  artifacts: WorkspaceArtifacts;
  artifactDetails?: WorkspaceArtifactProbeDetails;
  enabledTools: string[];
  workspaceRoot?: string;
  memories: string;
  skillCatalog?: SkillCard[];
  skillRegistry?: SkillRegistry;
  currentSlideId?: string;
  requiredOutcome?: "any" | "command_proposal";
  stepLimits?: AgentStepLimits;
  coreTools: ToolDefinition<any, any>[];
  pptTaskPlan?: PptTaskPlan;
}

async function readMemoryIndex(workspaceRoot?: string): Promise<string> {
  if (!workspaceRoot) return "";

  try {
    const contents = await Promise.all(
      [MEMORY_INDEX_RELATIVE_PATH, DURABLE_MEMORY_STATE_RELATIVE_PATH].map(async (path) => {
        try {
          return (await readFile(join(workspaceRoot, path), "utf8")).trim();
        } catch {
          return "";
        }
      }),
    );
    return contents.filter(Boolean).join("\n\n");
  } catch {
    return "";
  }
}

/**
 * Build prompt assembly context from real runtime state — not message keywords.
 */
export async function buildSystemPromptContext(
  input: SystemPromptContextInput,
): Promise<SystemPromptContext> {
  const [memories, artifactDetails] = await Promise.all([
    input.memories !== undefined
      ? Promise.resolve(input.memories)
      : readMemoryIndex(input.workspaceRoot),
    input.artifactDetails !== undefined
      ? Promise.resolve(input.artifactDetails)
      : probeWorkspaceArtifactDetails(input.workspaceRoot),
  ]);

  const artifacts = input.artifacts ?? {
    designSpec: artifactDetails.designSpec.verified,
    templatePolicy: artifactDetails.templatePolicy.verified,
    templatePack: artifactDetails.templatePack.verified,
    pagePlan: artifactDetails.pagePlan.verified,
    pageSvg: artifactDetails.pageSvg.verified,
    assets: artifactDetails.assets.verified,
    deck: artifactDetails.deck.verified,
    exportHistory: artifactDetails.exportHistory.verified,
    brief: artifactDetails.brief.verified,
    outline: artifactDetails.outline.verified,
    research: artifactDetails.research.verified,
  };

  const stage = resolvePromptStage({
    request: input.request,
    presentation: input.presentation,
    artifacts,
    messageHistory: input.messageHistory,
    stageHint: input.stageHint,
  });

  return {
    stage,
    artifacts,
    artifactDetails,
    enabledTools: input.coreTools.map((tool) => tool.name).sort(),
    workspaceRoot: input.workspaceRoot,
    memories,
    skillCatalog: input.skillCatalog,
    skillRegistry: input.skillRegistry,
    currentSlideId: input.currentSlideId,
    requiredOutcome: input.requiredOutcome,
    stepLimits: input.stepLimits,
    coreTools: input.coreTools,
    pptTaskPlan: input.pptTaskPlan,
  };
}

/** Sync variant for tests; skips filesystem unless artifacts/memories provided. */
export function buildSystemPromptContextSync(input: SystemPromptContextInput): SystemPromptContext {
  const artifacts = input.artifacts ?? {
    designSpec: false,
    templatePolicy: false,
    templatePack: false,
    pagePlan: false,
    pageSvg: false,
    assets: false,
    deck: false,
    exportHistory: false,
    brief: false,
    outline: false,
    research: false,
  };

  const stage = resolvePromptStage({
    request: input.request,
    presentation: input.presentation,
    artifacts,
    messageHistory: input.messageHistory,
    stageHint: input.stageHint,
  });

  return {
    stage,
    artifacts,
    artifactDetails: input.artifactDetails,
    enabledTools: input.coreTools.map((tool) => tool.name).sort(),
    workspaceRoot: input.workspaceRoot,
    memories: input.memories ?? "",
    skillCatalog: input.skillCatalog,
    skillRegistry: input.skillRegistry,
    currentSlideId: input.currentSlideId,
    requiredOutcome: input.requiredOutcome,
    stepLimits: input.stepLimits,
    coreTools: input.coreTools,
    pptTaskPlan: input.pptTaskPlan,
  };
}

export function serializeSystemPromptContextKey(context: SystemPromptContext): string {
  const tools = context.coreTools
    .map((tool) => ({
      card: toToolCard(tool),
      category: tool.category,
      loadPolicy: tool.loadPolicy,
      permission: tool.permission ?? null,
      inputSchema: toToolInputSchema(tool.inputSchema),
      behavior: tool.behavior
        ? {
            capabilities: tool.behavior.capabilities ?? [],
            completion: tool.behavior.completion ?? null,
            background: Boolean(tool.behavior.background),
            delegation: tool.behavior.delegation
              ? {
                  allowedCategories: tool.behavior.delegation.allowedCategories,
                  allowedLoadPolicies: tool.behavior.delegation.allowedLoadPolicies,
                }
              : null,
          }
        : null,
    }))
    .sort((left, right) => left.card.name.localeCompare(right.card.name));
  const skills = (context.skillCatalog ?? [])
    .map((skill) => ({
      ...skill,
      frontmatter: context.skillRegistry?.get(skill.name)?.frontmatter ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return stableStringify({
    stage: context.stage,
    enabledTools: context.enabledTools,
    tools,
    workspaceRoot: context.workspaceRoot ?? null,
    memories: context.memories || null,
    skills,
    currentSlideId: context.currentSlideId ?? null,
    requiredOutcome: context.requiredOutcome ?? "any",
    stepLimits: context.stepLimits ?? null,
    artifacts: context.artifacts,
    artifactDetails: context.artifactDetails ?? null,
    pptTaskPlan: context.pptTaskPlan
      ? {
          revision: context.pptTaskPlan.revision,
          recommendedId: context.pptTaskPlan.recommendedId,
          selectedId: context.pptTaskPlan.selectedId,
          difficulty: context.pptTaskPlan.difficulty,
          skillTiers: resolveSkillTiers(context.pptTaskPlan),
          reason: context.pptTaskPlan.reason,
        }
      : null,
  });
}

function stableStringify(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (!candidate || typeof candidate !== "object") return candidate;
    return Object.fromEntries(
      Object.entries(candidate)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  };
  return JSON.stringify(normalize(value));
}
