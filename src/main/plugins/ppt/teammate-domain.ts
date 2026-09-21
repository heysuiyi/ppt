import { DESIGN_CAPABILITY_VERSION, LAYOUT_PLANNER_CONTRACT } from "@shared/design-capability";
import type { SkillRegistry } from "../../agent/skills/loadSkillsDir";
import type { TeammateDomainContext } from "../../agent/teammate/teammate-types";
import { isSkillRecommendedForStage, rankSkillCatalogForStage } from "./prompts/skill-stage-policy";
export function createPptTeammateDomain(skills?: SkillRegistry): TeammateDomainContext {
  return {
    instructions: `## SVG-native design assignments (${DESIGN_CAPABILITY_VERSION})
${LAYOUT_PLANNER_CONTRACT}
- Read design/design-spec.json and slides/page-plan.json when present; they are the locked authoring facts.
- For concrete real-world decks with 5+ slides, search at most 3 key slides in the first pass with basic depth and 3–5 candidates each; normally plan 2–4 unique, slide-specific images across the strongest visual moments.
- Prefer free-source discovery (Pexels, Pixabay, Unsplash, Wikimedia Commons), retain source pages, never reuse the same image URL, and never claim licensing that was not verified.
- Embed images in page SVG (or reference localized workspace assets). Do not call removed Grammar/command authoring tools.
- Do not spawn teammates solely to write, preview, or submit SVG — that is the lead authoring loop.

`,
    rankSkills: (cards) => rankSkillCatalogForStage(cards, "discover", skills),
    skillGuidance: (entry) =>
      isSkillRecommendedForStage(entry.name, "discover", entry)
        ? "This skill matches the current context. Apply only the parts relevant to the user's task."
        : "This skill is not normally suggested for 'discover', but it is available. Apply it only where the current task requires it.",
  };
}
