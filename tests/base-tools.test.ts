import { createHash } from "node:crypto";
import { watch } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Agent, AgentRunHandle, AgentRunResult } from "@agent-ppt/harness/agent-contract";
import { createAgentApplication } from "@agent-ppt/harness/application/agent-application";
import type { AgentPlugin } from "@agent-ppt/harness/extensions/plugin-contract";
import type {
  ModelClientFactory,
  ModelRequest,
  ModelResponse,
  ModelToolCallContent,
} from "@agent-ppt/harness/model/model-contract";
import type { Disposable, JsonObject } from "@agent-ppt/harness/protocol-values";
import type {
  ToolAuthorizationPolicy,
  ToolCompletion,
} from "@agent-ppt/harness/tools/tool-contract";
import { describe, expect, it, vi } from "vitest";
import { installPlugins } from "../packages/harness/dist/agent/extensions/plugin-manager.js";
import { PromptRegistry } from "../packages/harness/dist/agent/extensions/prompt-registry.js";
import { ModelRegistry } from "../packages/harness/dist/agent/model/model-registry.js";
import { ResourceScope } from "../packages/harness/dist/agent/scope/resource-scope.js";
import type { ToolExecutionResult } from "../packages/harness/dist/agent/tools/tool-executor.js";
import { ToolPipeline } from "../packages/harness/dist/agent/tools/tool-pipeline.js";
import { ToolRegistry } from "../packages/harness/dist/agent/tools/tool-registry.js";
import { createLogs, type Logger, type LogRecord } from "../src/logs/logs";
import { createSqliteAgentStores } from "../src/main/agent-host/sqlite-agent-stores";
import type { EditOutput } from "../src/tools/edit";
import type { GlobOutput } from "../src/tools/glob";
import type { GrepOutput } from "../src/tools/grep";
import type { ReadOutput } from "../src/tools/read";
import { createTools, type ToolsOptions, type ToolsPlugin } from "../src/tools/tools";
import type { WriteOutput } from "../src/tools/write";

const allow: ToolAuthorizationPolicy = () => ({ type: "allow" });
const versionOf = (content: string) =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

interface Observation {
  readonly run: AgentRunResult;
  readonly completions: readonly ToolCompletion[];
}

interface ToolAgent {
  readonly agent: Agent;
  readonly tools: readonly string[];
  start(name: string, input: JsonObject): Promise<AgentRunHandle>;
  invoke(name: string, input: JsonObject): Promise<ToolCompletion>;
}

interface WorkspaceFixture {
  readonly directory: string;
  readonly root: string;
  plugin(
    options?: Partial<Omit<ToolsOptions, "workspaceRoot">>,
    logger?: Logger,
  ): Promise<ToolsPlugin>;
  install(
    plugin: AgentPlugin,
    authorize?: ToolAuthorizationPolicy,
    agentId?: string,
  ): Promise<ToolAgent>;
  pipeline(plugin: AgentPlugin): Promise<ToolPipeline>;
}

async function observe(handle: AgentRunHandle): Promise<Observation> {
  const completions: ToolCompletion[] = [];
  const events = (async () => {
    for await (const event of handle.events) {
      if (event.type === "tool.completed") completions.push(event.completion);
    }
  })();
  const run = await handle.completed;
  await events;
  return { run, completions };
}

