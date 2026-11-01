import type { SkillCard, SkillEntry } from "../../../agent/skills/skill-types";
import { resolveSkillTiers } from "../task/ppt-task-composer";
import type { PptTaskPlan } from "../task/ppt-task-types";
import type { PromptStage } from "./prompt-stage";
import { normalizePromptStage } from "./prompt-stage";

export function resolveSkillStages(entry: SkillEntry): PromptStage[] {
  const fromFrontmatter = entry.frontmatter.stages;
  if (!fromFrontmatter || fromFrontmatter.length === 0) return [];
  return fromFrontmatter.flatMap((stage) => {
    try {
      return [normalizePromptStage(stage)];
    } catch {
      return [];
    }
  });
}

export function isSkillRecommendedForStage(
  skillName: string,
  stage: PromptStage,
  entry?: SkillEntry,
): boolean {
  void skillName;
  if (!entry) return false;
  return resolveSkillStages(entry).includes(stage);
}

export type SkillPathTier = "now" | "later" | "none";

export function skillTierFromPlan(plan: PptTaskPlan | undefined, skillName: string): SkillPathTier {
  if (!plan) return "none";
  const tiers = resolveSkillTiers(plan);
  if (tiers.now.includes(skillName)) return "now";
  if (tiers.later.includes(skillName)) return "later";
  return "none";
}

export function rankSkillCatalogForStage(
  cards: SkillCard[],
  stage: PromptStage,
  registry?: { get(name: string): SkillEntry | undefined },
  plan?: PptTaskPlan,
): SkillCard[] {
  return [...cards].sort((left, right) => {
    if (plan) {
      const order = { now: 0, later: 1, none: 2 } as const;
      const leftTier = order[skillTierFromPlan(plan, left.name)];
      const rightTier = order[skillTierFromPlan(plan, right.name)];
      if (leftTier !== rightTier) return leftTier - rightTier;
    }
    const leftRecommended = isSkillRecommendedForStage(left.name, stage, registry?.get(left.name));
    const rightRecommended = isSkillRecommendedForStage(
      right.name,
      stage,
      registry?.get(right.name),
    );
    if (leftRecommended !== rightRecommended) return leftRecommended ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}
