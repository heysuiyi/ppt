import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface AllowedConditionalSkip {
  file: string;
  condition: string;
  count: number;
  reason: string;
}

const TEST_EXTENSIONS = new Set([".ts", ".tsx"]);
const THIS_FILE = "test-source-hygiene.test.ts";

const ALLOWED_CONDITIONAL_SKIPS: AllowedConditionalSkip[] = [
  {
    file: "agent-gateway.integration.test.ts",
    condition: "!OPENAI_AVAILABLE",
    count: 2,
    reason: "Real OpenAI integration tests require an explicitly configured API key and model.",
  },
  {
    file: "agent-gateway.integration.test.ts",
    condition: "!ANTHROPIC_AVAILABLE",
    count: 2,
    reason: "Real Anthropic integration tests require an explicitly configured API key and model.",
  },
  {
    file: "agent-loop.integration.test.ts",
    condition: "!PROVIDER_AVAILABLE",
    count: 1,
    reason:
      "Layer 1 AgentService loop requires a real OpenAI or Anthropic key and model; it is excluded from the default unit run.",
  },
  {
    file: "project-file-editor-safety.test.ts",
    condition: 'process.platform === "win32"',
    count: 1,
    reason: "The symlink safety case requires POSIX-style unprivileged symlink creation.",
  },
];

async function listTypescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return listTypescriptFiles(path);
      if (
        !entry.isFile() ||
        !TEST_EXTENSIONS.has(extname(entry.name)) ||
        entry.name === THIS_FILE
      ) {
        return [];
      }
      return [path];
    }),
  );
  return nested.flat();
}

describe("test source hygiene", () => {
  it("contains no focused or unconditional skipped tests", async () => {
    const testsRoot = resolve("tests");
    const violations: string[] = [];

    for (const filePath of await listTypescriptFiles(testsRoot)) {
      const source = await readFile(filePath, "utf8");
      const file = relative(testsRoot, filePath);
      if (/\b(?:describe|it|test)\s*\.\s*only\b/.test(source)) {
        violations.push(`${file}: focused test`);
      }
      if (/\b(?:describe|it|test)\s*\.\s*skip\s*\(/.test(source)) {
        violations.push(`${file}: unconditional skipped test`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("contains only the documented conditional skips", async () => {
    const testsRoot = resolve("tests");
    const discovered = new Map<string, number>();

    for (const filePath of await listTypescriptFiles(testsRoot)) {
      const source = await readFile(filePath, "utf8");
      const file = relative(testsRoot, filePath).replaceAll("\\", "/");
      for (const match of source.matchAll(/\b(?:describe|it|test)\s*\.\s*skipIf\s*\(([^)]+)\)/g)) {
        const condition = match[1].trim();
        const key = `${file}\0${condition}`;
        discovered.set(key, (discovered.get(key) ?? 0) + 1);
      }
    }

    const expected = new Map(
      ALLOWED_CONDITIONAL_SKIPS.map((entry) => {
        expect(entry.reason.trim()).not.toBe("");
        return [`${entry.file}\0${entry.condition}`, entry.count] as const;
      }),
    );
    expect([...discovered.entries()].sort()).toEqual([...expected.entries()].sort());
  });

  it("does not restore the deprecated OpenAI function entry points", async () => {
    const deprecatedEntryPoints = [
      ["generate", "With", "OpenAI"].join(""),
      ["generate", "Stream", "With", "OpenAI"].join(""),
    ];
    const violations: string[] = [];

    const sourceRoot = resolve("src");
    for (const filePath of await listTypescriptFiles(sourceRoot)) {
      const source = await readFile(filePath, "utf8");
      for (const entryPoint of deprecatedEntryPoints) {
        if (source.includes(entryPoint)) {
          violations.push(`${relative(sourceRoot, filePath)}: ${entryPoint}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
