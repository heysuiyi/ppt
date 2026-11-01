import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  parseSkillFrontmatterFields,
  readFrontmatterString,
  readFrontmatterStringList,
} from "./parseSkillFrontmatterFields";
import type { SkillCard, SkillEntry, SkillFrontmatter } from "./skill-types";

const SKILL_FILE = "SKILL.md";

function buildFrontmatter(raw: Record<string, unknown>, fallbackName: string): SkillFrontmatter {
  const name = readFrontmatterString(raw, "name") ?? fallbackName;
  const description = readFrontmatterString(raw, "description") ?? "";
  const whenToUse =
    readFrontmatterString(raw, "when_to_use") ?? readFrontmatterString(raw, "when-to-use");

  return {
    name,
    description,
    when_to_use: whenToUse,
    stages: readFrontmatterStringList(raw, "stages"),
  };
}

function toSkillEntry(skillDir: string, dirName: string, rawContent: string): SkillEntry | null {
  const { frontmatter: rawFrontmatter, body } = parseSkillFrontmatterFields(rawContent);
  const frontmatter = buildFrontmatter(rawFrontmatter, dirName);

  if (!frontmatter.description.trim()) {
    return null;
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    whenToUse: frontmatter.when_to_use,
    frontmatter,
    skillDir,
    body,
  };
}

/**
 * Registry of skills scanned at harness startup.
 * Lookup is by skill name only — no path traversal at runtime.
 */
export class SkillRegistry {
  private readonly entries = new Map<string, SkillEntry>();

  register(entry: SkillEntry): void {
    const key = entry.name.toLowerCase();
    if (this.entries.has(key)) {
      throw new Error(`Duplicate skill name: ${entry.name}`);
    }
    this.entries.set(key, entry);
  }

  get(skillName: string): SkillEntry | undefined {
    return this.entries.get(skillName.toLowerCase());
  }

  listCards(): SkillCard[] {
    return [...this.entries.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({
        name: entry.name,
        description: entry.description,
        whenToUse: entry.whenToUse,
      }));
  }

  get size(): number {
    return this.entries.size;
  }
}

export function createEmptySkillRegistry(): SkillRegistry {
  return new SkillRegistry();
}

/**
 * Scan skillsRoot for subdirectories containing SKILL.md and populate the registry.
 */
export async function scanSkills(skillsRoot: string): Promise<SkillRegistry> {
  const registry = createEmptySkillRegistry();

  let dirNames: string[];
  try {
    dirNames = await readdir(skillsRoot);
  } catch {
    return registry;
  }

  for (const dirName of dirNames) {
    const skillDir = join(skillsRoot, dirName);
    try {
      const info = await stat(skillDir);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }

    const skillPath = join(skillDir, SKILL_FILE);
    let rawContent: string;
    try {
      rawContent = await readFile(skillPath, "utf8");
    } catch {
      continue;
    }

    const entry = toSkillEntry(skillDir, dirName, rawContent);
    if (entry) {
      registry.register(entry);
    }
  }

  return registry;
}

/** Synchronous scan for tests and environments that already have file contents. */
export function registerSkillFromContent(
  registry: SkillRegistry,
  skillDir: string,
  dirName: string,
  rawContent: string,
): SkillEntry | null {
  const entry = toSkillEntry(skillDir, dirName, rawContent);
  if (entry) {
    registry.register(entry);
  }
  return entry;
}

/** Build catalog lines for system prompt injection (~100 tokens/skill). */
export function listSkills(registry: SkillRegistry): SkillCard[] {
  return registry.listCards();
}
