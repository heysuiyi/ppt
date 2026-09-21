import type { SkillEntry } from "../../agent/skills/skill-types";
import type { ToolContext } from "../../agent/tools/tool-definition";
import { isSkillRecommendedForStage } from "./prompts/skill-stage-policy";
import { skillRecommendationForPlan } from "./task/ppt-task-composer";

export function pptSkillGuidance(context: ToolContext, entry: SkillEntry): string {
  const stage = context.promptStage ?? "discover";
  const pathTier = skillRecommendationForPlan(context.pptTaskSession?.plan, entry.name);
  const stageRecommended = isSkillRecommendedForStage(entry.name, stage, entry);

  let guidance: string;
  if (pathTier === "now") {
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

  return guidance;
}
