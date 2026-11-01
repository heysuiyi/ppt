import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Disposable,
  JsonObject,
  RunIdentity,
  VersionedData,
} from "@agent-harness/core/protocol-values";
import type { RuntimeEvent } from "@agent-harness/core/session/session-events";
import type { ToolResult } from "@agent-harness/core/tools/tool-contract";
import { createTools } from "@agent-harness/tools/tools";
import { describe, expect, it, vi } from "vitest";
import { encodeTerminalRecord } from "../cli/terminal/jsonl-renderer.js";
import type { TerminalToolRecord } from "../cli/terminal/terminal-contract.js";
import {
  projectTerminalEvent,
  sanitizeTerminalRecord,
} from "../cli/terminal/terminal-projection.js";

const identity: RunIdentity = {
  agentId: "agent",
  threadId: "thread",
  queryId: "query",
  runId: "run",
};
const version = `sha256:${"a".repeat(64)}`;
const unsupported = () => ({ support: "unsupported" as const });

function started(
  name: string,
  input: JsonObject,
  toolVersion: string | null = "1",
): Extract<RuntimeEvent, { type: "tool.started" }> {
  return {
    kind: "fact",
    type: "tool.started",
    identity,
    step: 1,
    invocation: {
      identity: { ...identity, runId: "original-run" },
      call: { type: "tool-call", callId: "call", name, input },
      toolVersion,
      state: "dispatched",
    },
  };
}

function completed(
  event: Extract<RuntimeEvent, { type: "tool.started" }>,
  presentation?: VersionedData,
): Extract<RuntimeEvent, { type: "tool.completed" }> {
  return {
    ...event,
    type: "tool.completed",
    completion: {
      status: "succeeded",
      effects: "none",
      output: { private: "PRIVATE_RAW_OUTPUT" },
      modelContent: [{ type: "text", text: "PRIVATE_MODEL_CONTENT" }],
      ...(presentation ? { presentation } : {}),
    },
  };
}

function project(event: RuntimeEvent): TerminalToolRecord {
  const result = projectTerminalEvent(event, unsupported);
  if (result?.type !== "tool") throw new Error("Expected a tool record");
  return result;
}

