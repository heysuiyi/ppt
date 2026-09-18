import { z } from "zod";
import { skillRecommendationForPlan } from "../../runtime/ppt-task/ppt-task-composer";
import { isSkillRecommendedForStage } from "../../runtime/prompts/skill-stage-policy";
import { SUB_AGENT_TOOL_PERMISSION_PROFILES } from "../../runtime/tools/tool-access-policy";
import type { ToolDefinition } from "../tool-definition";

export const loadSkillSchema = z.object({
  skillName: z.string().describe("Registered skill name from the Available Skills catalog"),
});

export interface LoadSkillResult {
  name: string;
  description: string;
  whenToUse?: string;
  content: string;
  alreadyLoaded: boolean;
  guidance: string;
}

/**
 * Core Tool: load full SKILL.md body on demand.
 * Lookup goes through SkillRegistry — never accepts raw file paths.
 */
export const loadSkillTool: ToolDefinition<typeof loadSkillSchema, LoadSkillResult> = {
  name: "LoadSkill",
  description:
    "Load full instructions for any registered skill when its specialized knowledge helps the current task. " +
    "Independent skills may be loaded together in the same assistant response; do not open a new model turn per skill.",
  category: "core",
  loadPolicy: "core",
  inputSchema: loadSkillSchema,
  behavior: {
    capabilities: ["skill_load"],
  },
  risk: "low",
  // Same shared profile as the teammate LoadSkill surface (main + subagent scopes).
  permission: SUB_AGENT_TOOL_PERMISSION_PROFILES.LoadSkill,
  execute: async (args, context) => {
    const registry = context.skillRegistry;
    if (!registry) {
      throw new Error("Skill registry is not available in this runtime.");
    }

    const entry = registry.get(args.skillName);
    if (!entry) {
      const available = registry.listCards().map((card) => card.name);
      throw new Error(
        available.length > 0
          ? `Unknown skill '${args.skillName}'. Registered skills: ${available.join(", ")}`
          : `Unknown skill '${args.skillName}'. No skills are registered.`,
      );
    }

    const stage = context.promptStage ?? "discover";
    const pathTier = skillRecommendationForPlan(context.pptTaskSession?.plan, entry.name);
    const stageRecommended = isSkillRecommendedForStage(entry.name, stage, entry);

    const alreadyLoaded = context.skillSession?.loadedSkillNames.has(entry.name) ?? false;
    context.skillSession?.loadedSkillNames.add(entry.name);

    let guidance: string;
    if (alreadyLoaded) {
      guidance = "Skill already loaded. Follow it; keep tool use minimal.";
    } else if (pathTier === "now") {
      guidance =
        "This skill is marked as needed now on the current task path. Apply only the relevant parts.";
    } else if (pathTier === "later") {
      guidance =
        "This skill is planned later on the current task path. Load now only if new evidence requires it.";
    } else if (stageRecommended) {
      guidance =
        "This skill matches the current context stage. Apply only the parts relevant to the user's task.";
    } else {
      guidance = `This skill is not on the selected task path and is not normally suggested for '${stage}', but it remains available. Apply it only where the current task requires it.`;
    }

    return {
      name: entry.name,
      description: entry.description,
      whenToUse: entry.whenToUse,
      content: entry.body,
      alreadyLoaded,
      guidance,
    };
  },
};
