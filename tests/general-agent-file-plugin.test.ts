import { createHash } from "node:crypto";
import { watch } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installPlugins } from "../src/agent/extensions/plugin-manager";
import { PromptRegistry } from "../src/agent/extensions/prompt-registry";
import type { ModelToolCallContent } from "../src/agent/model/model-contract";
import { ModelRegistry } from "../src/agent/model/model-registry";
import { ResourceScope } from "../src/agent/scope/resource-scope";
import type {
  ToolAuthorizationPolicy,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../src/agent/tools/tool-contract";
import { ToolPipeline } from "../src/agent/tools/tool-pipeline";
import { ToolRegistry } from "../src/agent/tools/tool-registry";
import {
  createWorkspaceReader,
  type WorkspaceReader,
} from "../src/main/agent-host/workspace-read-adapter";
import { createFilePlugin } from "../src/main/plugins/files/file-plugin";
import {
  FileReadError,
  type FileReadPort,
  MAX_FILE_READ_BYTES,
} from "../src/main/plugins/files/file-read-port";

const context: ToolExecutionContext = {
  identity: { agentId: "agent", threadId: "thread", queryId: "query", runId: "run" },
  callId: "read-1",
  signal: new AbortController().signal,
};
const call = (path: string): ModelToolCallContent => ({
  type: "tool-call",
  name: "ReadFile",
  callId: context.callId,
  input: { path },
});
const allow: ToolAuthorizationPolicy = () => ({ type: "allow" });

interface FileFixture {
  readonly directory: string;
  readonly root: string;
  readonly reader: WorkspaceReader;
  install(
    reader?: FileReadPort,
    authorize?: ToolAuthorizationPolicy,
  ): Promise<{
    readonly pipeline: ToolPipeline;
    readonly registry: ToolRegistry;
  }>;
}

async function fixture(body: (files: FileFixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "general-agent-files-"));
  const scope = new ResourceScope();
  try {
    const root = join(directory, "workspace");
    await mkdir(root);
    const reader = await createWorkspaceReader(root);
    await body({
      directory,
      root,
      reader,
      async install(port = reader, authorize = allow) {
        const models = new ModelRegistry();
        const registry = new ToolRegistry();
        const prompts = new PromptRegistry();
        scope.own(models);
        scope.own(registry);
        scope.own(prompts);
        await installPlugins([createFilePlugin(port)], scope, models, registry, prompts);
        return { registry, pipeline: new ToolPipeline(registry, authorize) };
      },
    });
  } finally {
    try {
      await scope.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function expectSafeFailure(
  result: ToolExecutionResult,
  code: string,
  forbidden: readonly string[],
) {
  expect(result).toMatchObject({ status: "failed", effects: "none", error: { code } });
  const diagnostic = JSON.stringify(result);
  for (const value of forbidden) expect(diagnostic).not.toContain(value);
  expect(diagnostic).not.toContain("stack");
}

async function fingerprint(path: string) {
  const bytes = await readFile(path);
  const stats = await lstat(path);
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("read-only general Agent file capability", () => {
  it("projects a real canonical relative UTF-8 snapshot without exposing the host root", async () =>
    fixture(async ({ root, reader, install }) => {
      await mkdir(join(root, "notes"));
      const content = "你好, workspace 👋\r\nsecond line\n";
      await writeFile(join(root, "notes", "hello.txt"), content, "utf8");
      expect(reader.workspaceRoot).toBe(await realpath(root));
      const { pipeline } = await install();
      const result = await pipeline.execute(call("notes/../notes/hello.txt"), context);
      const output = {
        path: "notes/hello.txt",
        version: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
        size: Buffer.byteLength(content, "utf8"),
        content,
      };
      expect(result).toEqual({
        status: "succeeded",
        effects: "none",
        output,
        modelContent: [{ type: "text", text: JSON.stringify(output) }],
      });
      expect(JSON.stringify(result)).not.toContain(root);
      expect(await readFile(join(root, "notes", "hello.txt"), "utf8")).toBe(content);
    }));

  it("reads empty files, a UTF-8 BOM, and exactly 64 KiB but never truncates larger files", async () =>
    fixture(async ({ root, install }) => {
      await writeFile(join(root, "empty.txt"), "");
      await writeFile(join(root, "bom.txt"), "\ufeffhello", "utf8");
      await writeFile(join(root, "limit.txt"), "a".repeat(MAX_FILE_READ_BYTES));
      await writeFile(join(root, "large.txt"), "a".repeat(MAX_FILE_READ_BYTES + 1));
      const { pipeline } = await install();
      expect(await pipeline.execute(call("empty.txt"), context)).toMatchObject({
        status: "succeeded",
        effects: "none",
        output: { size: 0, content: "" },
      });
      expect(await pipeline.execute(call("bom.txt"), context)).toMatchObject({
        status: "succeeded",
        effects: "none",
        output: { size: 8, content: "hello" },
      });
      expect(await pipeline.execute(call("limit.txt"), context)).toMatchObject({
        status: "succeeded",
        effects: "none",
        output: { size: MAX_FILE_READ_BYTES },
      });
      expectSafeFailure(await pipeline.execute(call("large.txt"), context), "FILE_TOO_LARGE", [
        root,
      ]);
    }));

  it("does not invoke the reader before explicit approval and reads current contents only after approval", async () =>
    fixture(async ({ root, reader, install }) => {
      const path = join(root, "approved.txt");
      await writeFile(path, "before approval");
      const read = vi.fn((path: string, signal: AbortSignal) => reader.read(path, signal));
      const interaction = {
        id: "query:read-1:approve",
        owner: "host",
        payload: { type: "host.file-approval", version: 1, data: { path: "approved.txt" } },
      };
      const authorize = vi.fn<ToolAuthorizationPolicy>(() => ({ type: "approval", interaction }));
      const { pipeline } = await install({ read }, authorize);
      const invocation = call("approved.txt");
      const pending = await pipeline.execute(invocation, context);
      expect(pending).toMatchObject({ status: "waiting", effects: "none", interaction });
      expect(read).not.toHaveBeenCalled();
      if (pending.status !== "waiting") throw new Error("Expected approval suspension");
      await writeFile(path, "after approval");
      const result = await pipeline.resume(
        invocation,
        pending.continuation,
        { type: "answer", interactionId: interaction.id, value: true },
        { ...context, identity: { ...context.identity, runId: "resumed-run" } },
      );
      expect(result).toMatchObject({
        status: "succeeded",
        effects: "none",
        output: { content: "after approval" },
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(authorize).toHaveBeenCalledTimes(2);
    }));

  it("cannot read denied, rejected, or no-longer-authorized calls", async () =>
    fixture(async ({ root, reader, install }) => {
      await writeFile(join(root, "private.txt"), "never expose this secret");
      const read = vi.fn((path: string, signal: AbortSignal) => reader.read(path, signal));
      const denied = await install({ read }, () => ({ type: "deny", reason: "Read denied" }));
      expectSafeFailure(
        await denied.pipeline.execute(call("private.txt"), context),
        "tool_denied",
        [root, "never expose this secret"],
      );
      const interaction = {
        id: "query:read-1:approve",
        owner: "host",
        payload: { type: "host.file-approval", version: 1, data: { path: "private.txt" } },
      };
      for (const revoked of [false, true]) {
        let deny = false;
        const { pipeline } = await install({ read }, () =>
          deny ? { type: "deny", reason: "Permission revoked" } : { type: "approval", interaction },
        );
        const invocation = call("private.txt");
        const pending = await pipeline.execute(invocation, context);
        if (pending.status !== "waiting") throw new Error("Expected approval suspension");
        deny = revoked;
        const result = await pipeline.resume(
          invocation,
          pending.continuation,
          { type: "answer", interactionId: interaction.id, value: revoked },
          context,
        );
        expectSafeFailure(result, revoked ? "tool_denied" : "tool_approval_rejected", [
          root,
          "never expose this secret",
        ]);
      }
      expect(read).not.toHaveBeenCalled();
    }));

  it("validates strict input before authorization or filesystem access", async () =>
    fixture(async ({ reader, install }) => {
      const read = vi.fn((path: string, signal: AbortSignal) => reader.read(path, signal));
      const authorize = vi.fn(allow);
      const { pipeline } = await install({ read }, authorize);
      const invalidInputs: ModelToolCallContent["input"][] = [
        {},
        { path: 3 },
        { path: "" },
        { path: "safe.txt", root: "/elsewhere" },
      ];
      for (const input of invalidInputs) {
        expect(await pipeline.execute({ ...call("ignored"), input }, context)).toMatchObject({
          status: "failed",
          effects: "none",
        });
      }
      expect(authorize).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    }));

  it("rejects native and Windows absolute paths, traversal, streams, and missing files without private diagnostics", async () =>
    fixture(async ({ directory, root, install }) => {
      const secret = "outside-file-secret";
      await writeFile(join(directory, "secret.txt"), secret);
      const { pipeline } = await install();
      const paths = [
        [join(directory, "secret.txt"), "INVALID_PATH"],
        ["C:\\private\\secret.txt", "INVALID_PATH"],
        ["C:secret.txt", "INVALID_PATH"],
        ["\\\\server\\share\\secret.txt", "INVALID_PATH"],
        ["/etc/passwd", "INVALID_PATH"],
        ["safe.txt:stream", "INVALID_PATH"],
        ["\u0000secret.txt", "INVALID_PATH"],
        ["../secret.txt", "OUTSIDE_WORKSPACE"],
        ["..\\secret.txt", "OUTSIDE_WORKSPACE"],
        ["missing.txt", "FILE_NOT_FOUND"],
      ];
      for (const [path, code] of paths) {
        expectSafeFailure(await pipeline.execute(call(path), context), code, [
          directory,
          root,
          secret,
        ]);
      }
    }));

  it("rejects invalid UTF-8, NUL/control binary files and directories safely", async () =>
    fixture(async ({ root, install }) => {
      await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
      await writeFile(join(root, "binary.txt"), "private-binary-content\0secret");
      await writeFile(join(root, "control.txt"), "private-control-content\u0001secret");
      await mkdir(join(root, "directory"));
      const { pipeline } = await install();
      for (const [path, code] of [
        ["invalid.txt", "INVALID_UTF8"],
        ["binary.txt", "BINARY_FILE"],
        ["control.txt", "BINARY_FILE"],
        ["directory", "UNSAFE_FILE_TYPE"],
      ]) {
        expectSafeFailure(await pipeline.execute(call(path), context), code, [
          root,
          "private-binary-content",
          "private-control-content",
        ]);
      }
    }));

  it("rejects symlink/junction components even when their target stays inside the workspace", async () =>
    fixture(async ({ directory, root, install }) => {
      const outside = join(directory, "outside");
      const inside = join(root, "inside");
      await mkdir(outside);
      await mkdir(inside);
      await writeFile(join(outside, "secret.txt"), "outside-secret");
      await writeFile(join(inside, "secret.txt"), "inside-linked-secret");
      await symlink(outside, join(root, "outside-link"), "junction");
      await symlink(inside, join(root, "inside-link"), "junction");
      const { pipeline } = await install();
      const escaped = await pipeline.execute(call("outside-link/secret.txt"), context);
      expect(escaped).toMatchObject({ status: "failed", effects: "none" });
      expect(JSON.stringify(escaped)).not.toContain("outside-secret");
      expect(JSON.stringify(escaped)).not.toContain(directory);
      expectSafeFailure(
        await pipeline.execute(call("inside-link/secret.txt"), context),
        "UNSAFE_FILE_TYPE",
        [directory, "inside-linked-secret"],
      );
      await expect(createWorkspaceReader(join(root, "inside-link"))).rejects.toMatchObject({
        code: "INVALID_WORKSPACE",
      });
    }));

  it.skipIf(process.platform === "win32")("rejects a final file symlink", async () =>
    fixture(async ({ root, install }) => {
      await writeFile(join(root, "target.txt"), "linked-secret");
      await symlink(join(root, "target.txt"), join(root, "file-link.txt"));
      const { pipeline } = await install();
      expectSafeFailure(
        await pipeline.execute(call("file-link.txt"), context),
        "UNSAFE_FILE_TYPE",
        [root, "linked-secret"],
      );
    }),
  );

  it("does not create lock files or parents, or recover an interrupted old write", async () =>
    fixture(async ({ root, reader, install }) => {
      const target = join(reader.workspaceRoot, "document.txt");
      await writeFile(target, "committed content");
      const targetKey = createHash("sha256").update(target, "utf8").digest("hex").slice(0, 20);
      const backupName = `${basename(target)}.${targetKey}.atomic-old.test`;
      const backup = join(root, backupName);
      const manifest = join(root, `.${basename(target)}.${targetKey}.atomic-replace.json`);
      await writeFile(backup, "previous private version");
      const manifestContent = JSON.stringify({
        version: 1,
        targetPath: target,
        targetName: basename(target),
        backupName,
        oldFingerprint: await fingerprint(backup),
        newFingerprint: await fingerprint(target),
      });
      await writeFile(manifest, manifestContent);
      const before = (await readdir(root)).sort();
      const events: string[] = [];
      const barrierName = ".watch-barrier";
      const barrier = Promise.withResolvers<void>();
      const watcher = watch(root, (_event, filename) => {
        events.push(String(filename));
        if (String(filename) === barrierName) barrier.resolve();
      });
      watcher.on("error", barrier.reject);
      try {
        const { pipeline } = await install();
        expect(await pipeline.execute(call("document.txt"), context)).toMatchObject({
          status: "succeeded",
          effects: "none",
          output: { content: "committed content" },
        });
        expectSafeFailure(
          await pipeline.execute(call("new-parent/missing.txt"), context),
          "FILE_NOT_FOUND",
          [root],
        );
        // 用真实目录事件排空观察队列，不猜测文件系统通知所需的时间。
        await writeFile(join(root, barrierName), "");
        await barrier.promise;
        expect(events.filter((name) => name !== barrierName)).toEqual([]);
        expect((await readdir(root)).filter((name) => name !== barrierName).sort()).toEqual(before);
        expect(await readFile(manifest, "utf8")).toBe(manifestContent);
        expect(await readFile(backup, "utf8")).toBe("previous private version");
        await expect(lstat(join(root, "new-parent"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        watcher.close();
      }
    }));

  it("rejects invalid roots without creating directories or exposing native errors", async () =>
    fixture(async ({ directory, root }) => {
      const file = join(root, "not-directory");
      await writeFile(file, "plain file");
      for (const path of ["", join(directory, "missing-root"), file]) {
        const result = await createWorkspaceReader(path).catch((error: unknown) => error);
        expect(result).toBeInstanceOf(FileReadError);
        expect(result).toMatchObject({ code: "INVALID_WORKSPACE" });
        expect(String(result)).not.toContain(directory);
      }
      await expect(lstat(join(directory, "missing-root"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }));

  it("sanitizes thrown native errors and validates capability output without claiming mutations", async () =>
    fixture(async ({ root, reader, install }) => {
      const privateDetail = `${root}: secret credentials and native stack`;
      const native = await install({
        async read() {
          throw new Error(privateDetail);
        },
      });
      expectSafeFailure(
        await native.pipeline.execute(call("anything.txt"), context),
        "FILE_READ_FAILED",
        [privateDetail, root],
      );
      await writeFile(join(root, "safe.txt"), "safe");
      const invalid = await install({
        async read(path, signal) {
          return { ...(await reader.read(path, signal)), version: "invalid-private-version" };
        },
      });
      expectSafeFailure(
        await invalid.pipeline.execute(call("safe.txt"), context),
        "tool_output_invalid",
        [root, "invalid-private-version"],
      );
    }));

  it("checks cancellation before and after filesystem I/O without leaking an abort reason", async () =>
    fixture(async ({ root, reader }) => {
      await writeFile(join(root, "safe.txt"), "safe");
      const controller = new AbortController();
      controller.abort(new Error(`${root}: secret cancellation reason`));
      await expect(reader.read("safe.txt", controller.signal)).rejects.toMatchObject({
        code: "FILE_READ_CANCELLED",
        message: "File read was cancelled.",
      });
      const duringRead = new AbortController();
      const pending = reader.read("safe.txt", duringRead.signal);
      duringRead.abort(new Error(`${root}: private in-flight abort reason`));
      await expect(pending).rejects.toMatchObject({
        code: "FILE_READ_CANCELLED",
        message: "File read was cancelled.",
      });
    }));
});