async function withPresentations(
  body: (
    project: (name: string, result: ToolResult<unknown>) => Promise<VersionedData>,
  ) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "terminal-tool-presentation-"));
  const resources: Disposable[] = [];
  const projectors = new Map<string, (result: ToolResult<unknown>) => Promise<VersionedData>>();
  try {
    const plugin = await createTools({ workspaceRoot: directory, mode: "read-write" });
    await plugin.setup({
      scope: {
        signal: new AbortController().signal,
        own: (resource) => {
          resources.push(resource);
        },
      },
      models: { register: vi.fn() },
      prompts: { register: vi.fn() },
      tools: {
        register(definition) {
          projectors.set(definition.name, async (result) => {
            if (!definition.toPresentation) throw new Error("Missing presentation producer");
            return definition.toPresentation(
              result.status === "succeeded"
                ? { ...result, output: definition.outputSchema.parse(result.output) }
                : result,
            );
          });
          return { dispose: vi.fn() };
        },
      },
    });
    await body(async (name, result) => {
      const projector = projectors.get(name);
      if (!projector) throw new Error(`Missing tool: ${name}`);
      return projector(result);
    });
  } finally {
    for (const resource of resources.reverse()) await resource.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("safe terminal file-tool projection", () => {
  it.each([
    [
      "read",
      { path: "src/a.ts", offset: 4, limit: 100, expectedVersion: version },
      "src/a.ts",
      "offset: 4",
    ],
    ["glob", { pattern: "src/**/*.ts", limit: 30 }, "src/**/*.ts", "limit: 30"],
    [
      "grep",
      { pattern: "needle", glob: "src/**", caseSensitive: false },
      "needle",
      "case-sensitive: false",
    ],
    ["write", { path: "a.ts", mode: "create", content: "PRIVATE_BODY" }, "a.ts", "mode: create"],
    [
      "edit",
      {
        path: "a.ts",
        oldText: "PRIVATE_OLD",
        newText: "PRIVATE_NEW",
        expectedVersion: version,
        replaceAll: true,
      },
      "a.ts",
      "replace-all: true",
    ],
  ] as const)(
    "shows %s targets and safe options before completion",
    (name, input, title, parameter) => {
      const record = project(started(name, { ...input, extra: "PRIVATE_EXTRA" }));
      expect(record.display).toMatchObject({ title, output: [] });
      expect(record.display?.input).toContain(parameter);
      expect(record.invocationIdentity.runId).toBe("original-run");
      expect(JSON.stringify(record)).not.toMatch(/PRIVATE_|sha256/);
    },
  );

  it.each(["custom", "file.read", "Read"])("does not recognize unknown tool %s", (name) => {
    const record = project(
      completed(started(name, { path: "PRIVATE_INPUT" }), {
        type: "tools.read",
        version: 1,
        data: { preview: ["PRIVATE_PRESENTATION"] },
      }),
    );
    expect(record.display).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain("PRIVATE");
  });

  it.each([null, "0", "2"])(
    "does not guess unsupported implementation version %s",
    (toolVersion) => {
      const record = project(completed(started("read", { path: "PRIVATE_INPUT" }, toolVersion)));
      expect(record.display).toBeUndefined();
      expect(JSON.stringify(record)).not.toContain("PRIVATE");
    },
  );

  it.each([
    undefined,
    { type: "unknown", version: 1, data: { preview: ["PRIVATE_PRESENTATION"] } },
    { type: "tools.read", version: 2, data: { preview: ["PRIVATE_PRESENTATION"] } },
    { type: "tools.grep", version: 1, data: { preview: ["PRIVATE_PRESENTATION"] } },
    { type: "tools.read", version: 1, data: { preview: ["PRIVATE_PRESENTATION"] } },
  ])(
    "withholds missing, mismatched or malformed presentations without raw fallback",
    (presentation) => {
      const record = project(completed(started("read", { path: "safe.txt" }), presentation));
      expect(encodeTerminalRecord(record)).not.toContain("PRIVATE");
    },
  );

  it("sanitizes recognized file text and ignores extra presentation fields", () => {
    const record = project(
      completed(started("read", { path: "a.txt" }), {
        type: "tools.read",
        version: 1,
        data: {
          path: "a.txt",
          size: 12,
          startOffset: 0,
          endOffset: 12,
          totalCharacters: 12,
          hasMore: false,
          preview: ["body\u001b]0;injected\u0007\u202e"],
          previewTruncated: false,
          raw: "PRIVATE_RAW",
          replayState: "PRIVATE_REPLAY",
          credentials: "PRIVATE_CREDENTIALS",
        },
      }),
    );
    expect(record.display?.output).toContain("body\\x1b]0;injected\\a\\u202e");
    expect(encodeTerminalRecord(record)).not.toContain("PRIVATE");
  });

  it.each([
    ["./notes.txt", "notes.txt"],
    ["nested\\notes.txt", "nested/notes.txt"],
    ["nested/./notes.txt", "nested/notes.txt"],
    ["nested/../notes.txt", "notes.txt"],
  ])("associates normalized presentation paths for %s", (inputPath, outputPath) => {
    for (const name of ["read", "write", "edit"]) {
      const input = {
        path: inputPath,
        mode: "create",
        content: "BODY_PREVIEW",
        oldText: "OLD_PREVIEW",
        newText: "NEW_PREVIEW",
      };
      const data: JsonObject =
        name === "read"
          ? {
              path: outputPath,
              size: 12,
              startOffset: 0,
              endOffset: 12,
              totalCharacters: 12,
              hasMore: false,
              preview: ["BODY_PREVIEW"],
              previewTruncated: false,
            }
          : name === "write"
            ? { path: outputPath, size: 12, operation: "created" }
            : { path: outputPath, size: 12, replacements: 1 };
      const record = project(
        completed(started(name, input), {
          type: `tools.${name}`,
          version: 1,
          data,
        }),
      );
      expect(record.display?.title).toBe(inputPath);
      expect(record.display?.output).toContain(name === "edit" ? "+ NEW_PREVIEW" : "BODY_PREVIEW");
      const mismatched = project(
        completed(started(name, input), {
          type: `tools.${name}`,
          version: 1,
          data: { ...data, path: "different/notes.txt" },
        }),
      );
      expect(JSON.stringify(mismatched.display?.output)).not.toMatch(
        /BODY_PREVIEW|OLD_PREVIEW|NEW_PREVIEW/,
      );
    }
  });

  it.each(["../notes.txt", "/notes.txt", "C:\\notes.txt"])(
    "does not strip parent or absolute roots while associating %s",
    (inputPath) => {
      const record = project(
        completed(started("read", { path: inputPath }), {
          type: "tools.read",
          version: 1,
          data: {
            path: "notes.txt",
            size: 12,
            startOffset: 0,
            endOffset: 12,
            totalCharacters: 12,
            hasMore: false,
            preview: ["PRIVATE_UNRELATED_FILE"],
            previewTruncated: false,
          },
        }),
      );
      expect(encodeTerminalRecord(record)).not.toContain("PRIVATE");
    },
  );

  it("projects installed producers into file results, body previews and literal replacement diffs", async () => {
    await withPresentations(async (present) => {
      const cases: { name: string; input: JsonObject; output: unknown; expected: string[] }[] = [
        {
          name: "read",
          input: { path: "a.txt" },
          output: {
            path: "a.txt",
            version,
            size: 11,
            content: "hello\nworld",
            startOffset: 0,
            endOffset: 11,
            totalCharacters: 11,
            hasMore: false,
          },
          expected: ["hello", "world"],
        },
        {
          name: "glob",
          input: { pattern: "**/*" },
          output: {
            matches: ["a.txt", "b.txt"],
            truncated: true,
          },
          expected: ["2 files · search incomplete", "a.txt", "b.txt"],
        },
        {
          name: "grep",
          input: { pattern: "needle" },
          output: {
            matches: [{ path: "a.txt", version, line: 3, text: "needle here", truncated: true }],
            skipped: [{ path: "binary", reason: "binary" }],
            truncated: true,
          },
          expected: ["1 matches · 1 skipped · search incomplete", "a.txt:3: needle here …"],
        },
        {
          name: "write",
          input: { path: "a.txt", mode: "create", content: "new\nbody" },
          output: {
            path: "a.txt",
            version,
            size: 8,
            operation: "created",
          },
          expected: ["created · 8 bytes", "new", "body"],
        },
        {
          name: "edit",
          input: {
            path: "a.txt",
            oldText: "old\nbody",
            newText: "new\nbody",
            expectedVersion: version,
          },
          output: {
            path: "a.txt",
            version,
            size: 8,
            replacements: 1,
          },
          expected: ["1 replacements · 8 bytes", "- old", "- body", "+ new", "+ body"],
        },
      ];
      for (const item of cases) {
        const presentation = await present(item.name, {
          status: "succeeded",
          effects: "none",
          output: item.output,
        });
        expect(presentation.type).toBe(`tools.${item.name}`);
        expect(presentation.version).toBe(1);
        const record = project(completed(started(item.name, item.input), presentation));
        expect([...(record.display?.summary ?? []), ...(record.display?.output ?? [])]).toEqual(
          expect.arrayContaining(item.expected),
        );
        expect(encodeTerminalRecord(record)).not.toMatch(
          /PRIVATE_|sha256|modelContent|expectedVersion/,
        );
      }
    });
  });

  it("keeps more than twenty lines and long lines available from installed producers", async () => {
    await withPresentations(async (present) => {
      const content = Array.from({ length: 35 }, (_, index) => `read-${index}`).join("\r\n");
      const read = await present("read", {
        status: "succeeded",
        effects: "none",
        output: {
          path: "a.txt",
          version,
          size: content.length,
          content,
          startOffset: 0,
          endOffset: content.length,
          totalCharacters: content.length + 10,
          hasMore: true,
          nextOffset: content.length,
        },
      });
      const record = project(completed(started("read", { path: "a.txt" }), read));
      expect(record.display?.output).toContain("read-34");
      expect(record.display?.output?.join("\n")).not.toContain("\\r");
      expect(record.display?.summary).toContain("… more file content");
      expect(record.display?.output).not.toContain("… preview truncated");

      for (const name of ["glob", "grep"]) {
        const text = "x".repeat(700);
        const presentation = await present(name, {
          status: "succeeded",
          effects: "none",
          output:
            name === "glob"
              ? {
                  matches: Array.from({ length: 35 }, (_, index) => `${index}-${text}`),
                  truncated: false,
                }
              : {
                  matches: Array.from({ length: 35 }, (_, index) => ({
                    path: "a.txt",
                    version,
                    line: index + 1,
                    text,
                    truncated: false,
                  })),
                  skipped: [],
                  truncated: false,
                },
        });
        const display = project(
          completed(started(name, { pattern: "**/*" }), presentation),
        ).display;
        expect(display?.output?.at(-1)).toContain(text);
        expect(display?.output?.length).toBeGreaterThan(20);
        expect(display?.output).not.toContain("… preview truncated");
        expect(display?.summary?.join("\n")).not.toContain("search incomplete");
      }
    });
  });

  it("bounds oversized producer copies independently from truthful search completeness", async () => {
    await withPresentations(async (present) => {
      for (const name of ["glob", "grep"]) {
        const presentation = await present(name, {
          status: "succeeded",
          effects: "none",
          output:
            name === "glob"
              ? {
                  matches: Array.from(
                    { length: 300 },
                    (_, index) => `${index}-${"界".repeat(3000)}`,
                  ),
                  truncated: false,
                }
              : {
                  matches: Array.from({ length: 300 }, (_, index) => ({
                    path: "a.txt",
                    version,
                    line: index + 1,
                    text: "界".repeat(3000),
                    truncated: false,
                  })),
                  skipped: [],
                  truncated: false,
                },
        });
        const data = presentation.data as {
          matches: (string | { path: string; text: string })[];
          totalMatches: number;
          previewTruncated: boolean;
          truncated: boolean;
        };
        expect(data.totalMatches).toBe(300);
        expect(data.previewTruncated).toBe(true);
        expect(data.truncated).toBe(false);
        const copy = data.matches.flatMap((match) =>
          typeof match === "string" ? [match] : [match.path, match.text],
        );
        expect(copy.every((value) => value.length <= 2000)).toBe(true);
        expect(copy.some((value) => value.endsWith("…"))).toBe(true);
        expect(
          copy.reduce((bytes, value) => bytes + Buffer.byteLength(value, "utf8") + 1, 0),
        ).toBeLessThanOrEqual(128 * 1024);
        const display = project(completed(started(name, { pattern: "*" }), presentation)).display;
        expect(display?.output?.length).toBeLessThanOrEqual(200);
        expect(display?.output).toContain("… preview truncated");
        expect(display?.summary?.join("\n")).not.toContain("search incomplete");
      }
    });
  });

  it("marks the line ceiling without confusing it with incomplete file reads", async () => {
    await withPresentations(async (present) => {
      const content = Array.from({ length: 250 }, (_, index) => `${index}`).join("\n");
      const presentation = await present("read", {
        status: "succeeded",
        effects: "none",
        output: {
          path: "a.txt",
          version,
          size: content.length,
          content,
          startOffset: 0,
          endOffset: content.length,
          totalCharacters: content.length,
          hasMore: false,
        },
      });
      const data = presentation.data as { preview: string[]; previewTruncated: boolean };
      expect(data.preview.length).toBeLessThanOrEqual(200);
      expect(data.preview).toContain("150");
      expect(data.preview).not.toContain("249");
      expect(data.previewTruncated).toBe(true);
      const display = project(completed(started("read", { path: "a.txt" }), presentation)).display;
      expect(display?.output).toContain("… preview truncated");
      expect(display?.summary).not.toContain("… more file content");
    });
  });

  it("keeps Unicode pairs intact at producer and consumer clipping boundaries", async () => {
    await withPresentations(async (present) => {
      const content = `${"x".repeat(1998)}😀tail`;
      const presentation = await present("read", {
        status: "succeeded",
        effects: "none",
        output: {
          path: "a.txt",
          version,
          size: Buffer.byteLength(content, "utf8"),
          content,
          startOffset: 0,
          endOffset: content.length,
          totalCharacters: content.length,
          hasMore: false,
        },
      });
      const data = presentation.data as { preview: string[]; previewTruncated: boolean };
      expect(data.preview[0]).toContain("x".repeat(1000));
      expect(data.preview[0]?.endsWith("…")).toBe(true);
      expect(data.previewTruncated).toBe(true);
      const legacy = project(started("read", { path: "a.txt" }));
      const safe = sanitizeTerminalRecord({
        ...legacy,
        display: {
          title: content,
          input: [],
          output: [content, "legacy\r", "progress\rfinished\u001b\u0007\b\u009b"],
        },
      });
      if (safe.type !== "tool") throw new Error("Expected tool record");
      expect(safe.display?.output).toContain("legacy");
      expect(safe.display?.output).toContain("finished\\x1b\\a\\b\\u009b");
      expect(safe.display).not.toHaveProperty("summary");
      for (const value of [
        data.preview[0]!,
        safe.display?.title ?? "",
        ...(safe.display?.output ?? []),
      ]) {
        expect(value).not.toMatch(
          /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u,
        );
        expect(value).not.toMatch(/[\x00-\x1f\x7f-\x9f]/u);
        expect(value.length).toBeLessThanOrEqual(2000);
      }
      expect(sanitizeTerminalRecord(safe)).toEqual(safe);
    });
  });

  it("retains complete old and new replacement fragments beyond the former eight-line preview", () => {
    const oldText = Array.from({ length: 30 }, (_, index) => `old-${index}`).join("\r\n");
    const newText = Array.from({ length: 30 }, (_, index) => `new-${index}`).join("\r\n");
    const display = project(
      completed(started("edit", { path: "a.txt", oldText, newText, expectedVersion: version }), {
        type: "tools.edit",
        version: 1,
        data: { path: "a.txt", size: 300, replacements: 1 },
      }),
    ).display;
    expect(display?.output).toContain("- old-29");
    expect(display?.output).toContain("+ new-29");
    expect(display?.output).not.toContain("… preview truncated");
    expect(display?.output?.join("\n")).not.toContain("\\r");
    expect(display?.summary?.join("\n")).toContain("replacements");
  });

  it("does not show failure payloads and preserves failed/applied semantics", async () => {
    await withPresentations(async (present) => {
      for (const name of ["read", "glob", "grep", "write", "edit"]) {
        const failure = {
          status: "failed" as const,
          effects: "applied" as const,
          error: { code: "PUBLIC_FAILED", message: "PRIVATE_PRODUCER_DETAIL" },
        };
        const presentation = await present(name, failure);
        expect(presentation.data).toEqual({ status: "failed" });
        expect(JSON.stringify(presentation)).not.toContain("PRIVATE");
      }
    });
    const event = completed(
      started("write", { path: "a.txt", mode: "create", content: "PRIVATE_BODY" }),
    );
    const record = project({
      ...event,
      completion: {
        status: "failed",
        effects: "applied",
        error: { code: "PUBLIC_FAILED", message: "safe\u001b" },
        modelContent: [{ type: "text", text: "PRIVATE_MODEL_CONTENT" }],
        presentation: {
          type: "tools.write",
          version: 1,
          data: { path: "a.txt", size: 12, operation: "created" },
        },
      },
    });
    expect(record).toMatchObject({
      status: "failed",
      effects: "applied",
      error: { message: "safe\\x1b" },
    });
    expect(JSON.stringify(record)).not.toContain("PRIVATE");
  });

  it("rebuilds, sanitizes and bounds legitimate display at the JSONL boundary", () => {
    const record = project(started("read", { path: "a\u001b]0;title\u0007.txt" }));
    const enriched = {
      ...record,
      input: "PRIVATE_RECORD_INPUT",
      output: "PRIVATE_RECORD_OUTPUT",
      display: {
        title: `target\n\t\u001b\u202e${"x".repeat(5000)}`,
        input: ["input\rfinal\b\u009b"],
        summary: ["300 matches\u001b"],
        output: Array.from({ length: 300 }, () => `body\n\u001b${"界".repeat(3000)}`),
        payload: "PRIVATE_DISPLAY_PAYLOAD",
      },
    };
    const safe = sanitizeTerminalRecord(enriched);
    if (safe.type !== "tool") throw new Error("Expected tool record");
    expect(safe.display?.input).toEqual(["final\\b\\u009b"]);
    expect(safe.display?.summary).toEqual(["300 matches\\x1b"]);
    expect(safe.display?.output?.length).toBeLessThanOrEqual(200);
    expect(safe.display?.output).toContain("… preview truncated");
    expect(safe.display?.title.length).toBeLessThanOrEqual(2000);
    const allText = [
      safe.display?.title ?? "",
      ...(safe.display?.input ?? []),
      ...(safe.display?.summary ?? []),
      ...(safe.display?.output ?? []),
    ];
    expect(
      allText.reduce((bytes, value) => bytes + Buffer.byteLength(value, "utf8") + 1, 0),
    ).toBeLessThanOrEqual(128 * 1024);
    for (const value of allText) {
      expect(value.length).toBeLessThanOrEqual(2000);
      expect(value).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/u);
    }
    const jsonl = encodeTerminalRecord(enriched);
    expect(jsonl).not.toContain("PRIVATE");
    expect(JSON.parse(jsonl).display).toEqual(safe.display);
    expect(sanitizeTerminalRecord(safe)).toEqual(safe);
    expect(sanitizeTerminalRecord({ ...enriched, name: "unknown" })).not.toHaveProperty("display");
  });

  it("bounds write/edit bodies independently of raw payload size and ignores mismatched paths", () => {
    const input = { path: "a.txt", mode: "create", content: "long\n".repeat(10000) };
    const presentation = {
      type: "tools.write",
      version: 1,
      data: { path: "a.txt", size: 50000, operation: "created" },
    };
    const record = project(completed(started("write", input), presentation));
    expect(record.display?.output.length).toBeLessThanOrEqual(200);
    expect(record.display?.output).toContain("… preview truncated");
    expect(
      project(
        completed(started("write", input), {
          ...presentation,
          data: {
            path: "another.txt",
            size: 50000,
            operation: "created",
          },
        }),
      ).display?.output?.join("\n"),
    ).not.toContain("long");
    const edit = project(
      completed(
        started("edit", {
          path: "a.txt",
          oldText: "old\n".repeat(10000),
          newText: "new\n".repeat(10000),
        }),
        { type: "tools.edit", version: 1, data: { path: "a.txt", size: 40000, replacements: 1 } },
      ),
    );
    expect(edit.display?.output.length).toBeLessThanOrEqual(200);
    expect(edit.display?.output.filter((line) => line.startsWith("- ")).length).toBeGreaterThan(8);
    expect(edit.display?.output.filter((line) => line.startsWith("+ ")).length).toBeGreaterThan(8);
    expect(edit.display?.output).toContain("… preview truncated");
  });
});
