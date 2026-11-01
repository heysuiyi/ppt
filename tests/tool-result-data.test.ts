import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFileService } from "@agent-harness/tools/workspace-files";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { prepareToolResultData } from "../app/main/agent/runtime/tools/tool-result-data";
import { formatReadFileResultForModel } from "../app/main/agent/tools/files/workspace-file-tool-contract";
import type { ToolDefinition } from "../app/main/agent/tools/tool-definition";
import {
  ToolOutputValidationError,
  validateToolOutput,
} from "../app/main/agent/tools/tool-validation";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("tool result data boundary", () => {
  it("keeps rich data locally and persists oversized provider content", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-ppt-tool-result-"));
    temporaryRoots.push(workspaceRoot);
    const data = { rows: [{ id: 1, value: "x".repeat(12_000) }] };

    const prepared = await prepareToolResultData({
      data,
      workspaceRoot,
      threadId: "thread/unsafe",
      toolUseId: "call:1",
      toolName: "ReadSnapshot",
      maxChars: 100,
    });

    expect(prepared.data).toBe(data);
    expect(prepared.truncated).toBe(true);
    expect(prepared.modelContent.length).toBeLessThan(300);
    expect(prepared.persistedPath).toMatch(/^\.task_outputs\/tool-results\//);
    const stored = await readFile(join(workspaceRoot, prepared.persistedPath!), "utf8");
    expect(JSON.parse(stored)).toEqual(data);
    const service = new WorkspaceFileService(workspaceRoot);
    const first = await service.readWindow(prepared.persistedPath!);
    let restored = first.content;
    let current = first;
    while (current.hasMore) {
      current = await service.readWindow(prepared.persistedPath!, {
        offset: current.nextOffset,
        expectedVersion: first.version,
      });
      restored += current.content;
    }
    expect(restored).toBe(stored);
    expect(restored.at(-1)).toBe(stored.at(-1));
  });

  it("injects a completion marker for empty results", async () => {
    const prepared = await prepareToolResultData({
      data: undefined,
      threadId: "thread",
      toolUseId: "call",
      toolName: "Noop",
    });

    expect(prepared.modelContent).toContain("completed successfully");
    expect(prepared.truncated).toBe(false);
  });

  it("keeps a maximum ReadFile window below the generic truncation boundary", async () => {
    const content = "x".repeat(4_000);
    const data = {
      path: "slides/page-plan.json",
      version: `sha256:${"a".repeat(64)}`,
      mtimeMs: 1,
      size: 4_000,
      encoding: "utf8" as const,
      newline: "none" as const,
      startOffset: 0,
      endOffset: 4_000,
      totalCharacters: 8_000,
      hasMore: true,
      nextOffset: 4_000,
      content,
    };
    const prepared = await prepareToolResultData({
      data,
      modelContent: formatReadFileResultForModel(data),
      threadId: "thread",
      toolUseId: "read",
      toolName: "ReadFile",
    });

    expect(prepared.truncated).toBe(false);
    expect(prepared.persistedPath).toBeUndefined();
    expect(prepared.modelContent).toContain(content);
    expect(prepared.modelContent).toContain('"nextOffset":4000');
  });

  it("validates declared output schemas at runtime", () => {
    const tool = {
      name: "TypedTool",
      outputSchema: z.object({ ok: z.literal(true) }),
    } as unknown as ToolDefinition<any, { ok: true }>;

    expect(validateToolOutput(tool, { ok: true })).toEqual({ ok: true });
    expect(() => validateToolOutput(tool, { ok: false })).toThrow(ToolOutputValidationError);
  });
});
