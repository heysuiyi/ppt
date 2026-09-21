import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createPptToolRegistry } from "@main/plugins/ppt/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AtomicWriteConflictError,
  readJsonFile,
  recoverInterruptedReplacement,
  withAtomicFileTransaction,
  writeTextFileAtomic,
} from "../src/main/agent/persistence/atomic-json-file";
import { ToolPreflight } from "../src/main/agent/runtime/tools/tool-preflight";
import {
  SUB_AGENT_TOOL_HANDLERS,
  type SubAgentToolContext,
  bashTool as subAgentBashTool,
  workspaceFileTools as subAgentWorkspaceFileTools,
} from "../src/main/agent/subagent/workspace-tools";
import { executeExtraToolTool } from "../src/main/agent/tools/core/execute-extra-tool";
import { workspaceFileTools as mainAgentWorkspaceFileTools } from "../src/main/agent/tools/core/workspace-files";
import {
  globWorkspaceFiles,
  WorkspaceFileError,
  WorkspaceFileService,
} from "../src/main/agent/tools/files/workspace-file-service";
import type { ToolContext } from "../src/main/agent/tools/tool-definition";
import type { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

async function createWorkspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ppt-file-service-"));
}

describe("WorkspaceFileService", () => {
  it("returns a receipt and rejects an edit after an external modification", async () => {
    const root = await createWorkspace();
    const path = join(root, "notes.md");
    await writeFile(path, "alpha\n", "utf8");
    const service = new WorkspaceFileService(root);

    const receipt = await service.read("notes.md");
    expect(receipt).toMatchObject({
      path: "notes.md",
      content: "alpha\n",
      size: 6,
      encoding: "utf8",
      newline: "lf",
    });
    expect(receipt.version).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.mtimeMs).toBeGreaterThan(0);

    await writeFile(path, "external change\n", "utf8");
    await expect(
      service.edit("notes.md", "alpha", "beta", { expectedVersion: receipt.version }),
    ).rejects.toMatchObject({ code: "STALE_FILE" });

    const fresh = await service.read("notes.md");
    const edited = await service.edit("notes.md", "external change", "agent change", {
      expectedVersion: fresh.version,
    });
    expect(edited.replacements).toBe(1);
    expect(await readFile(path, "utf8")).toBe("agent change\n");
  });

  it("requires a read receipt before overwriting an existing file", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "existing.txt"), "before", "utf8");
    const service = new WorkspaceFileService(root);

    await expect(service.write("existing.txt", "after")).rejects.toMatchObject({
      code: "READ_REQUIRED",
    });

    const created = await service.write("new.txt", "new");
    expect(created.created).toBe(true);
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new");
  });

  it("pages Unicode text exactly and grants mutation authority only after full coverage", async () => {
    const root = await createWorkspace();
    const prefix = `${"甲".repeat(3_997)}\r\n`;
    const content = `${prefix}😀${"尾".repeat(5_000)}`;
    await writeFile(join(root, "page-plan.json"), content, "utf8");
    const service = new WorkspaceFileService(root);

    const first = await service.readWindow("page-plan.json");
    expect(first).toMatchObject({
      startOffset: 0,
      endOffset: 3_999,
      totalCharacters: content.length,
      hasMore: true,
      nextOffset: 3_999,
    });
    expect(first.content).toBe(prefix);
    await expect(
      service.write("page-plan.json", "blind overwrite", {
        expectedVersion: first.version,
      }),
    ).rejects.toMatchObject({ code: "READ_REQUIRED" });
    await expect(
      service.readWindow("page-plan.json", {
        offset: first.nextOffset,
      }),
    ).rejects.toMatchObject({ code: "INVALID_EXPECTED_VERSION" });

    let combined = first.content;
    let current = first;
    while (current.hasMore) {
      current = await service.readWindow("page-plan.json", {
        offset: current.nextOffset,
        expectedVersion: first.version,
      });
      combined += current.content;
    }

    expect(combined).toBe(content);
    expect(current.endOffset).toBe(content.length);
    const written = await service.write("page-plan.json", content.replace("尾", "终"), {
      expectedVersion: first.version,
    });
    expect(written.created).toBe(false);
  });

  it("does not grant a receipt for internal inspection or a stale page continuation", async () => {
    const root = await createWorkspace();
    const path = join(root, "notes.md");
    await writeFile(path, "a".repeat(5_000), "utf8");
    const service = new WorkspaceFileService(root);

    await service.inspect("notes.md");
    await expect(service.write("notes.md", "after inspect")).rejects.toMatchObject({
      code: "READ_REQUIRED",
    });

    const first = await service.readWindow("notes.md");
    await writeFile(path, "external".repeat(800), "utf8");
    await expect(
      service.readWindow("notes.md", {
        offset: first.nextOffset,
        expectedVersion: first.version,
      }),
    ).rejects.toMatchObject({ code: "STALE_FILE" });
    await expect(service.write("notes.md", "after stale continuation")).rejects.toMatchObject({
      code: "READ_REQUIRED",
    });
  });

  it("preserves existing file permissions across atomic replacement", async () => {
    if (process.platform === "win32") return;
    const root = await createWorkspace();
    const path = join(root, "script.sh");
    await writeFile(path, "#!/bin/sh\necho before\n", "utf8");
    await chmod(path, 0o750);
    const service = new WorkspaceFileService(root);
    const receipt = await service.read("script.sh");

    await service.write("script.sh", "#!/bin/sh\necho after\n", {
      expectedVersion: receipt.version,
    });

    expect((await stat(path)).mode & 0o777).toBe(0o750);
  });

  it("serializes mutations across service instances and rechecks under the lock", async () => {
    const root = await createWorkspace();
    const first = new WorkspaceFileService(root);
    const second = new WorkspaceFileService(root);

    const outcomes = await Promise.allSettled([
      first.write("raced.txt", "first"),
      second.write("raced.txt", "second"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(["first", "second"]).toContain(await readFile(join(root, "raced.txt"), "utf8"));
  });

  it("rejects duplicate matches by default and supports explicit replace_all", async () => {
    const root = await createWorkspace();
    const path = join(root, "duplicate.txt");
    await writeFile(path, "same / same / same", "utf8");
    const service = new WorkspaceFileService(root);
    const receipt = await service.read("duplicate.txt");

    await expect(
      service.edit("duplicate.txt", "same", "changed", { expectedVersion: receipt.version }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_EDIT" });

    const result = await service.edit("duplicate.txt", "same", "changed", {
      expectedVersion: receipt.version,
      replaceAll: true,
    });
    expect(result.replacements).toBe(3);
    expect(await readFile(path, "utf8")).toBe("changed / changed / changed");
  });

  it("rejects lexical escapes and symlinks that resolve outside the workspace", async () => {
    const root = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const outsidePath = join(outsideRoot, "outside.txt");
    await writeFile(outsidePath, "secret", "utf8");
    const service = new WorkspaceFileService(root);

    await expect(service.read("../outside.txt")).rejects.toMatchObject({
      code: "OUTSIDE_WORKSPACE",
    });

    try {
      await symlink(outsidePath, join(root, "escape.txt"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(service.read("escape.txt")).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
  });

  it("rejects invalid UTF-8, invalid Unicode writes, and non-regular files", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await mkdir(join(root, "directory"));
    const service = new WorkspaceFileService(root);

    await expect(service.read("invalid.txt")).rejects.toMatchObject({ code: "INVALID_UTF8" });
    await expect(service.write("surrogate.txt", "\ud800")).rejects.toMatchObject({
      code: "INVALID_UTF8",
    });
    await expect(service.read("directory")).rejects.toMatchObject({ code: "UNSAFE_FILE_TYPE" });

    await writeFile(join(root, "target.txt"), "inside", "utf8");
    try {
      await symlink("target.txt", join(root, "inside-link.txt"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(service.read("inside-link.txt")).rejects.toMatchObject({
      code: "UNSAFE_FILE_TYPE",
    });
  });

  it("rejects a symlink or junction used as the workspace root", async () => {
    const actualRoot = await createWorkspace();
    const linkParent = await createWorkspace();
    const linkedRoot = join(linkParent, "linked-root");
    await writeFile(join(actualRoot, "notes.txt"), "notes", "utf8");
    try {
      await symlink(actualRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    await expect(new WorkspaceFileService(linkedRoot).read("notes.txt")).rejects.toMatchObject({
      code: "UNSAFE_FILE_TYPE",
    });
    await expect(globWorkspaceFiles(linkedRoot, "**/*.txt")).rejects.toMatchObject({
      code: "UNSAFE_FILE_TYPE",
    });
  });

  it("accepts a Windows 8.3 short-path workspace root that realpath may expand", async () => {
    if (process.platform !== "win32") return;

    const { execFileSync } = await import("node:child_process");
    const { mkdir } = await import("node:fs/promises");
    const longRoot = join(
      await createWorkspace(),
      "VeryLongDirectoryNameForEightDotThreeCollision",
    );
    await mkdir(longRoot);
    await writeFile(join(longRoot, "notes.txt"), "short-ok\n", "utf8");

    let shortRoot: string;
    try {
      const escaped = longRoot.replace(/'/g, "''");
      shortRoot = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `$fso = New-Object -ComObject Scripting.FileSystemObject; Write-Output $fso.GetFolder('${escaped}').ShortPath`,
        ],
        { encoding: "utf8", timeout: 10_000 },
      ).trim();
    } catch {
      return;
    }
    if (!shortRoot || shortRoot.toLowerCase() === longRoot.toLowerCase()) return;

    const service = new WorkspaceFileService(shortRoot);
    await expect(service.read("notes.txt")).resolves.toMatchObject({
      path: "notes.txt",
    });
    await expect(globWorkspaceFiles(shortRoot, "*.txt")).resolves.toEqual(["notes.txt"]);
  }, 20_000);

  it("detects a same-content inode replacement after the read receipt", async () => {
    const root = await createWorkspace();
    const path = join(root, "identity.txt");
    const replacement = join(root, "replacement.txt");
    await writeFile(path, "same content", "utf8");
    const service = new WorkspaceFileService(root);
    const receipt = await service.read("identity.txt");

    await writeFile(replacement, "same content", "utf8");
    await unlink(path);
    await rename(replacement, path);

    await expect(
      service.edit("identity.txt", "same", "different", { expectedVersion: receipt.version }),
    ).rejects.toMatchObject({ code: "STALE_FILE" });
  });

  it("does not silently overwrite an external writer at the commit boundary", async () => {
    const root = await createWorkspace();
    const path = join(root, "commit-race.txt");
    await writeFile(path, "original", "utf8");
    const service = new WorkspaceFileService(root);
    const receipt = await service.read("commit-race.txt");
    const operation = service.write("commit-race.txt", "agent payload\n".repeat(1_500_000), {
      expectedVersion: receipt.version,
    });
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );

    await waitForAtomicManifest(root, "commit-race.txt");
    await writeFile(path, "external winner", "utf8");
    await settled;

    expect(await readFile(path, "utf8")).toBe("external winner");
  }, 20_000);

  it("makes an independent service reader wait for an active replacement", async () => {
    const root = await createWorkspace();
    const path = join(root, "leased-read.txt");
    await writeFile(path, "before", "utf8");
    const writer = new WorkspaceFileService(root);
    const reader = new WorkspaceFileService(root);
    const receipt = await writer.read("leased-read.txt");
    const payload = "after\n".repeat(800_000);
    const writeOperation = writer.write("leased-read.txt", payload, {
      expectedVersion: receipt.version,
    });

    await waitForAtomicManifest(root, "leased-read.txt");
    const readOperation = reader.read("leased-read.txt");
    await expect(writeOperation).resolves.toMatchObject({ created: false });
    await expect(readOperation).resolves.toMatchObject({ content: payload });
  }, 20_000);

  it("keeps external content safe when a parent directory is swapped during commit", async () => {
    const root = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const parent = join(root, "safe");
    const parked = join(root, "safe-parked");
    await mkdir(parent);
    await writeFile(join(parent, "file.txt"), "original", "utf8");
    await writeFile(join(outsideRoot, "file.txt"), "outside sentinel", "utf8");
    const service = new WorkspaceFileService(root);
    const receipt = await service.read("safe/file.txt");
    const operation = service.write("safe/file.txt", "agent payload\n".repeat(1_500_000), {
      expectedVersion: receipt.version,
    });
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );

    await waitForAtomicManifest(root, "file.txt");
    try {
      await rename(parent, parked);
      await symlink(outsideRoot, parent, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      await settled;
      if (["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await settled;

    expect(await readFile(join(outsideRoot, "file.txt"), "utf8")).toBe("outside sentinel");
  }, 20_000);

  it("rejects a swapped parent without leaving a target outside the workspace", async () => {
    const root = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const parent = join(root, "safe");
    const parked = join(root, "safe-parked");
    await mkdir(parent);
    await writeFile(join(parent, "file.txt"), "original", "utf8");
    const service = new WorkspaceFileService(root);
    const receipt = await service.read("safe/file.txt");
    const operation = service.write("safe/file.txt", "agent payload\n".repeat(1_500_000), {
      expectedVersion: receipt.version,
    });
    const outcome = operation.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    await waitForAtomicManifest(root, "file.txt");
    try {
      await rename(parent, parked);
      await symlink(outsideRoot, parent, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      await outcome;
      if (["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    const result = await outcome;

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      if (result.error instanceof AtomicWriteConflictError) {
        expect(result.error.sideEffects).toBe("uncertain");
      }
    }
    await expect(lstat(join(outsideRoot, "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("uses the canonical file tools and one shared receipt service for teammates", async () => {
    const root = await createWorkspace();
    const context: SubAgentToolContext = { workspaceRoot: root };
    const writeTool = SUB_AGENT_TOOL_HANDLERS.get("WriteFile")!;
    const readTool = SUB_AGENT_TOOL_HANDLERS.get("ReadFile")!;
    const editTool = SUB_AGENT_TOOL_HANDLERS.get("EditFile")!;

    await writeTool.execute(
      {
        path: "canonical.txt",
        content: "before",
      },
      context,
    );
    const readResult = (await readTool.execute(
      {
        path: "canonical.txt",
      },
      context,
    )) as { content: string; version: string };
    expect(readResult.content).toBe("before");
    expect(readResult.version).toMatch(/^sha256:/);

    const editResult = (await editTool.execute(
      {
        path: "canonical.txt",
        old_string: "before",
        new_string: "after",
      },
      context,
    )) as { replacements: number; version: string };
    expect(editResult.replacements).toBe(1);
    expect(editResult.version).toMatch(/^sha256:/);
    expect(await readFile(join(root, "canonical.txt"), "utf8")).toBe("after");
    expect(SUB_AGENT_TOOL_HANDLERS.has("read_file")).toBe(false);
    expect(SUB_AGENT_TOOL_HANDLERS.has("write_file")).toBe(false);
    expect(SUB_AGENT_TOOL_HANDLERS.has("edit_file")).toBe(false);
    expect(SUB_AGENT_TOOL_HANDLERS.has("glob")).toBe(false);
    expect(SUB_AGENT_TOOL_HANDLERS.has("ensure_dir")).toBe(false);
  });

  it("exposes the exact same workspace file contract to Main and teammates", () => {
    expect(subAgentWorkspaceFileTools.map((tool) => tool.name)).toEqual(
      mainAgentWorkspaceFileTools.map((tool) => tool.name),
    );

    for (const mainTool of mainAgentWorkspaceFileTools) {
      const teammateTool = subAgentWorkspaceFileTools.find((tool) => tool.name === mainTool.name);
      expect(teammateTool).toBeDefined();
      expect(teammateTool?.description).toBe(mainTool.description);
      expect(teammateTool?.inputSchema).toBe(mainTool.inputSchema);
      expect(teammateTool?.outputSchema).toBe(mainTool.outputSchema);
      expect(teammateTool?.permission).toBe(mainTool.permission);
      expect(teammateTool?.mapResultToModelContent).toBe(mainTool.mapResultToModelContent);
    }
  });

  it("returns the canonical truncated Glob result for teammates", async () => {
    const root = await createWorkspace();
    const context: SubAgentToolContext = { workspaceRoot: root };
    await writeFile(join(root, "a.txt"), "a", "utf8");
    await writeFile(join(root, "b.txt"), "b", "utf8");

    const result = await SUB_AGENT_TOOL_HANDLERS.get("Glob")!.execute(
      {
        pattern: "*.txt",
        limit: 1,
      },
      context,
    );

    expect(result).toEqual({
      matches: ["a.txt"],
      totalMatches: 2,
      truncated: true,
    });
  });

  it("matches double-star globs at both the workspace root and nested paths", async () => {
    const root = await createWorkspace();
    await writeFile(join(root, "root.md"), "root", "utf8");
    const service = new WorkspaceFileService(root);
    await service.write("nested/child.md", "child");
    await service.write("nested/ignore.txt", "ignore");

    expect(await globWorkspaceFiles(root, "**/*.md")).toEqual(["nested/child.md", "root.md"]);
  });

  it("does not follow a directory symlink while globbing", async () => {
    const root = await createWorkspace();
    const outsideRoot = await createWorkspace();
    await writeFile(join(root, "visible.txt"), "visible", "utf8");
    await writeFile(join(outsideRoot, "secret-marker.txt"), "secret", "utf8");
    try {
      await symlink(
        outsideRoot,
        join(root, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    expect(await globWorkspaceFiles(root, "**/*.txt")).toEqual(["visible.txt"]);
  });

  it("cleans atomic manifests and displaced backups after a verified write", async () => {
    const root = await createWorkspace();
    const path = join(root, "clean.txt");
    await writeFile(path, "before", "utf8");
    const service = new WorkspaceFileService(root);
    const receipt = await service.read("clean.txt");

    await service.write("clean.txt", "after", { expectedVersion: receipt.version });

    expect(
      (await readdir(root)).filter(
        (name) => name.includes(".atomic-old.") || name.endsWith(".atomic-replace.json"),
      ),
    ).toEqual([]);
  });
});

describe("atomic replacement recovery", () => {
  it("restores a displaced old inode when the manifest proves target is missing", async () => {
    const root = await createWorkspace();
    const targetPath = join(root, "state.json");
    const transaction = await createRecoveryFixture(targetPath, root, "old state", "new state");

    await expect(recoverInterruptedReplacement(targetPath, root)).resolves.toBe(true);
    expect(await readFile(targetPath, "utf8")).toBe("old state");
    await expect(lstat(transaction.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(transaction.manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the original backup when an unknown external target wins", async () => {
    const root = await createWorkspace();
    const targetPath = join(root, "state.json");
    const transaction = await createRecoveryFixture(
      targetPath,
      root,
      "old state",
      "prepared state",
    );
    await writeFile(targetPath, "external winner", "utf8");

    const error = await recoverInterruptedReplacement(targetPath, root).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AtomicWriteConflictError);
    expect(error).toMatchObject({ sideEffects: "uncertain" });
    expect(await readFile(targetPath, "utf8")).toBe("external winner");
    expect(await readFile(transaction.backupPath, "utf8")).toBe("old state");
    expect(await lstat(transaction.manifestPath)).toBeDefined();
  });

  it("makes an interrupted displacement recoverable by the first workspace read", async () => {
    const root = await createWorkspace();
    const targetPath = join(root, "read-recovery.txt");
    const transaction = await createRecoveryFixture(
      targetPath,
      root,
      "recover me",
      "prepared state",
    );
    const service = new WorkspaceFileService(root);

    await expect(service.read("read-recovery.txt")).resolves.toMatchObject({
      path: "read-recovery.txt",
      content: "recover me",
    });
    await expect(lstat(transaction.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(transaction.manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recover or delete a manifest owned by an active transaction", async () => {
    const root = await createWorkspace();
    const targetPath = join(root, "active.json");
    let releaseOwner!: () => void;
    const ownerGate = new Promise<void>((resolveGate) => {
      releaseOwner = resolveGate;
    });
    let ownerReady!: () => void;
    const ready = new Promise<void>((resolveReady) => {
      ownerReady = resolveReady;
    });
    let transaction!: { backupPath: string; manifestPath: string };
    const owner = withAtomicFileTransaction(targetPath, root, async () => {
      transaction = await createRecoveryFixture(
        targetPath,
        root,
        "owned old state",
        "owned new state",
      );
      ownerReady();
      await ownerGate;
    });
    await ready;

    let recoverySettled = false;
    const recovery = recoverInterruptedReplacement(targetPath, root).finally(() => {
      recoverySettled = true;
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 75));
    expect(recoverySettled).toBe(false);
    expect(await readFile(transaction.backupPath, "utf8")).toBe("owned old state");
    expect(await lstat(transaction.manifestPath)).toBeDefined();

    releaseOwner();
    await owner;
    await expect(recovery).resolves.toBe(true);
    expect(await readFile(targetPath, "utf8")).toBe("owned old state");
  });

  it("removes a newly linked outside inode and reports uncertainty before rollback", async () => {
    const root = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const parent = join(root, "safe");
    const parked = join(root, "safe-parked");
    const targetPath = join(parent, "file.txt");
    await mkdir(parent);
    await writeFile(targetPath, "old state", "utf8");
    let pathValidation = 0;

    const error = await writeTextFileAtomic(targetPath, "new state", {
      temporaryDirectory: root,
      commitGuard: {
        expectedTargetExists: true,
        async validatePath() {
          pathValidation += 1;
          if (pathValidation === 3) {
            await rename(parent, parked);
            await symlink(outsideRoot, parent, process.platform === "win32" ? "junction" : "dir");
            return;
          }
          if (pathValidation >= 4) {
            throw new WorkspaceFileError("UNSAFE_FILE_TYPE", "test parent identity changed");
          }
        },
        async validateDisplaced(displacedPath) {
          expect(displacedPath).toBeDefined();
          expect(await readFile(displacedPath!, "utf8")).toBe("old state");
        },
        async validateCommitted() {
          throw new WorkspaceFileError("UNSAFE_FILE_TYPE", "test post-link path validation failed");
        },
      },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AtomicWriteConflictError);
    expect(error).toMatchObject({ sideEffects: "uncertain" });
    await expect(lstat(join(outsideRoot, "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).some((name) => name.includes(".atomic-old."))).toBe(true);
  });

  it("keeps fallback repair under the primary lock so a waiting writer wins last", async () => {
    const root = await createWorkspace();
    const targetPath = join(root, "fallback.json");
    const backupValue = {
      source: "backup",
      padding: "x".repeat(4_000_000),
    };
    await writeFile(targetPath, `{"broken":"${"x".repeat(4_000_000)}`, "utf8");
    await writeFile(`${targetPath}.bak`, JSON.stringify(backupValue), "utf8");

    const reader = readJsonFile<typeof backupValue>(targetPath);
    await waitForAtomicLock(root, "fallback.json");
    const writerValue = { source: "writer" };
    const writer = writeTextFileAtomic(targetPath, JSON.stringify(writerValue));

    await expect(reader).resolves.toEqual(backupValue);
    await expect(writer).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(targetPath, "utf8"))).toEqual(writerValue);
  }, 20_000);

  it("does not treat a non-regular primary as repairable JSON corruption", async () => {
    const root = await createWorkspace();
    const targetPath = join(root, "not-a-file.json");
    await mkdir(targetPath);
    await writeFile(`${targetPath}.bak`, '{"from":"backup"}', "utf8");

    await expect(readJsonFile(targetPath)).rejects.toThrow(/regular files only/);
    expect((await lstat(targetPath)).isDirectory()).toBe(true);
  });
});

describe("sub-agent diagnostic command policy", () => {
  it("rejects shell redirects and arbitrary executables before execution", async () => {
    const root = await createWorkspace();
    const context: SubAgentToolContext = { workspaceRoot: root };

    await expect(
      subAgentBashTool.execute(
        {
          command: "echo escaped > ../outside.txt",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_COMMAND" });
    await expect(
      subAgentBashTool.execute(
        {
          command: "node -e \"require('fs').writeFileSync('../outside.txt','x')\"",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_COMMAND" });
    await expect(
      subAgentBashTool.execute(
        {
          command: "python -c pass",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_COMMAND" });
    await expect(
      subAgentBashTool.execute(
        {
          command: "mkdir generated",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_COMMAND" });
  });

  it("retains internal pwd and read-only node syntax validation", async () => {
    const root = await createWorkspace();
    const context: SubAgentToolContext = { workspaceRoot: root };
    await writeFile(join(root, "valid.js"), "const value = 1;\n", "utf8");
    await writeFile(join(root, "invalid.js"), "const = ;\n", "utf8");

    await expect(subAgentBashTool.execute({ command: "pwd" }, context)).resolves.toBe(
      resolve(root),
    );
    await expect(
      subAgentBashTool.execute(
        {
          command: "node --check valid.js",
        },
        context,
      ),
    ).resolves.toBe("(no output)");
    await expect(
      subAgentBashTool.execute(
        {
          command: "node --check ../outside.js",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_COMMAND" });
    await expect(
      subAgentBashTool.execute(
        {
          command: "node --check invalid.js",
        },
        context,
      ),
    ).rejects.toThrow();
  });

  it("rejects repository-local Git helpers before invoking a diagnostic", async () => {
    const root = await createWorkspace();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git/config"), "[core]\n\tfsmonitor = malicious-helper\n", "utf8");

    await expect(
      subAgentBashTool.execute({ command: "git status --short" }, { workspaceRoot: root }),
    ).rejects.toMatchObject({ code: "UNSAFE_COMMAND" });
  });

  it("rejects conditional includes and per-worktree Git configuration", async () => {
    const includeRoot = await createWorkspace();
    await mkdir(join(includeRoot, ".git"));
    await writeFile(
      join(includeRoot, ".git/config"),
      '[includeIf "gitdir:~/work/"]\n\tpath = ../external-config\n',
      "utf8",
    );
    await expect(
      subAgentBashTool.execute({ command: "git status --short" }, { workspaceRoot: includeRoot }),
    ).rejects.toMatchObject({ code: "UNSAFE_COMMAND" });

    const worktreeRoot = await createWorkspace();
    await mkdir(join(worktreeRoot, ".git"));
    await writeFile(
      join(worktreeRoot, ".git/config"),
      "[core]\n\trepositoryformatversion = 0\n",
      "utf8",
    );
    await writeFile(
      join(worktreeRoot, ".git/config.worktree"),
      "[core]\n\tfsmonitor = malicious-helper\n",
      "utf8",
    );
    await expect(
      subAgentBashTool.execute({ command: "git status --short" }, { workspaceRoot: worktreeRoot }),
    ).rejects.toMatchObject({ code: "UNSAFE_COMMAND" });
  });
});

describe("main-agent workspace file tools", () => {
  it("registers Glob/ReadFile/WriteFile/EditFile and exposes them only with a workspace service", async () => {
    const root = await createWorkspace();
    const registry = createPptToolRegistry();
    const withoutWorkspace = createToolContext(registry);
    const withWorkspace = createToolContext(registry, root, new WorkspaceFileService(root));

    expect(registry.get("ReadFile")).toBeDefined();
    expect(registry.get("Glob")).toBeDefined();
    expect(registry.get("WriteFile")).toBeDefined();
    expect(registry.get("EditFile")).toBeDefined();
    expect(coreNames(registry, withoutWorkspace)).not.toContain("ReadFile");
    expect(coreNames(registry, withWorkspace)).toEqual(
      expect.arrayContaining(["Glob", "ReadFile", "WriteFile", "EditFile"]),
    );
  });

  it("rejects direct execution when the current context lacks a workspace", async () => {
    const registry = createPptToolRegistry();
    const result = await new ToolPreflight(registry).prepare({
      toolCall: {
        type: "tool_use",
        id: "read-without-workspace",
        name: "ReadFile",
        input: { path: "notes.md" },
      },
      context: createToolContext(registry),
      threadId: "thread",
      policyGuidance: async () => undefined,
    });

    expect(result).toMatchObject({
      type: "immediate_result",
      kind: "unavailable",
    });
  });

  it("applies availability to deferred search and ExecuteExtraTool", async () => {
    const root = await createWorkspace();
    const registry = createPptToolRegistry();
    registry.register({
      name: "WorkspaceDeferred",
      description: "workspace-only test capability",
      category: "deferred",
      loadPolicy: "deferred",
      inputSchema: z.object({}),
      isEnabled: (context) => Boolean(context.fileService),
      risk: "low",
      execute: async () => ({ ok: true }),
    });
    const withoutWorkspace = createToolContext(registry);
    const withWorkspace = createToolContext(registry, root, new WorkspaceFileService(root));

    expect(registry.searchDeferredTools("WorkspaceDeferred", withoutWorkspace)).toEqual([]);
    expect(registry.searchDeferredTools("WorkspaceDeferred", withWorkspace)).toHaveLength(1);

    withoutWorkspace.discoverySession.discoveredToolNames.add("WorkspaceDeferred");
    await expect(
      executeExtraToolTool.execute(
        {
          toolName: "WorkspaceDeferred",
          toolArgs: {},
        },
        withoutWorkspace,
      ),
    ).rejects.toThrow(/unavailable/);
  });
});

async function waitForAtomicManifest(root: string, targetName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      (await readdir(root)).some(
        (name) => name.startsWith(`.${targetName}.`) && name.endsWith(".atomic-replace.json"),
      )
    ) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
  throw new Error(`Timed out waiting for the atomic manifest for ${targetName}.`);
}

async function waitForAtomicLock(root: string, targetName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      (await readdir(root)).some(
        (name) => name.startsWith(`.${targetName}.`) && name.endsWith(".atomic-replace.json.lock"),
      )
    ) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
  throw new Error(`Timed out waiting for the atomic lock for ${targetName}.`);
}

async function createRecoveryFixture(
  targetPath: string,
  transactionDirectory: string,
  oldContent: string,
  newContent: string,
): Promise<{ backupPath: string; manifestPath: string }> {
  const { realpathSync } = await import("node:fs");
  const { dirname: dirnamePath } = await import("node:path");
  let canonicalTarget = resolve(targetPath);
  try {
    canonicalTarget = realpathSync.native(canonicalTarget);
  } catch {
    try {
      canonicalTarget = join(
        realpathSync.native(dirnamePath(canonicalTarget)),
        basename(targetPath),
      );
    } catch {
      // Keep resolve() form when the parent cannot be realpath'd.
    }
  }
  const targetKey = createHash("sha256").update(canonicalTarget, "utf8").digest("hex").slice(0, 20);
  const targetName = basename(canonicalTarget);
  const backupName = `${targetName}.${targetKey}.atomic-old.test`;
  const backupPath = join(transactionDirectory, backupName);
  const preparedPath = join(transactionDirectory, `.${targetName}.prepared.tmp`);
  const manifestPath = join(
    transactionDirectory,
    `.${targetName}.${targetKey}.atomic-replace.json`,
  );
  await writeFile(backupPath, oldContent, "utf8");
  await writeFile(preparedPath, newContent, "utf8");
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      targetPath: canonicalTarget,
      targetName,
      backupName,
      oldFingerprint: await testFingerprint(backupPath),
      newFingerprint: await testFingerprint(preparedPath),
    })}\n`,
    "utf8",
  );
  return { backupPath, manifestPath };
}

async function testFingerprint(path: string): Promise<{
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256: string;
}> {
  const [bytes, stats] = await Promise.all([readFile(path), lstat(path)]);
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function createToolContext(
  registry: ToolRegistry,
  workspaceRoot?: string,
  fileService?: WorkspaceFileService,
): ToolContext {
  return {
    presentation: createStarterPresentation(),
    selectedElementIds: [],
    discoverySession: { discoveredToolNames: new Set() },
    registry,
    messageHistory: [],
    workspaceRoot,
    fileService,
  };
}

function coreNames(registry: ToolRegistry, context: ToolContext): string[] {
  return registry.getCoreTools(context).map((tool) => tool.name);
}