async function fixture(body: (workspace: WorkspaceFixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "base-tools-"));
  const resources: Disposable[] = [];
  try {
    const root = join(directory, "workspace");
    await mkdir(root);
    const stores = createSqliteAgentStores(join(directory, "agent.sqlite"));
    resources.push(stores);
    let serial = 0;
    await body({
      directory,
      root,
      plugin: (options = {}, logger) => createTools({ workspaceRoot: root, ...options }, logger),
      async install(plugin, authorize = allow, agentId) {
        const id = agentId ?? `agent-${++serial}`;
        let pending: ModelToolCallContent | undefined;
        let tools: readonly string[] = [];
        const generate = async (
          request: ModelRequest,
          signal: AbortSignal,
        ): Promise<ModelResponse> => {
          signal.throwIfAborted();
          tools = (request.tools ?? []).map((tool) => tool.name).sort();
          const invocation = pending;
          pending = undefined;
          return invocation
            ? { message: { role: "assistant", content: [invocation] }, finishReason: "tool-calls" }
            : {
                message: { role: "assistant", content: [{ type: "text", text: "Finished." }] },
                finishReason: "stop",
              };
        };
        const models: ModelClientFactory = {
          async create(selection) {
            return {
              client: {
                selection,
                capabilities: {
                  streaming: false,
                  toolCalls: true,
                  images: false,
                  reasoning: false,
                },
                generate,
                async *stream(request, signal) {
                  yield { type: "completed", response: await generate(request, signal) };
                },
              },
              async dispose() {},
            };
          },
        };
        const app = createAgentApplication({
          models,
          history: stores.history,
          checkpoints: stores.checkpoints,
          authorizeTool: authorize,
        });
        resources.push(app);
        const agent = await app.agents.create({
          agentId: id,
          definition: {
            id: "plain-text-assistant",
            version: "1",
            instructions: "Use local tools.",
          },
          model: { providerId: "controlled", modelId: "plain-text" },
          maxSteps: 3,
          plugins: [plugin],
        });
        const start = async (name: string, input: JsonObject) => {
          const invocation = ++serial;
          pending = { type: "tool-call", callId: `call-${invocation}`, name, input };
          return agent.run({
            threadId: `thread-${invocation}`,
            queryId: `query-${invocation}`,
            runId: `run-${invocation}`,
            input: [{ role: "user", content: [{ type: "text", text: "Perform this operation." }] }],
          });
        };
        return {
          agent,
          get tools() {
            return tools;
          },
          start,
          async invoke(name, input) {
            const result = await observe(await start(name, input));
            expect(result.run.status).toBe("completed");
            expect(result.completions).toHaveLength(1);
            return result.completions[0];
          },
        };
      },
      async pipeline(plugin) {
        // 取消直接观察真实工具结果，避免 Agent 的取消终态掩盖工具忽略 signal。
        const scope = new ResourceScope();
        resources.push(scope);
        const models = new ModelRegistry();
        const registry = new ToolRegistry();
        const prompts = new PromptRegistry();
        scope.own(models);
        scope.own(registry);
        scope.own(prompts);
        await installPlugins([plugin], scope, models, registry, prompts);
        return new ToolPipeline(registry, allow);
      },
    });
  } finally {
    try {
      for (const resource of resources.reverse()) await resource.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function output<T>(result: ToolExecutionResult, effects: "none" | "applied" = "none"): T {
  expect(result).toMatchObject({ status: "succeeded", effects });
  if (result.status !== "succeeded") throw new Error("Expected successful real tool result");
  return result.output as T;
}

function failure(
  result: ToolExecutionResult,
  code?: string,
  forbidden: readonly string[] = [],
): void {
  expect(result).toMatchObject({ status: "failed", effects: "none" });
  if (code) expect(result).toMatchObject({ error: { code } });
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

describe("base tools through the public Agent application", () => {
  it("uses canonical relative paths, versioned Unicode pages and deterministic model content without a domain plugin", async () =>
    fixture(async ({ root, plugin, install }) => {
      await mkdir(join(root, "notes"));
      const content = "你好👋 café\r\nsecond line\n";
      await writeFile(join(root, "notes", "hello.txt"), content);
      const tools = await plugin({ mode: "read-write" });
      expect(tools.workspaceRoot).toBe(await realpath(root));
      const client = await install(tools);
      const firstResult = await client.invoke("read", {
        path: "notes/../notes/hello.txt",
        limit: 3,
      });
      const first = output<ReadOutput>(firstResult);
      expect(first).toMatchObject({
        path: "notes/hello.txt",
        version: versionOf(content),
        size: Buffer.byteLength(content),
        content: "你好",
        startOffset: 0,
        endOffset: 2,
        hasMore: true,
        nextOffset: 2,
      });
      expect(firstResult.modelContent).toEqual([{ type: "text", text: JSON.stringify(first) }]);
      let page = first;
      let reconstructed = first.content;
      while (page.hasMore) {
        expect(page.nextOffset).toBe(page.endOffset);
        page = output<ReadOutput>(
          await client.invoke("read", {
            path: first.path,
            offset: page.endOffset,
            limit: 2,
            expectedVersion: first.version,
          }),
        );
        expect(page.version).toBe(first.version);
        expect(page.content).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/u);
        reconstructed += page.content;
      }
      expect(reconstructed).toBe(content);
      expect(page.endOffset).toBe(page.totalCharacters);
      expect(page.totalCharacters).toBe(content.length);
      failure(
        await client.invoke("read", {
          path: first.path,
          offset: 3,
          limit: 2,
          expectedVersion: first.version,
        }),
      );
      expect(
        output<ReadOutput>(
          await client.invoke("read", {
            path: first.path,
            offset: content.length,
            expectedVersion: first.version,
          }),
        ),
      ).toMatchObject({ content: "", startOffset: content.length, hasMore: false });
      expect(page.nextOffset).toBeUndefined();
      expect(JSON.stringify(firstResult)).not.toContain(root);
      expect(client.tools).toEqual(["edit", "glob", "grep", "read", "write"]);
      const edited = output<EditOutput>(
        await client.invoke("edit", {
          path: first.path,
          expectedVersion: first.version,
          oldText: "second line",
          newText: "plain text, no presentation required",
        }),
        "applied",
      );
      expect(edited.replacements).toBe(1);
      expect(await readFile(join(root, first.path), "utf8")).toContain("no presentation required");
    }));

  it("does not let partial, out-of-order gaps, glob or grep authorize a mutation", async () =>
    fixture(async ({ root, plugin, install }) => {
      const content = "abcdef";
      await writeFile(join(root, "document.txt"), content);
      const client = await install(await plugin({ mode: "read-write" }));
      const first = output<ReadOutput>(
        await client.invoke("read", { path: "document.txt", limit: 2 }),
      );
      const deniedEdit = () =>
        client.invoke("edit", {
          path: "document.txt",
          oldText: "abc",
          newText: "XYZ",
          expectedVersion: first.version,
        });
      failure(await deniedEdit(), "READ_REQUIRED");
      output<ReadOutput>(
        await client.invoke("read", {
          path: "document.txt",
          offset: 4,
          limit: 2,
          expectedVersion: first.version,
        }),
      );
      failure(await deniedEdit(), "READ_REQUIRED");
      expect(
        output<GlobOutput>(await client.invoke("glob", { pattern: "**/*.txt" })).matches,
      ).toEqual(["document.txt"]);
      expect(
        output<GrepOutput>(await client.invoke("grep", { pattern: "abc" })).matches,
      ).toMatchObject([{ path: "document.txt", version: first.version }]);
      failure(await deniedEdit(), "READ_REQUIRED");
      output<ReadOutput>(
        await client.invoke("read", {
          path: "./document.txt",
          offset: 2,
          limit: 2,
          expectedVersion: first.version,
        }),
      );
      output<EditOutput>(await deniedEdit(), "applied");
      expect(await readFile(join(root, "document.txt"), "utf8")).toBe("XYZdef");
      const searchOnly = await install(await plugin({ mode: "read-write" }));
      output<GrepOutput>(await searchOnly.invoke("grep", { pattern: "XYZ" }));
      failure(
        await searchOnly.invoke("write", {
          path: "document.txt",
          mode: "replace",
          content: "forbidden",
          expectedVersion: versionOf("XYZdef"),
        }),
        "READ_REQUIRED",
      );
    }));

  it("never combines page receipts from different versions", async () =>
    fixture(async ({ root, plugin, install }) => {
      await writeFile(join(root, "document.txt"), "abcdef");
      const client = await install(await plugin({ mode: "read-write" }));
      const first = output<ReadOutput>(
        await client.invoke("read", { path: "document.txt", limit: 2 }),
      );
      await writeFile(join(root, "document.txt"), "ABCDEF");
      failure(
        await client.invoke("read", {
          path: "document.txt",
          offset: 2,
          limit: 4,
          expectedVersion: first.version,
        }),
      );
      const fresh = output<ReadOutput>(
        await client.invoke("read", { path: "document.txt", limit: 2 }),
      );
      output<ReadOutput>(
        await client.invoke("read", {
          path: "document.txt",
          offset: 4,
          limit: 2,
          expectedVersion: fresh.version,
        }),
      );
      failure(
        await client.invoke("write", {
          path: "document.txt",
          mode: "replace",
          content: "not fully read",
          expectedVersion: fresh.version,
        }),
        "READ_REQUIRED",
      );
      expect(await readFile(join(root, "document.txt"), "utf8")).toBe("ABCDEF");
    }));

  it("creates explicitly, refuses overwrite, replaces only observed versions and edits unambiguously", async () =>
    fixture(async ({ root, plugin, install }) => {
      const client = await install(await plugin({ mode: "read-write" }));
      const created = output<WriteOutput>(
        await client.invoke("write", {
          path: "nested/document.txt",
          mode: "create",
          content: "one one\n",
        }),
        "applied",
      );
      expect(created).toMatchObject({
        path: "nested/document.txt",
        operation: "created",
        version: versionOf("one one\n"),
      });
      expect(await readFile(join(root, "nested/document.txt"), "utf8")).toBe("one one\n");
      failure(
        await client.invoke("write", {
          path: "nested/document.txt",
          mode: "create",
          content: "must not overwrite",
        }),
      );
      const read = output<ReadOutput>(await client.invoke("read", { path: created.path }));
      failure(
        await client.invoke("edit", {
          path: read.path,
          oldText: "one",
          newText: "two",
          expectedVersion: read.version,
        }),
      );
      expect(await readFile(join(root, read.path), "utf8")).toBe("one one\n");
      failure(
        await client.invoke("edit", {
          path: read.path,
          oldText: "absent",
          newText: "two",
          expectedVersion: read.version,
        }),
      );
      const edited = output<EditOutput>(
        await client.invoke("edit", {
          path: read.path,
          oldText: "one",
          newText: "two",
          expectedVersion: read.version,
          replaceAll: true,
        }),
        "applied",
      );
      expect(edited).toMatchObject({ replacements: 2, version: versionOf("two two\n") });
      failure(
        await client.invoke("write", {
          path: read.path,
          mode: "replace",
          content: "stale",
          expectedVersion: read.version,
        }),
      );
      const latest = output<ReadOutput>(await client.invoke("read", { path: read.path }));
      const replaced = output<WriteOutput>(
        await client.invoke("write", {
          path: latest.path,
          mode: "replace",
          content: "final",
          expectedVersion: latest.version,
        }),
        "applied",
      );
      expect(replaced.operation).toBe("replaced");
      failure(
        await client.invoke("write", {
          path: "missing.txt",
          mode: "replace",
          content: "no implicit create",
          expectedVersion: replaced.version,
        }),
      );
      await expect(lstat(join(root, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, read.path), "utf8")).toBe("final");
    }));

  it("keeps observations separate when the exact same plugin is installed in two Agents", async () =>
    fixture(async ({ root, plugin, install }) => {
      await writeFile(join(root, "shared.txt"), "original");
      const shared = await plugin({ mode: "read-write" });
      const first = await install(shared);
      const second = await install(shared);
      const read = output<ReadOutput>(await first.invoke("read", { path: "shared.txt" }));
      failure(
        await second.invoke("edit", {
          path: read.path,
          oldText: "original",
          newText: "stolen receipt",
          expectedVersion: read.version,
        }),
        "READ_REQUIRED",
      );
      output<ReadOutput>(await second.invoke("read", { path: read.path }));
      await first.agent.dispose();
      output<EditOutput>(
        await second.invoke("edit", {
          path: read.path,
          oldText: "original",
          newText: "second installation",
          expectedVersion: read.version,
        }),
        "applied",
      );
      expect(await readFile(join(root, read.path), "utf8")).toBe("second installation");
      const separate = await install(await plugin({ mode: "read-write" }));
      failure(
        await separate.invoke("write", {
          path: read.path,
          mode: "replace",
          content: "new plugin has no receipt",
          expectedVersion: versionOf("second installation"),
        }),
        "READ_REQUIRED",
      );
    }));

  it("fails closed when a persisted approved mutation resumes after losing in-memory read receipts", async () =>
    fixture(async ({ root, plugin, install }) => {
      await writeFile(join(root, "persistent.txt"), "persisted file");
      const shared = await plugin({ mode: "read-write" });
      const interaction = {
        id: "restart-write-approval",
        owner: "host",
        payload: {
          type: "host.workspace-tool",
          version: 1,
          data: { tool: "write", path: "persistent.txt", workspaceId: "test" },
        },
      };
      const original = await install(
        shared,
        (call) => (call.name === "write" ? { type: "approval", interaction } : { type: "allow" }),
        "restart-agent",
      );
      const read = output<ReadOutput>(await original.invoke("read", { path: "persistent.txt" }));
      const waiting = await observe(
        await original.start("write", {
          path: read.path,
          mode: "replace",
          content: "untrusted receipt",
          expectedVersion: read.version,
        }),
      );
      expect(waiting.run.status).toBe("waiting");
      await original.agent.dispose();
      const restarted = await install(shared, allow, "restart-agent");
      const resumed = await observe(
        await restarted.agent.resume({
          threadId: waiting.run.identity.threadId,
          queryId: waiting.run.identity.queryId,
          runId: "resumed-after-restart",
          response: { type: "answer", interactionId: interaction.id, value: true },
        }),
      );
      expect(resumed.run.status).toBe("completed");
      expect(resumed.completions).toHaveLength(1);
      failure(resumed.completions[0], "READ_REQUIRED");
      expect(await readFile(join(root, read.path), "utf8")).toBe("persisted file");
      output<ReadOutput>(await restarted.invoke("read", { path: read.path }));
      output<WriteOutput>(
        await restarted.invoke("write", {
          path: read.path,
          mode: "replace",
          content: "reread then replace",
          expectedVersion: read.version,
        }),
        "applied",
      );
      expect(await readFile(join(root, read.path), "utf8")).toBe("reread then replace");
    }));

  it("rejects changes to observed file identity, including a same-content replacement", async () =>
    fixture(async ({ root, plugin, install }) => {
      const target = join(root, "identity.txt");
      await writeFile(target, "unchanged bytes");
      const client = await install(await plugin({ mode: "read-write" }));
      const read = output<ReadOutput>(await client.invoke("read", { path: "identity.txt" }));
      await writeFile(join(root, "replacement.txt"), "unchanged bytes");
      await rename(target, join(root, "old.txt"));
      await rename(join(root, "replacement.txt"), target);
      failure(
        await client.invoke("edit", {
          path: read.path,
          oldText: "unchanged",
          newText: "unsafe",
          expectedVersion: read.version,
        }),
      );
      expect(await readFile(target, "utf8")).toBe("unchanged bytes");
    }));

  it("checks external changes made during host authorization and permits only one concurrent replacement", async () =>
    fixture(async ({ root, plugin, install }) => {
      const target = join(root, "race.txt");
      await writeFile(target, "original");
      let change = false;
      const guarded = await install(await plugin({ mode: "read-write" }), async (call) => {
        if (change && call.name === "write") await writeFile(target, "external edit");
        return { type: "allow" };
      });
      const read = output<ReadOutput>(await guarded.invoke("read", { path: "race.txt" }));
      change = true;
      failure(
        await guarded.invoke("write", {
          path: read.path,
          mode: "replace",
          content: "lost update",
          expectedVersion: read.version,
        }),
      );
      expect(await readFile(target, "utf8")).toBe("external edit");
      const shared = await plugin({ mode: "read-write" });
      const first = await install(shared);
      const second = await install(shared);
      const observed = output<ReadOutput>(await first.invoke("read", { path: "race.txt" }));
      output<ReadOutput>(await second.invoke("read", { path: "race.txt" }));
      const results = await Promise.all(
        [first, second].map((client, index) =>
          client.invoke("write", {
            path: observed.path,
            mode: "replace",
            content: `winner-${index}`,
            expectedVersion: observed.version,
          }),
        ),
      );
      expect(results.filter((result) => result.status === "succeeded")).toHaveLength(1);
      expect(results.filter((result) => result.status === "failed")).toHaveLength(1);
      expect(await readFile(target, "utf8")).toMatch(/^winner-[01]$/);
    }));
});

describe("base tool authorization and filesystem boundaries", () => {
  it("omits mutators by default and denies host calls before observation or directory creation", async () =>
    fixture(async ({ root, plugin, install }) => {
      const secret = "private checksum 81ac703d";
      await writeFile(join(root, "private.txt"), secret);
      const readonly = await install(await plugin());
      output<GlobOutput>(await readonly.invoke("glob", { pattern: "*" }));
      expect(readonly.tools).toEqual(["glob", "grep", "read"]);
      for (const name of ["write", "edit"]) {
        failure(
          await readonly.invoke(name, {
            path: "private.txt",
            mode: "replace",
            content: "forbidden",
            expectedVersion: versionOf(secret),
            oldText: secret,
            newText: "forbidden",
          }),
          "tool_unavailable",
          [root, secret],
        );
      }
      let denied = true;
      const client = await install(await plugin({ mode: "read-write" }), () =>
        denied ? { type: "deny", reason: "Host policy denied access." } : { type: "allow" },
      );
      failure(await client.invoke("read", { path: "private.txt" }), "tool_denied", [root, secret]);
      failure(
        await client.invoke("write", {
          path: "never-created/secret.txt",
          mode: "create",
          content: "forbidden",
        }),
        "tool_denied",
        [root, secret],
      );
      await expect(lstat(join(root, "never-created"))).rejects.toMatchObject({ code: "ENOENT" });
      denied = false;
      failure(
        await client.invoke("edit", {
          path: "private.txt",
          oldText: secret,
          newText: "forbidden",
          expectedVersion: versionOf(secret),
        }),
        "READ_REQUIRED",
        [root, secret],
      );
      expect(await readFile(join(root, "private.txt"), "utf8")).toBe(secret);
    }));

  it("reads current bytes only after approval and honors rejection and revoked authorization", async () =>
    fixture(async ({ root, plugin, install }) => {
      const target = join(root, "approval.txt");
      await writeFile(target, "before approval");
      let revoked = false;
      const interaction = {
        id: "workspace-approval",
        owner: "host",
        payload: {
          type: "host.workspace-tool",
          version: 1,
          data: { tool: "read", path: "approval.txt", workspaceId: "test" },
        },
      };
      const client = await install(await plugin({ mode: "read-write" }), () =>
        revoked
          ? { type: "deny", reason: "Permission revoked." }
          : { type: "approval", interaction },
      );
      for (const decision of ["approve", "reject", "revoke"] as const) {
        revoked = false;
        const waiting = await observe(await client.start("read", { path: "approval.txt" }));
        expect(waiting.run).toMatchObject({ status: "waiting", interaction });
        expect(waiting.completions).toEqual([]);
        await writeFile(target, `after approval ${decision}`);
        revoked = decision === "revoke";
        const result = await observe(
          await client.agent.resume({
            threadId: waiting.run.identity.threadId,
            queryId: waiting.run.identity.queryId,
            runId: `resumed-${decision}`,
            response: {
              type: "answer",
              interactionId: interaction.id,
              value: decision !== "reject",
            },
          }),
        );
        expect(result.run.status).toBe("completed");
        expect(result.completions).toHaveLength(1);
        if (decision === "approve") {
          expect(output<ReadOutput>(result.completions[0]).content).toBe("after approval approve");
        } else {
          failure(
            result.completions[0],
            decision === "reject" ? "tool_approval_rejected" : "tool_denied",
            [root, `after approval ${decision}`],
          );
        }
      }
    }));

  it("rejects strict malformed inputs before asking the host and never changes disk", async () =>
    fixture(async ({ root, plugin, install }) => {
      await writeFile(join(root, "safe.txt"), "unchanged");
      const authorize = vi.fn(allow);
      const client = await install(await plugin({ mode: "read-write" }), authorize);
      const cases: readonly { name: string; input: JsonObject }[] = [
        { name: "read", input: {} },
        { name: "read", input: { path: 3 } },
        { name: "read", input: { path: "" } },
        { name: "read", input: { path: "safe.txt", root: "/elsewhere" } },
        { name: "read", input: { path: "safe.txt", offset: -1 } },
        { name: "read", input: { path: "safe.txt", offset: 1 } },
        { name: "read", input: { path: "safe.txt", limit: 1 } },
        { name: "read", input: { path: "safe.txt", limit: 4001 } },
        { name: "write", input: { path: "safe.txt", content: "blind overwrite" } },
        { name: "write", input: { path: "safe.txt", mode: "replace", content: "blind overwrite" } },
        {
          name: "write",
          input: {
            path: "safe.txt",
            mode: "create",
            content: "x",
            expectedVersion: versionOf("unchanged"),
          },
        },
        {
          name: "edit",
          input: {
            path: "safe.txt",
            oldText: "",
            newText: "x",
            expectedVersion: versionOf("unchanged"),
          },
        },
        { name: "glob", input: { pattern: "*", limit: 0 } },
        { name: "glob", input: { pattern: "*", limit: 1001 } },
        { name: "grep", input: { pattern: "safe", regex: true } },
        { name: "grep", input: { pattern: "safe", limit: 1001 } },
      ];
      for (const { name, input } of cases) failure(await client.invoke(name, input));
      expect(authorize).not.toHaveBeenCalled();
      expect(await readFile(join(root, "safe.txt"), "utf8")).toBe("unchanged");
      expect(await readdir(root)).toEqual(["safe.txt"]);
    }));

  it("rejects absolute paths, traversal, streams and missing files without private diagnostics", async () =>
    fixture(async ({ directory, root, plugin, install }) => {
      const secret = "outside-file-secret";
      await writeFile(join(directory, "secret.txt"), secret);
      const client = await install(await plugin({ mode: "read-write" }));
      for (const [path, code] of [
        [join(directory, "secret.txt"), "INVALID_PATH"],
        ["C:\\private\\secret.txt", "INVALID_PATH"],
        ["C:secret.txt", "INVALID_PATH"],
        ["\\\\server\\share\\secret.txt", "INVALID_PATH"],
        ["/etc/passwd", "INVALID_PATH"],
        ["safe.txt:stream", "INVALID_PATH"],
        ["\u0000secret.txt", "INVALID_PATH"],
        ["../secret.txt", "OUTSIDE_WORKSPACE"],
        ["..\\secret.txt", "OUTSIDE_WORKSPACE"],
        ["missing.txt", "NOT_FOUND"],
      ]) {
        failure(await client.invoke("read", { path }), code, [directory, root, secret]);
      }
      for (const path of ["../created.txt", "C:\\private\\created.txt", "safe.txt:stream"]) {
        failure(
          await client.invoke("write", { path, mode: "create", content: "escape" }),
          undefined,
          [root, secret],
        );
      }
      await expect(lstat(join(directory, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      for (const name of ["glob", "grep"]) {
        failure(
          await client.invoke(
            name,
            name === "glob" ? { pattern: "../**/*" } : { pattern: secret, glob: "../**/*" },
          ),
          undefined,
          [directory, secret],
        );
      }
    }));

  it("handles empty, BOM and size-boundary text and rejects binary, invalid UTF8 and directories", async () =>
    fixture(async ({ root, plugin, install }) => {
      await writeFile(join(root, "empty.txt"), "");
      await writeFile(join(root, "bom.txt"), "\ufeffhello");
      await writeFile(join(root, "limit.txt"), "a".repeat(65536));
      await writeFile(join(root, "large.txt"), "a".repeat(65537));
      await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
      await writeFile(join(root, "binary.txt"), "binary-secret\0private");
      await writeFile(join(root, "control.txt"), "control-secret\u0001private");
      await mkdir(join(root, "directory"));
      const client = await install(await plugin({ mode: "read-write" }));
      expect(output<ReadOutput>(await client.invoke("read", { path: "empty.txt" }))).toMatchObject({
        size: 0,
        content: "",
        totalCharacters: 0,
        hasMore: false,
      });
      expect(output<ReadOutput>(await client.invoke("read", { path: "bom.txt" }))).toMatchObject({
        size: 8,
        content: "hello",
      });
      expect(output<ReadOutput>(await client.invoke("read", { path: "limit.txt" }))).toMatchObject({
        size: 65536,
        hasMore: true,
        content: "a".repeat(4000),
      });
      for (const [path, code] of [
        ["large.txt", "FILE_TOO_LARGE"],
        ["invalid.txt", "INVALID_UTF8"],
        ["binary.txt", "BINARY_FILE"],
        ["control.txt", "BINARY_FILE"],
        ["directory", "UNSAFE_FILE_TYPE"],
      ])
        failure(await client.invoke("read", { path }), code, [
          root,
          "binary-secret",
          "control-secret",
        ]);
      const small = await install(await plugin({ mode: "read-write", maxFileBytes: 8 }));
      failure(
        await small.invoke("write", {
          path: "oversize.txt",
          mode: "create",
          content: "é".repeat(5),
        }),
      );
      await expect(lstat(join(root, "oversize.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      const bom = output<ReadOutput>(await small.invoke("read", { path: "bom.txt" }));
      failure(
        await small.invoke("edit", {
          path: bom.path,
          oldText: "hello",
          newText: "é".repeat(5),
          expectedVersion: bom.version,
        }),
      );
      expect(await readFile(join(root, "bom.txt"), "utf8")).toBe("\ufeffhello");
      for (const content of ["binary\0secret", "control\u0001secret"]) {
        failure(
          await client.invoke("write", { path: "binary-created.txt", mode: "create", content }),
        );
      }
      await expect(lstat(join(root, "binary-created.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }));

  it("rejects symlink and junction components for reading and writing and skips them in discovery", async () =>
    fixture(async ({ directory, root, plugin, install }) => {
      const outside = join(directory, "outside");
      const inside = join(root, "inside");
      await mkdir(outside);
      await mkdir(inside);
      await writeFile(join(outside, "secret.txt"), "outside-linked-secret");
      await writeFile(join(inside, "safe.txt"), "inside-linked-secret");
      await symlink(outside, join(root, "outside-link"), "junction");
      await symlink(inside, join(root, "inside-link"), "junction");
      const client = await install(await plugin({ mode: "read-write" }));
      for (const path of ["outside-link/secret.txt", "inside-link/safe.txt"]) {
        failure(await client.invoke("read", { path }), undefined, [
          directory,
          "outside-linked-secret",
          "inside-linked-secret",
        ]);
        failure(await client.invoke("write", { path, mode: "create", content: "overwrite" }));
      }
      failure(
        await client.invoke("write", {
          path: "outside-link/created.txt",
          mode: "create",
          content: "escape",
        }),
      );
      await expect(lstat(join(outside, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        output<GlobOutput>(await client.invoke("glob", { pattern: "**/*.txt" })).matches,
      ).toEqual(["inside/safe.txt"]);
      expect(
        output<GrepOutput>(await client.invoke("grep", { pattern: "linked-secret" })).matches.map(
          (match) => match.path,
        ),
      ).toEqual(["inside/safe.txt"]);
      await expect(createTools({ workspaceRoot: join(root, "inside-link") })).rejects.toMatchObject(
        {
          code: "INVALID_WORKSPACE",
        },
      );
    }));

  it.skipIf(process.platform === "win32")("rejects a final file symlink", async () =>
    fixture(async ({ root, plugin, install }) => {
      await writeFile(join(root, "target.txt"), "linked-secret");
      await symlink(join(root, "target.txt"), join(root, "file-link.txt"));
      const client = await install(await plugin({ mode: "read-write" }));
      failure(await client.invoke("read", { path: "file-link.txt" }), "UNSAFE_FILE_TYPE", [
        root,
        "linked-secret",
      ]);
      failure(
        await client.invoke("write", {
          path: "file-link.txt",
          mode: "create",
          content: "overwrite",
        }),
      );
      expect(await readFile(join(root, "target.txt"), "utf8")).toBe("linked-secret");
    }),
  );

  it("rejects invalid roots and unsafe option values without creating directories", async () =>
    fixture(async ({ directory, root }) => {
      const file = join(root, "not-directory");
      await writeFile(file, "plain file");
      for (const workspaceRoot of ["", join(directory, "missing-root"), file]) {
        const error: unknown = await createTools({ workspaceRoot }).catch(
          (caught: unknown) => caught,
        );
        expect(error).toMatchObject({
          code: workspaceRoot ? "INVALID_WORKSPACE" : "INVALID_OPTIONS",
        });
        expect(String(error)).not.toContain(directory);
      }
      for (const options of [
        { maxFileBytes: 0 },
        { maxFileBytes: 16 * 1024 * 1024 + 1 },
        { maxScanEntries: -1 },
        { maxScanEntries: 100001 },
        { maxSearchBytes: 1.5 },
        { maxSearchBytes: 128 * 1024 * 1024 + 1 },
        { maxFileBytes: Number.NaN },
        { maxSearchBytes: Number.POSITIVE_INFINITY },
      ])
        await expect(createTools({ workspaceRoot: root, ...options })).rejects.toBeDefined();
      await expect(lstat(join(directory, "missing-root"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(root)).toEqual(["not-directory"]);
    }));

  it("never recovers old atomic writes or creates locks and parents during read and search", async () =>
    fixture(async ({ root, plugin, install }) => {
      const target = join(await realpath(root), "document.txt");
      await writeFile(target, "committed content");
      const key = createHash("sha256").update(target).digest("hex").slice(0, 20);
      const backupName = `${basename(target)}.${key}.atomic-old.test`;
      const backup = join(root, backupName);
      const manifest = join(root, `.${basename(target)}.${key}.atomic-replace.json`);
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
      const barrierName = ".watch-barrier";
      const barrier = Promise.withResolvers<void>();
      const events: string[] = [];
      const watcher = watch(root, (_event, filename) => {
        events.push(String(filename));
        if (String(filename) === barrierName) barrier.resolve();
      });
      watcher.on("error", barrier.reject);
      try {
        const client = await install(await plugin());
        expect(
          output<ReadOutput>(await client.invoke("read", { path: "document.txt" })).content,
        ).toBe("committed content");
        failure(await client.invoke("read", { path: "new-parent/missing.txt" }), "NOT_FOUND", [
          root,
        ]);
        const discovered = output<GlobOutput>(await client.invoke("glob", { pattern: "**/*" }));
        expect(discovered.matches).toEqual(["document.txt"]);
        expect(
          output<GrepOutput>(await client.invoke("grep", { pattern: "private" })).matches,
        ).toEqual([]);
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
});

describe("bounded base tool discovery", () => {
  it("matches supported glob wildcards deterministically and reports incomplete result sets", async () =>
    fixture(async ({ root, plugin, install }) => {
      await mkdir(join(root, "nested", "deeper"), { recursive: true });
      for (const path of [
        "z.txt",
        "a.txt",
        "nested/b.txt",
        "nested/deeper/c.txt",
        "nested/no.md",
      ]) {
        await writeFile(join(root, path), path);
      }
      const client = await install(await plugin());
      expect(output<GlobOutput>(await client.invoke("glob", { pattern: "**/*.txt" }))).toEqual({
        matches: ["a.txt", "nested/b.txt", "nested/deeper/c.txt", "z.txt"],
        truncated: false,
      });
      expect(output<GlobOutput>(await client.invoke("glob", { pattern: "nested/?.txt" }))).toEqual({
        matches: ["nested/b.txt"],
        truncated: false,
      });
      expect(output<GlobOutput>(await client.invoke("glob", { pattern: "*.txt" }))).toEqual({
        matches: ["a.txt", "z.txt"],
        truncated: false,
      });
      const limited = output<GlobOutput>(
        await client.invoke("glob", { pattern: "**/*.txt", limit: 2 }),
      );
      expect(limited.truncated).toBe(true);
      expect(limited.matches).toHaveLength(2);
      expect(limited.matches).toEqual([...limited.matches].sort());
      expect(limited.matches.every((path) => path.endsWith(".txt"))).toBe(true);
      expect(output<GlobOutput>(await client.invoke("glob", { pattern: "**/*.absent" }))).toEqual({
        matches: [],
        truncated: false,
      });
    }));

  it("bounds traversed entries even for patterns with no matches", async () =>
    fixture(async ({ root, plugin, install }) => {
      await mkdir(join(root, "deep"));
      for (let index = 0; index < 12; index++) {
        await writeFile(join(root, `file-${index}.txt`), `entry ${index}`);
        await writeFile(join(root, "deep", `file-${index}.txt`), `entry ${index}`);
      }
      const client = await install(await plugin({ maxScanEntries: 3 }));
      const glob = output<GlobOutput>(await client.invoke("glob", { pattern: "**/*.absent" }));
      expect(glob).toEqual({ matches: [], truncated: true });
      const grep = output<GrepOutput>(
        await client.invoke("grep", { pattern: "definitely absent" }),
      );
      expect(grep.matches).toEqual([]);
      expect(grep.truncated).toBe(true);
    }));

  it("searches literal text, handles case and line numbers, and never interprets regex or shell syntax", async () =>
    fixture(async ({ root, plugin, install }) => {
      await mkdir(join(root, "notes"));
      await writeFile(
        join(root, "notes", "literal.txt"),
        "alpha\nA.*[x] $HOME ; echo secret\nalpha\r\nALPHA\n",
      );
      await writeFile(join(root, "other.md"), "Aanythingx\nalpha\n");
      const client = await install(await plugin());
      const literal = output<GrepOutput>(
        await client.invoke("grep", {
          pattern: "A.*[x] $HOME ; echo secret",
          glob: "**/*.txt",
        }),
      );
      expect(literal).toEqual({
        matches: [
          {
            path: "notes/literal.txt",
            version: versionOf("alpha\nA.*[x] $HOME ; echo secret\nalpha\r\nALPHA\n"),
            line: 2,
            text: "A.*[x] $HOME ; echo secret",
            truncated: false,
          },
        ],
        truncated: false,
        skipped: [],
      });
      const sensitive = output<GrepOutput>(
        await client.invoke("grep", { pattern: "alpha", glob: "**/*.txt" }),
      );
      expect(sensitive.matches.map((match) => match.line)).toEqual([1, 3]);
      expect(sensitive.matches.map((match) => match.text)).toEqual(["alpha", "alpha"]);
      const insensitive = output<GrepOutput>(
        await client.invoke("grep", {
          pattern: "alpha",
          glob: "**/*.txt",
          caseSensitive: false,
        }),
      );
      expect(insensitive.matches.map((match) => match.line)).toEqual([1, 3, 4]);
      expect(
        output<GrepOutput>(await client.invoke("grep", { pattern: ".*" })).matches,
      ).toMatchObject([{ path: "notes/literal.txt", line: 2 }]);
    }));

  it("bounds match counts, line projections and aggregate search bytes and reports binary/large skips", async () =>
    fixture(async ({ root, plugin, install }) => {
      await writeFile(join(root, "a.txt"), `needle ${"x".repeat(5000)}\nneedle\nneedle\n`);
      await writeFile(join(root, "b.txt"), "needle b\n");
      await writeFile(join(root, "binary.txt"), "needle\0private-binary");
      await writeFile(join(root, "invalid.txt"), Buffer.from([0xff, 0x6e]));
      await writeFile(join(root, "large.txt"), "needle".repeat(12000));
      const client = await install(await plugin());
      const all = output<GrepOutput>(await client.invoke("grep", { pattern: "needle" }));
      expect(all.matches.map((match) => [match.path, match.line])).toEqual([
        ["a.txt", 1],
        ["a.txt", 2],
        ["a.txt", 3],
        ["b.txt", 1],
      ]);
      expect(all.matches[0].text.length).toBeLessThanOrEqual(4000);
      expect(all.matches[0].truncated).toBe(true);
      expect(all.skipped).toEqual([
        { path: "binary.txt", reason: "binary" },
        { path: "invalid.txt", reason: "binary" },
        { path: "large.txt", reason: "too-large" },
      ]);
      expect(JSON.stringify(all)).not.toContain("private-binary");
      const limited = output<GrepOutput>(
        await client.invoke("grep", { pattern: "needle", limit: 2 }),
      );
      expect(limited.matches).toHaveLength(2);
      expect(limited.truncated).toBe(true);
      const bounded = await install(await plugin({ maxSearchBytes: 8 }));
      const budget = output<GrepOutput>(await bounded.invoke("grep", { pattern: "needle" }));
      expect(budget.truncated).toBe(true);
      expect(budget.matches).toEqual([]);
    }));

  it("cancels before and during real asynchronous read, glob and grep without exposing abort reasons", async () =>
    fixture(async ({ root, plugin, pipeline }) => {
      for (let index = 0; index < 10; index++) {
        await writeFile(join(root, `document-${index}.txt`), "needle".repeat(100));
      }
      const actual = await plugin({ mode: "read-write" });
      let dispatched: (() => void) | undefined;
      const tools = await pipeline({
        id: actual.id,
        version: actual.version,
        setup(context) {
          return actual.setup({
            ...context,
            tools: {
              register(definition) {
                if (definition.mode !== "immediate") return context.tools.register(definition);
                return context.tools.register({
                  ...definition,
                  execute(input, execution) {
                    const pending = definition.execute(input, execution);
                    dispatched?.();
                    return pending;
                  },
                });
              },
            },
          });
        },
      });
      for (const during of [false, true]) {
        for (const [name, input] of [
          ["read", { path: "document-0.txt" }],
          ["glob", { pattern: "**/*" }],
          ["grep", { pattern: "needle" }],
          ["write", { path: "never-created/file.txt", mode: "create", content: "forbidden" }],
        ] as const) {
          const controller = new AbortController();
          const started = Promise.withResolvers<void>();
          dispatched = started.resolve;
          const reason = `${root}: private cancellation reason`;
          if (!during) controller.abort(new Error(reason));
          const callId = `${name}-${during}`;
          const pending = tools.execute(
            { type: "tool-call", callId, name, input },
            {
              identity: { agentId: "agent", threadId: "thread", queryId: "query", runId: "run" },
              callId,
              signal: controller.signal,
            },
          );
          if (during) {
            await started.promise;
            controller.abort(new Error(reason));
          }
          failure(await pending, undefined, [root, "private cancellation reason"]);
        }
      }
      await expect(lstat(join(root, "never-created"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, "document-0.txt"), "utf8")).toBe("needle".repeat(100));
    }));
});

describe("base tools diagnostics", () => {
  it("logs all five real tools without payloads and preserves applied writes when an output fails", async () => {
    const records: LogRecord[] = [];
    const logs = createLogs({
      outputs: [
        {
          id: "unavailable",
          minimumLevel: "debug",
          exporter: {
            export() {
              throw new Error("private log output failure");
            },
            async close() {},
          },
        },
        {
          id: "capture",
          minimumLevel: "debug",
          exporter: {
            export(record) {
              records.push(record);
            },
            async close() {},
          },
        },
      ],
    });
    try {
      await fixture(async ({ root, plugin, install }) => {
        const path = "private-filename-marker.txt";
        const before = "private-body-before";
        const after = "private-body-after";
        const client = await install(
          await plugin(
            { mode: "read-write" },
            logs.getLogger("tools").child({ runId: "obsolete-run" }),
          ),
          allow,
          "logged-agent",
        );
        output<WriteOutput>(
          await client.invoke("write", { path, mode: "create", content: before }),
          "applied",
        );
        const read = output<ReadOutput>(await client.invoke("read", { path }));
        expect(read.content).toBe(before);
        const search = output<GrepOutput>(await client.invoke("grep", { pattern: before }));
        expect(search.matches[0].text).toBe(before);
        expect(
          output<GlobOutput>(await client.invoke("glob", { pattern: "*.txt" })).matches,
        ).toEqual([path]);
        const edit = output<EditOutput>(
          await client.invoke("edit", {
            path,
            expectedVersion: read.version,
            oldText: before,
            newText: after,
          }),
          "applied",
        );
        expect(edit.replacements).toBe(1);
        expect(await readFile(join(root, path), "utf8")).toBe(after);
        failure(
          await client.invoke("read", { path: "../outside-private-marker.txt" }),
          "OUTSIDE_WORKSPACE",
        );
        const completed = records.filter((record) => record.event === "tools.execution.completed");
        expect(
          completed.map((record) => [
            record.data?.toolName,
            record.data?.status,
            record.data?.effects,
          ]),
        ).toEqual([
          ["write", "succeeded", "applied"],
          ["read", "succeeded", "none"],
          ["grep", "succeeded", "none"],
          ["glob", "succeeded", "none"],
          ["edit", "succeeded", "applied"],
          ["read", "failed", "none"],
        ]);
        expect(completed[5]).toMatchObject({
          level: "warn",
          data: { code: "OUTSIDE_WORKSPACE" },
        });
        expect(records.map((record) => record.event)).toEqual(
          Array.from({ length: 6 }, () => [
            "tools.execution.started",
            "tools.execution.completed",
          ]).flat(),
        );
        for (const [index, record] of completed.entries()) {
          const invocation = index + 1;
          expect(record.context).toEqual({
            agentId: "logged-agent",
            threadId: `thread-${invocation}`,
            queryId: `query-${invocation}`,
            runId: `run-${invocation}`,
            toolCallId: `call-${invocation}`,
          });
          expect(record.data?.durationMs).toEqual(expect.any(Number));
          expect(record.data?.durationMs as number).toBeGreaterThanOrEqual(0);
        }
        const diagnostic = JSON.stringify(records);
        for (const forbidden of [
          root,
          path,
          before,
          after,
          read.version,
          "outside-private-marker",
          "obsolete-run",
        ]) {
          expect(diagnostic).not.toContain(forbidden);
        }
        expect(logs.getStatus().outputs[0].failureCount).toBe(12);
      });
      expect(logs.getStatus().state).toBe("open");
    } finally {
      await logs.close();
    }
  });

  it("records execution only after approval and binds it to the resumed run, not rejected attempts", async () => {
    const records: LogRecord[] = [];
    const logs = createLogs({
      outputs: [
        {
          id: "capture",
          minimumLevel: "debug",
          exporter: {
            export(record) {
              records.push(record);
            },
            async close() {},
          },
        },
      ],
    });
    try {
      await fixture(async ({ root, plugin, install }) => {
        const path = "approval-private-name.txt";
        await writeFile(join(root, path), "before-private-body");
        const tools = await plugin({}, logs.getLogger("tools"));
        const denied = await install(
          tools,
          () => ({ type: "deny", reason: "private denial" }),
          "denied-agent",
        );
        failure(await denied.invoke("read", { path }), "tool_denied");
        failure(await denied.invoke("read", { path, unexpected: true }));
        expect(records).toEqual([]);
        const interaction = {
          id: "tools-log-approval",
          owner: "host",
          payload: { type: "host.workspace-tool", version: 1, data: { tool: "read" } },
        };
        const client = await install(
          tools,
          () => ({ type: "approval", interaction }),
          "approved-agent",
        );
        const waiting = await observe(await client.start("read", { path }));
        expect(waiting.run.status).toBe("waiting");
        expect(records).toEqual([]);
        await writeFile(join(root, path), "after-private-body");
        const resumed = await observe(
          await client.agent.resume({
            threadId: waiting.run.identity.threadId,
            queryId: waiting.run.identity.queryId,
            runId: "approval-resumed-run",
            response: { type: "answer", interactionId: interaction.id, value: true },
          }),
        );
        expect(resumed.run.status).toBe("completed");
        expect(output<ReadOutput>(resumed.completions[0]).content).toBe("after-private-body");
        expect(records.map((record) => record.event)).toEqual([
          "tools.execution.started",
          "tools.execution.completed",
        ]);
        for (const record of records) {
          expect(record.context).toEqual({
            ...waiting.run.identity,
            runId: "approval-resumed-run",
            toolCallId: "call-3",
          });
        }
        const rejection = await observe(await client.start("read", { path }));
        const rejected = await observe(
          await client.agent.resume({
            threadId: rejection.run.identity.threadId,
            queryId: rejection.run.identity.queryId,
            runId: "approval-rejected-run",
            response: { type: "reject", interactionId: interaction.id },
          }),
        );
        failure(rejected.completions[0], "tool_approval_rejected");
        expect(records.map((record) => record.context.runId)).toEqual([
          "approval-resumed-run",
          "approval-resumed-run",
        ]);
        const diagnostic = JSON.stringify(records);
        for (const forbidden of [
          root,
          path,
          "before-private-body",
          "after-private-body",
          "private denial",
        ]) {
          expect(diagnostic).not.toContain(forbidden);
        }
      });
      expect(logs.getStatus().state).toBe("open");
    } finally {
      await logs.close();
    }
  });
});
