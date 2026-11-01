/**
 * Parses YAML frontmatter from SKILL.md files.
 * Handles common skill frontmatter fields without a full YAML dependency.
 */

function parseScalarValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);

  return trimmed;
}

function parseYamlLikeBlock(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    index += 1;

    if (!line.trim() || line.trim().startsWith("#")) continue;

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) continue;

    const key = keyMatch[1];
    const inlineValue = keyMatch[2];

    if (inlineValue === "|" || inlineValue === ">" || inlineValue === "|-") {
      const folded = inlineValue.startsWith(">");
      const collected: string[] = [];
      while (index < lines.length) {
        const next = lines[index];
        if (/^[A-Za-z0-9_-]+:\s*/.test(next) && !/^\s/.test(next)) break;
        if (/^\s*-\s+/.test(next)) break;
        if (
          next.trim() === "" &&
          index + 1 < lines.length &&
          /^[A-Za-z0-9_-]+:\s*/.test(lines[index + 1])
        ) {
          break;
        }
        collected.push(folded ? next.trim() : next.replace(/^\s{2,4}/, ""));
        index += 1;
      }
      result[key] = folded ? collected.filter(Boolean).join(" ") : collected.join("\n").trimEnd();
      continue;
    }

    if (inlineValue === "" || inlineValue === "|-" || inlineValue === ">-" || inlineValue === ">") {
      if (index < lines.length && /^\s*-\s+/.test(lines[index])) {
        const items: string[] = [];
        while (index < lines.length && /^\s*-\s+/.test(lines[index])) {
          items.push(lines[index].replace(/^\s*-\s+/, "").trim());
          index += 1;
        }
        result[key] = items;
        continue;
      }

      const collected: string[] = [];
      while (index < lines.length) {
        const next = lines[index];
        if (/^[A-Za-z0-9_-]+:\s*/.test(next) && !/^\s/.test(next)) break;
        if (/^\s*-\s+/.test(next)) break;
        collected.push(next.replace(/^\s{2,4}/, ""));
        index += 1;
      }
      result[key] = collected.join("\n").trimEnd();
      continue;
    }

    result[key] = parseScalarValue(inlineValue);
  }

  return result;
}

export interface ParsedSkillDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Split SKILL.md into YAML frontmatter fields and markdown body.
 */
export function parseSkillFrontmatterFields(raw: string): ParsedSkillDocument {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) {
    return { frontmatter: {}, body: raw.trim() };
  }

  return {
    frontmatter: parseYamlLikeBlock(match[1]),
    body: (match[2] ?? "").trim(),
  };
}

export function readFrontmatterString(
  frontmatter: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = frontmatter[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

export function readFrontmatterStringList(
  frontmatter: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = frontmatter[key];
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(/[,\s]+/).filter(Boolean);
  }
  return undefined;
}
