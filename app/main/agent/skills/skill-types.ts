/**
 * Skill catalog and session types for the two-layer LoadSkill design.
 *
 * Layer 1: SkillCard[] injected into system prompt (~100 tokens/skill).
 * Layer 2: full SKILL.md body returned via LoadSkill tool (~2000 tokens/skill, on demand).
 *
 * Frontmatter is advisory metadata only: name/description/when_to_use/stages.
 * Skills do not grant tool permissions or change runtime ACL.
 */

export interface SkillFrontmatter {
  name: string;
  description: string;
  when_to_use?: string;
  /** Advisory prompt stages used only to rank and recommend this skill. */
  stages?: string[];
}

/** Lightweight catalog entry for system prompt injection */
export interface SkillCard {
  name: string;
  description: string;
  whenToUse?: string;
}

/** Full skill record built at harness startup from skills/<name>/SKILL.md */
export interface SkillEntry {
  name: string;
  description: string;
  whenToUse?: string;
  frontmatter: SkillFrontmatter;
  /** Absolute path to the skill subdirectory (internal; not exposed to model) */
  skillDir: string;
  /** Markdown body after YAML frontmatter */
  body: string;
}

/** Per-thread state tracking which skills have been loaded this run */
export interface SkillSession {
  loadedSkillNames: Set<string>;
}

export function createSkillSession(): SkillSession {
  return { loadedSkillNames: new Set<string>() };
}
