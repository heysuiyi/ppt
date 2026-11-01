import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = ["tools", "tools-contract", "tools-errors", "atomic-files", "workspace-files"];
const privateEntries = [
  "@agent-harness/tools",
  "@agent-harness/tools/package.json",
  "@agent-harness/tools/internal/create-tools",
  "@agent-harness/tools/internal/files/atomic",
  "@agent-harness/tools/read",
  "@agent-harness/tools/dist/tools.js",
  "@agent-harness/tools/dist/internal/files/atomic.js",
  "@agent-harness/tools/src/tools.ts",
];
const oldEntries = ["./src/tools/tools.js", "./src/tools/internal/atomic.js"];
let stage = "initialize";

// Follow verify-models-package's real installed-closure packing; never shell out via cmd.
async function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .flatMap((directory) => [
        path.join(directory, "node_modules/npm/bin/npm-cli.js"),
        path.resolve(directory, "../lib/node_modules/npm/bin/npm-cli.js"),
      ]),
  ];
  if (process.platform !== "win32")
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      try {
        candidates.push(await realpath(path.join(directory, "npm")));
      } catch {
        /* Not npm. */
      }
    }
  for (const candidate of candidates) {
    if (!candidate || path.basename(candidate).toLowerCase() !== "npm-cli.js") continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try next. */
    }
  }
  throw new Error("npm-cli unavailable");
}
const childEnvironment = { ...process.env };
for (const key of Object.keys(childEnvironment))
  if (["node_path", "node_options"].includes(key.toLowerCase())) delete childEnvironment[key];
async function runNode(args, cwd, label, { allowFailure = false } = {}) {
  stage = label;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 120_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not start child"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut || (code !== 0 && !allowFailure))
        reject(new Error("Child failed; diagnostics withheld"));
      else resolve({ code, stdout, stderr });
    });
  });
}
function within(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
async function rejectLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name),
      stat = await lstat(file);
    assert(!stat.isSymbolicLink(), "Installed closure contains links");
    if (stat.isDirectory()) await rejectLinks(file);
  }
}
const genericConsumer = `
import type { ToolsMode, ToolsOptions, ToolsPlugin, ReadInput, ReadOutput, WriteCreateInput, WriteReplaceInput, WriteInput, WriteOutput, EditInput, EditOutput, GlobInput, GlobOutput, GrepInput, GrepMatch, GrepSkippedFile, GrepOutput } from '@agent-harness/tools/tools-contract';
import { ToolsError } from '@agent-harness/tools/tools-errors';
import type { ToolsErrorCode, ToolsEffects } from '@agent-harness/tools/tools-errors';
const mode: ToolsMode = 'read-only';
const options: ToolsOptions = { workspaceRoot: document.title, mode };
const code: ToolsErrorCode = 'READ_REQUIRED';
const error: Error = new ToolsError(code);
const effects: ToolsEffects = 'none';
export type Contract = [ToolsPlugin, ReadInput, ReadOutput, WriteCreateInput, WriteReplaceInput, WriteInput, WriteOutput, EditInput, EditOutput, GlobInput, GlobOutput, GrepInput, GrepMatch, GrepSkippedFile, GrepOutput];
void options; void error; void effects;
`;
const nodeConsumer = `
import { createTools, prepareWorkspaceRoot } from '@agent-harness/tools/tools';
import type { ToolsPlugin, ToolsOptions } from '@agent-harness/tools/tools-contract';
import { readJsonFile, writeJsonFileAtomic, writeTextFileAtomic, AtomicWriteConflictError } from '@agent-harness/tools/atomic-files';
import type { AtomicFileWriteOptions } from '@agent-harness/tools/atomic-files';
import { WorkspaceFileService, WorkspaceFileError, canonicalizeWorkspaceRoot, globWorkspaceFiles, countOccurrences } from '@agent-harness/tools/workspace-files';
import type { WorkspaceFileErrorCode, WorkspaceFileReadOptions, WorkspaceFileReadResult, WorkspaceFileWindowReadOptions, WorkspaceFileWindowReadResult, WorkspaceFileWriteOptions, WorkspaceFileWriteResult, WorkspaceFileEditOptions, WorkspaceFileEditResult, WorkspaceFileReceipt } from '@agent-harness/tools/workspace-files';
import type { Logger } from '@agent-harness/logs/log-contract';
const options: ToolsOptions = { workspaceRoot: '.' };
const factory = async (logger: Logger): Promise<ToolsPlugin> => createTools(options, logger);
const mode: AtomicFileWriteOptions = { mode: 0o600 };
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const exactOptions: Equal<keyof AtomicFileWriteOptions, 'mode'> = true;
const root = await prepareWorkspaceRoot('.');
const service = new WorkspaceFileService(canonicalizeWorkspaceRoot(root));
const read: WorkspaceFileReadResult = await service.read('file');
const receipt: WorkspaceFileReceipt = read;
const atomic: { value: number } | undefined = await readJsonFile<{ value: number }>('file.json');
await writeJsonFileAtomic('file.json', atomic); await writeTextFileAtomic('file', 'text', mode);
export type PublicTypes = [WorkspaceFileErrorCode, WorkspaceFileReadOptions, WorkspaceFileWindowReadOptions, WorkspaceFileWindowReadResult, WorkspaceFileWriteOptions, WorkspaceFileWriteResult, WorkspaceFileEditOptions, WorkspaceFileEditResult];
void factory; void exactOptions; void receipt; void globWorkspaceFiles; void countOccurrences; void AtomicWriteConflictError; void WorkspaceFileError;
// @ts-expect-error guard is not a supported public atomic option
writeTextFileAtomic('file', 'text', { commitGuard: {} });
// @ts-expect-error snapshot identity is not a public read receipt
read.ino;
// @ts-expect-error path guards are private
import type { WorkspacePathGuard } from '@agent-harness/tools/workspace-files';
// @ts-expect-error snapshots are private
import type { StableFileSnapshot } from '@agent-harness/tools/workspace-files';
// @ts-expect-error atomic transactions are private
import { withAtomicFileTransaction } from '@agent-harness/tools/atomic-files';
// @ts-expect-error per-tool factories are private
import { createRead } from '@agent-harness/tools/tools';
`;

// Serialized into the isolated project, then run by native Node. Only public APIs are imported.
async function runtimeAcceptance(configuration) {
  const { default: assert } = await import("node:assert/strict");
  const fs = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { default: path } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { createAgentApplication } = await import(
    "@agent-harness/core/application/agent-application"
  );
  const { createTools, prepareWorkspaceRoot } = await import("@agent-harness/tools/tools");
  const { ToolsError } = await import("@agent-harness/tools/tools-errors");
  const { readJsonFile, writeJsonFileAtomic, writeTextFileAtomic, AtomicWriteConflictError } =
    await import("@agent-harness/tools/atomic-files");
  const {
    WorkspaceFileService,
    WorkspaceFileError,
    canonicalizeWorkspaceRoot,
    countOccurrences,
    globWorkspaceFiles,
  } = await import("@agent-harness/tools/workspace-files");
  const { createLogs } = await import("@agent-harness/logs/logs");
  let phase = "public entries";
  const resources = [];
  const root = path.join(process.cwd(), "workspace");
  await fs.mkdir(root);
  const hash = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const clone = (value) => structuredClone(value);
  // Controlled in-memory ports implement the real public revision/idempotency/lease contract.
  // They intentionally make no persistence or cross-process durability claim.
  function memoryPorts() {
    const histories = new Map(),
      batches = new Map(),
      rows = new Map();
    let clock = 0;
    const keyOf = (key) => JSON.stringify([key.agentId, key.threadId, key.queryId]);
    return {
      history: {
        async read(threadId) {
          return clone(histories.get(threadId) ?? { threadId, revision: 0, messages: [] });
        },
        async append(threadId, expectedRevision, messages, batchId) {
          const key = JSON.stringify([threadId, batchId]),
            prior = batches.get(key);
          if (prior) {
            assert(same(prior.messages, messages));
            return { status: "appended", revision: prior.revision };
          }
          const current = histories.get(threadId) ?? { threadId, revision: 0, messages: [] };
          if (current.revision !== expectedRevision)
            return { status: "conflict", currentRevision: current.revision };
          const revision = current.revision + 1;
          histories.set(
            threadId,
            clone({ threadId, revision, messages: [...current.messages, ...messages] }),
          );
          batches.set(key, clone({ messages, revision }));
          return { status: "appended", revision };
        },
      },
      checkpoints: {
        async findUnfinished(agentId, threadId) {
          const matching = [...rows.values()].filter(
            (row) =>
              row.key.agentId === agentId &&
              row.key.threadId === threadId &&
              row.checkpoint &&
              ["running", "waiting", "interrupted"].includes(row.checkpoint.status),
          );
          matching.sort((a, b) => b.savedAt - a.savedAt);
          return clone(matching[0]?.checkpoint ?? null);
        },
        async acquire(key, ownerId, options) {
          const id = keyOf(key);
          let row = rows.get(id);
          if (options?.replace && !same(row?.lease, options.replace)) return { status: "stale" };
          if (row?.lease && !options?.replace) return { status: "busy", lease: clone(row.lease) };
          // 首存前和终态释放前仍占用线程；拒绝不改变目标行或代际。
          for (const other of rows.values()) {
            if (
              other.key.agentId === key.agentId &&
              other.key.threadId === key.threadId &&
              other.key.queryId !== key.queryId &&
              (other.lease ||
                (other.checkpoint &&
                  ["running", "waiting", "interrupted"].includes(other.checkpoint.status)))
            )
              return { status: "thread-pending", queryId: other.key.queryId };
          }
          if (!row) {
            row = {
              key: clone(key),
              generation: 0,
              revision: 0,
              savedAt: 0,
              lease: null,
              checkpoint: null,
            };
            rows.set(id, row);
          }
          row.lease = { key: clone(key), ownerId, generation: ++row.generation };
          return {
            status: "acquired",
            lease: clone(row.lease),
            currentRevision: row.revision,
            checkpoint: clone(row.checkpoint),
          };
        },
        async save(lease, expectedRevision, checkpoint) {
          const row = rows.get(keyOf(lease.key));
          if (!row || !same(row.lease, lease)) return { status: "stale" };
          if (row.revision !== expectedRevision)
            return { status: "conflict", currentRevision: row.revision };
          assert(
            same(
              {
                agentId: checkpoint.agentId,
                threadId: checkpoint.threadId,
                queryId: checkpoint.queryId,
              },
              lease.key,
            ),
          );
          row.checkpoint = clone(checkpoint);
          row.savedAt = ++clock;
          return { status: "saved", revision: ++row.revision };
        },
        async release(lease) {
          const row = rows.get(keyOf(lease.key));
          if (row && same(row.lease, lease)) row.lease = null;
        },
      },
      assertReleased() {
        assert([...rows.values()].every((row) => row.lease === null));
      },
    };
  }
  // 独立消费者也必须遵守线程准入；这些状态都由公共存储操作产生。
  const admissionPorts = memoryPorts();
  const admission = admissionPorts.checkpoints;
  const admissionKey = { agentId: "admission", threadId: "thread", queryId: "first" };
  const nextKey = { ...admissionKey, queryId: "next" };
  const empty = await admission.acquire(admissionKey, "empty");
  assert.equal(empty.status, "acquired");
  assert.deepEqual(await admission.acquire(nextKey, "blocked"), {
    status: "thread-pending",
    queryId: "first",
  });
  assert.deepEqual(
    await admission.acquire(nextKey, "stale", {
      replace: { ...empty.lease, key: nextKey },
    }),
    { status: "stale" },
  );
  assert.deepEqual(await admission.acquire(admissionKey, "busy"), {
    status: "busy",
    lease: empty.lease,
  });
  assert.deepEqual(
    await admission.acquire(admissionKey, "stale", {
      replace: { ...empty.lease, generation: 0 },
    }),
    { status: "stale" },
  );
  for (const key of [
    { ...admissionKey, threadId: "other" },
    { ...admissionKey, agentId: "other" },
  ]) {
    const independent = await admission.acquire(key, "independent");
    assert.equal(independent.status, "acquired");
    await admission.release(independent.lease);
  }
  await admission.release(empty.lease);
  const next = await admission.acquire(nextKey, "next");
  assert.equal(next.status, "acquired");
  assert.equal(next.lease.generation, 1);
  assert.deepEqual(await admission.acquire(admissionKey, "blocked"), {
    status: "thread-pending",
    queryId: "next",
  });
  await admission.release(next.lease);
  const preserved = await admission.acquire(admissionKey, "again");
  assert.equal(preserved.status, "acquired");
  assert.equal(preserved.lease.generation, 2);
  assert.equal(preserved.currentRevision, 0);
  assert.equal(preserved.checkpoint, null);
  const terminal = {
    schemaVersion: 1,
    ...admissionKey,
    lastRunId: "run",
    definition: { id: "admission", version: "1" },
    plugins: [],
    model: { providerId: "controlled", modelId: "local" },
    committed: { historyRevision: 0, messages: [], step: 0 },
    startMessageCount: 0,
    maxSteps: 3,
    extensions: [],
    status: "completed",
  };
  assert.deepEqual(await admission.save(preserved.lease, 0, terminal), {
    status: "saved",
    revision: 1,
  });
  assert.deepEqual(await admission.acquire(nextKey, "blocked"), {
    status: "thread-pending",
    queryId: "first",
  });
  await admission.release(preserved.lease);
  for (const status of ["running", "interrupted"]) {
    const identity = { ...admissionKey, queryId: status };
    const active = await admission.acquire(identity, status);
    assert.equal(active.status, "acquired");
    assert.equal(
      (
        await admission.save(active.lease, active.currentRevision, {
          ...terminal,
          ...identity,
          status,
        })
      ).status,
      "saved",
    );
    await admission.release(active.lease);
    assert.deepEqual(await admission.acquire(nextKey, "blocked"), {
      status: "thread-pending",
      queryId: status,
    });
    const resumed = await admission.acquire(identity, "resume");
    assert.equal(resumed.status, "acquired");
    assert.equal(
      (
        await admission.save(resumed.lease, resumed.currentRevision, {
          ...terminal,
          ...identity,
        })
      ).status,
      "saved",
    );
    await admission.release(resumed.lease);
  }
  const admitted = await admission.acquire(nextKey, "after-release");
  assert.equal(admitted.status, "acquired");
  assert.equal(admitted.lease.generation, 2);
  await admission.release(admitted.lease);
  admissionPorts.assertReleased();
  let serial = 0;
  async function install(plugins, authorize = () => ({ type: "allow" })) {
    const ports = memoryPorts();
    let pending,
      toolNames = [],
      returnedResults = 0;
    const generate = async (request, signal) => {
      signal.throwIfAborted();
      toolNames = (request.tools ?? []).map((tool) => tool.name).sort();
      for (const message of request.messages)
        for (const content of message.content)
          if (content.type === "tool-result") returnedResults++;
      const call = pending;
      pending = undefined;
      return call
        ? { message: { role: "assistant", content: [call] }, finishReason: "tool-calls" }
        : {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "completed local operation" }],
            },
            finishReason: "stop",
          };
    };
    const models = {
      async create(selection) {
        return {
          client: {
            selection,
            capabilities: { streaming: false, toolCalls: true, images: false, reasoning: false },
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
      history: ports.history,
      checkpoints: ports.checkpoints,
      authorizeTool: authorize,
    });
    resources.push(app);
    const agent = await app.agents.create({
      agentId: `agent-${++serial}`,
      definition: {
        id: "packed-tools",
        version: "1",
        instructions: "Execute controlled local operations.",
      },
      model: { providerId: "controlled", modelId: "local" },
      maxSteps: 3,
      plugins,
    });
    async function observe(handle, expectedStatus) {
      const completions = [],
        events = [];
      const consume = (async () => {
        for await (const event of handle.events) {
          events.push(event);
          if (event.type === "tool.completed") completions.push(event.completion);
        }
      })();
      const result = await handle.completed;
      await consume;
      assert.equal(result.status, expectedStatus);
      assert(events.some((event) => event.type === `run.${expectedStatus}`));
      ports.assertReleased();
      if (expectedStatus === "waiting") {
        assert.deepEqual(
          await ports.checkpoints.acquire(
            {
              agentId: result.identity.agentId,
              threadId: result.identity.threadId,
              queryId: `${result.identity.queryId}-blocked`,
            },
            "waiting-observer",
          ),
          {
            status: "thread-pending",
            queryId: result.identity.queryId,
          },
        );
      }
      return { result, completions };
    }
    async function start(name, input) {
      const id = ++serial;
      pending = name ? { type: "tool-call", callId: `call-${id}`, name, input } : undefined;
      return agent.run({
        threadId: `thread-${id}`,
        queryId: `query-${id}`,
        runId: `run-${id}`,
        input: [{ role: "user", content: [{ type: "text", text: "local acceptance" }] }],
      });
    }
    async function run(name, input) {
      const { result, completions } = await observe(await start(name, input), "completed");
      if (name) {
        assert.equal(completions.length, 1);
        return completions[0];
      }
      assert.equal(completions.length, 0);
      return result;
    }
    return {
      run,
      start,
      observe,
      async resume(waiting, response) {
        return observe(
          await agent.resume({
            threadId: waiting.identity.threadId,
            queryId: waiting.identity.queryId,
            runId: `resumed-${++serial}`,
            response,
          }),
          "completed",
        );
      },
      get tools() {
        return toolNames;
      },
      get returnedResults() {
        return returnedResults;
      },
      close: () => app.close(),
    };
  }
  function output(completion, effects = "none") {
    assert.equal(completion.status, "succeeded");
    assert.equal(completion.effects, effects);
    assert(completion.output && typeof completion.output === "object");
    return completion.output;
  }
  function failure(completion, code) {
    assert.equal(completion.status, "failed");
    assert.equal(completion.effects, "none");
    if (code) assert.equal(completion.error.code, code);
  }
  async function publicFailure(operation, Class, code, effects) {
    let thrown;
    try {
      await operation();
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof Class);
    if (code) assert.equal(thrown.code, code);
    if (effects) assert.equal(thrown.sideEffects, effects);
    return thrown;
  }
  async function fingerprint(file) {
    const bytes = await fs.readFile(file),
      stat = await fs.lstat(file);
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  // Deliberately literal disk-v1 fixture, independent of private/new manifest constructors.
  async function v1Transaction(name, externalWinner = false) {
    const target = path.join(root, name),
      prepared = path.join(root, `${name}.prepared`);
    await fs.writeFile(target, "old disk v1");
    await fs.writeFile(prepared, "new disk v1");
    const canonical = await fs.realpath(target),
      key = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 20);
    const backupName = `${path.basename(canonical)}.${key}.atomic-old.packed-v1`;
    const manifest = path.join(root, `.${path.basename(canonical)}.${key}.atomic-replace.json`);
    const oldFingerprint = await fingerprint(target),
      newFingerprint = await fingerprint(prepared);
    const backup = path.join(root, backupName);
    await fs.rename(target, backup);
    await fs.writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        targetPath: canonical,
        targetName: path.basename(canonical),
        backupName,
        oldFingerprint,
        newFingerprint,
      }),
    );
    if (externalWinner) await fs.writeFile(target, "external winner");
    return { target, backup, manifest, prepared };
  }
  let logs;
  try {
    for (const entry of configuration.entries) {
      const specifier = `@agent-harness/tools/${entry}`;
      assert.equal(
        fileURLToPath(import.meta.resolve(specifier)),
        path.join(process.cwd(), "node_modules/@agent-harness/tools/dist", `${entry}.js`),
      );
      await import(specifier);
    }
    for (const entry of configuration.privateEntries)
      await assert.rejects(() => import(entry), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    for (const entry of configuration.oldEntries)
      await assert.rejects(() => import(entry), { code: "ERR_MODULE_NOT_FOUND" });
    assert.deepEqual(Object.keys(await import("@agent-harness/tools/tools")).sort(), [
      "createTools",
      "prepareWorkspaceRoot",
    ]);
    assert.deepEqual(Object.keys(await import("@agent-harness/tools/tools-errors")), [
      "ToolsError",
    ]);
    assert.deepEqual(
      Object.keys(await import("@agent-harness/tools/atomic-files")).sort(),
      [
        "AtomicWriteConflictError",
        "readJsonFile",
        "writeJsonFileAtomic",
        "writeTextFileAtomic",
      ].sort(),
    );
    assert.deepEqual(Object.keys(await import("@agent-harness/tools/tools-contract")), []);
    assert.deepEqual(
      Object.keys(await import("@agent-harness/tools/workspace-files")).sort(),
      [
        "WorkspaceFileError",
        "WorkspaceFileService",
        "canonicalizeWorkspaceRoot",
        "countOccurrences",
        "globWorkspaceFiles",
      ].sort(),
    );
    phase = "plain conversation and defaults";
    const plain = await install([]);
    await plain.run();
    assert.deepEqual(plain.tools, []);
    const defaultPlugin = await createTools({ workspaceRoot: root });
    assert.equal(defaultPlugin.id, "tools");
    assert.equal(defaultPlugin.version, "1");
    assert.equal(defaultPlugin.mode, "read-only");
    const readOnly = await install([defaultPlugin]);
    await readOnly.run();
    assert.deepEqual(readOnly.tools, ["glob", "grep", "read"]);
    assert.equal(await prepareWorkspaceRoot(root), await fs.realpath(root));
    assert.equal(canonicalizeWorkspaceRoot(root), await fs.realpath(root));
    await publicFailure(() => prepareWorkspaceRoot(path.join(root, "absent-root")), ToolsError);
    await publicFailure(
      () => createTools({ workspaceRoot: root, mode: "invalid" }),
      ToolsError,
      "INVALID_OPTIONS",
    );
    phase = "authorization before filesystem access";
    const records = [];
    let loggerClosed = 0;
    logs = createLogs({
      outputs: [
        {
          id: "capture",
          minimumLevel: "debug",
          exporter: {
            export(record) {
              records.push(record);
            },
            async close() {
              loggerClosed++;
            },
          },
        },
      ],
    });
    const borrowed = logs.getLogger("packed_tools");
    const plugin = await createTools({ workspaceRoot: root, mode: "read-write" }, borrowed);
    const denied = await install([plugin], () => ({ type: "deny", reason: "controlled denial" }));
    const before = await fs.readdir(root),
      loggedBefore = records.length;
    const refusal = await denied.run("write", {
      mode: "create",
      path: "never-created/file.txt",
      content: "private denied body",
    });
    assert.notEqual(refusal.status, "succeeded");
    assert.deepEqual(await fs.readdir(root), before);
    assert.equal(records.length, loggedBefore);
    // A denied read must not grant observation to a later allowed mutation.
    let allowRead = false;
    const toggled = await install([plugin], () =>
      allowRead ? { type: "allow" } : { type: "deny", reason: "controlled denial" },
    );
    const secretName = "private-unicode-body.txt",
      content = "你好👋 café\r\nsecond private line\n";
    await fs.writeFile(path.join(root, secretName), content);
    assert.notEqual((await toggled.run("read", { path: secretName })).status, "succeeded");
    allowRead = true;
    failure(
      await toggled.run("write", {
        path: secretName,
        mode: "replace",
        expectedVersion: hash(content),
        content: "denied read must not authorize",
      }),
      "READ_REQUIRED",
    );
    phase = "five real tools and Unicode coverage";
    const first = await install([plugin]),
      second = await install([plugin]);
    const firstPage = output(await first.run("read", { path: secretName, limit: 3 }));
    assert.equal(firstPage.content, "你好");
    assert.equal(firstPage.version, hash(content));
    assert.equal(firstPage.size, Buffer.byteLength(content));
    failure(
      await first.run("write", {
        path: secretName,
        mode: "replace",
        expectedVersion: firstPage.version,
        content: "partial",
      }),
      "READ_REQUIRED",
    );
    let page = firstPage,
      reconstructed = page.content;
    while (page.hasMore) {
      page = output(
        await first.run("read", {
          path: secretName,
          offset: page.endOffset,
          limit: 2,
          expectedVersion: firstPage.version,
        }),
      );
      reconstructed += page.content;
    }
    assert.equal(reconstructed, content);
    const matches = output(await first.run("glob", { pattern: "**/*.txt" }));
    assert(JSON.stringify(matches).includes(secretName));
    const grep = output(await first.run("grep", { pattern: "private line", glob: "**/*.txt" }));
    assert(grep.matches.some((match) => match.path === secretName && match.line === 2));
    assert.deepEqual(first.tools, ["edit", "glob", "grep", "read", "write"]);
    failure(
      await second.run("write", {
        path: secretName,
        mode: "replace",
        expectedVersion: firstPage.version,
        content: "isolated",
      }),
      "READ_REQUIRED",
    );
    const replacement = output(
      await first.run("write", {
        path: secretName,
        mode: "replace",
        expectedVersion: firstPage.version,
        content: "alpha alpha",
      }),
      "applied",
    );
    assert.equal(await fs.readFile(path.join(root, secretName), "utf8"), "alpha alpha");
    failure(
      await first.run("edit", {
        path: secretName,
        oldText: "alpha",
        newText: "beta",
        expectedVersion: replacement.version,
        replaceAll: true,
      }),
      "READ_REQUIRED",
    );
    output(await first.run("read", { path: secretName }));
    const edited = output(
      await first.run("edit", {
        path: secretName,
        oldText: "alpha",
        newText: "beta",
        expectedVersion: replacement.version,
        replaceAll: true,
      }),
      "applied",
    );
    assert.equal(edited.replacements, 2);
    assert.equal(await fs.readFile(path.join(root, secretName), "utf8"), "beta beta");
    const created = output(
      await first.run("write", {
        path: "created.txt",
        mode: "create",
        content: "created real bytes",
      }),
      "applied",
    );
    assert.equal(created.operation, "created");
    assert.equal(await fs.readFile(path.join(root, "created.txt"), "utf8"), "created real bytes");
    assert(first.returnedResults > 0);
    phase = "approval rejection and revocation";
    let revoked = false;
    const interaction = {
      id: "packed-approval",
      owner: "controlled-host",
      payload: {
        type: "host.workspace-tool",
        version: 1,
        data: { tool: "read", path: "approval.txt", workspaceId: "isolated" },
      },
    };
    const approval = await install([plugin], () =>
      revoked
        ? { type: "deny", reason: "controlled revocation" }
        : { type: "approval", interaction },
    );
    for (const decision of ["approve", "reject", "revoke"]) {
      revoked = false;
      await fs.writeFile(path.join(root, "approval.txt"), "before authorization");
      const waiting = await approval.observe(
        await approval.start("read", { path: "approval.txt" }),
        "waiting",
      );
      assert.deepEqual(waiting.result.interaction, interaction);
      assert.equal(waiting.completions.length, 0);
      await fs.writeFile(path.join(root, "approval.txt"), `after authorization ${decision}`);
      revoked = decision === "revoke";
      const resumed = await approval.resume(waiting.result, {
        type: "answer",
        interactionId: interaction.id,
        value: decision !== "reject",
      });
      assert.equal(resumed.completions.length, 1);
      if (decision === "approve")
        assert.equal(output(resumed.completions[0]).content, "after authorization approve");
      else
        failure(
          resumed.completions[0],
          decision === "reject" ? "tool_approval_rejected" : "tool_denied",
        );
    }
    phase = "cancellation before mutation";
    let enteredAuthorization, releaseAuthorization;
    const authorizationEntered = new Promise((resolve) => {
      enteredAuthorization = resolve;
    });
    const authorizationReleased = new Promise((resolve) => {
      releaseAuthorization = resolve;
    });
    const cancellable = await install([plugin], async () => {
      enteredAuthorization();
      await authorizationReleased;
      return { type: "allow" };
    });
    const cancelledHandle = await cancellable.start("write", {
      mode: "create",
      path: "cancelled/target.txt",
      content: "must not publish cancelled operation",
    });
    await authorizationEntered;
    cancelledHandle.cancel("controlled acceptance cancellation");
    releaseAuthorization();
    await cancellable.observe(cancelledHandle, "cancelled");
    await assert.rejects(() => fs.access(path.join(root, "cancelled")), { code: "ENOENT" });
    phase = "bounded search and traversal";
    const budgetRoot = path.join(root, "budget");
    await fs.mkdir(budgetRoot);
    await fs.writeFile(path.join(budgetRoot, "a.txt"), "budget needle one");
    await fs.writeFile(path.join(budgetRoot, "b.txt"), "budget needle two");
    const bounded = await install([
      await createTools({ workspaceRoot: budgetRoot, maxSearchBytes: 8, maxScanEntries: 1 }),
    ]);
    assert.equal(output(await bounded.run("glob", { pattern: "**/*" })).truncated, true);
    assert.equal(output(await bounded.run("grep", { pattern: "needle" })).truncated, true);
    phase = "stale versions and path constraints";
    const observed = output(await first.run("read", { path: secretName }));
    await fs.writeFile(path.join(root, secretName), "external changed");
    failure(
      await first.run("write", {
        path: secretName,
        mode: "replace",
        expectedVersion: observed.version,
        content: "must not overwrite",
      }),
      "STALE_FILE",
    );
    assert.equal(await fs.readFile(path.join(root, secretName), "utf8"), "external changed");
    const identity = output(await first.run("read", { path: secretName }));
    await fs.rename(path.join(root, secretName), path.join(root, "old-identity"));
    await fs.writeFile(path.join(root, secretName), "external changed");
    failure(
      await first.run("write", {
        path: secretName,
        mode: "replace",
        expectedVersion: identity.version,
        content: "same bytes new inode",
      }),
      "STALE_FILE",
    );
    failure(await first.run("read", { path: "../outside" }));
    await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([0, 255, 0]));
    failure(await first.run("read", { path: "binary.dat" }));
    await fs.writeFile(path.join(root, "large.txt"), "x".repeat(65537));
    failure(await first.run("read", { path: "large.txt" }), "FILE_TOO_LARGE");
    const deniedPath = path.join(root, "not-created");
    failure(await first.run("read", { path: "not-created/missing" }));
    await assert.rejects(() => fs.access(deniedPath), { code: "ENOENT" });
    phase = "legacy receipts and shared errors";
    const service = new WorkspaceFileService(root);
    await service.inspect(secretName);
    await publicFailure(
      () => service.write(secretName, "inspect grants no receipt"),
      WorkspaceFileError,
      "READ_REQUIRED",
    );
    const receipt = await service.read(secretName);
    const legacyWrite = await service.write(secretName, "legacy first", {
      expectedVersion: receipt.version,
    });
    const legacyEdit = await service.edit(secretName, "first", "second", {
      expectedVersion: legacyWrite.version,
    });
    assert.equal(legacyEdit.content, undefined);
    assert.equal(await fs.readFile(path.join(root, secretName), "utf8"), "legacy second");
    await service.write(secretName, "legacy third", { expectedVersion: legacyEdit.version });
    await fs.writeFile(path.join(root, secretName), "external legacy winner");
    await publicFailure(
      () => service.write(secretName, "overwrite winner"),
      WorkspaceFileError,
      "STALE_FILE",
    );
    assert.equal(await fs.readFile(path.join(root, secretName), "utf8"), "external legacy winner");
    assert.equal(countOccurrences("a a a", "a"), 3);
    assert((await globWorkspaceFiles(root, "**/*.txt")).length > 0);
    service.clear();
    await publicFailure(
      () => service.write(secretName, "cleared"),
      WorkspaceFileError,
      "READ_REQUIRED",
    );
    phase = "real concurrent plugin and legacy creation";
    const concurrent = new WorkspaceFileService(root);
    const race = await Promise.allSettled([
      first.run("write", { path: "race.txt", mode: "create", content: "plugin winner" }),
      concurrent.write("race.txt", "legacy winner"),
    ]);
    const pluginWon = race[0].status === "fulfilled" && race[0].value.status === "succeeded";
    const legacyWon = race[1].status === "fulfilled";
    assert.notEqual(pluginWon, legacyWon);
    assert.equal(
      await fs.readFile(path.join(root, "race.txt"), "utf8"),
      pluginWon ? "plugin winner" : "legacy winner",
    );
    if (!pluginWon) {
      assert.equal(race[0].status, "fulfilled");
      failure(race[0].value);
    }
    phase = "atomic JSON backup and mode";
    const jsonPath = path.join(root, "state.json");
    await writeJsonFileAtomic(jsonPath, { value: 1 });
    await writeJsonFileAtomic(jsonPath, { value: 2 });
    assert.deepEqual(JSON.parse(await fs.readFile(`${jsonPath}.bak`, "utf8")), { value: 1 });
    await fs.writeFile(jsonPath, "{broken");
    assert.deepEqual(await readJsonFile(jsonPath), { value: 1 });
    assert.deepEqual(JSON.parse(await fs.readFile(jsonPath, "utf8")), { value: 1 });
    const missingJSON = path.join(root, "atomic-missing", "missing.json");
    assert.equal(await readJsonFile(missingJSON), undefined);
    await fs.access(path.dirname(missingJSON));
    await writeTextFileAtomic(path.join(root, "mode.txt"), "mode", { mode: 0o600 });
    if (process.platform !== "win32")
      assert.equal((await fs.stat(path.join(root, "mode.txt"))).mode & 0o777, 0o600);
    phase = "read-only disk v1 transaction isolation and recovery";
    const interrupted = await v1Transaction("interrupted.txt");
    const diskBefore = (await fs.readdir(root)).sort();
    const bytesBefore = await fs.readFile(interrupted.manifest, "utf8");
    failure(await first.run("read", { path: "interrupted.txt" }));
    output(await first.run("glob", { pattern: "**/*.txt" }));
    output(await first.run("grep", { pattern: "disk v1", glob: "**/*.txt" }));
    assert.deepEqual((await fs.readdir(root)).sort(), diskBefore);
    assert.equal(await fs.readFile(interrupted.manifest, "utf8"), bytesBefore);
    await assert.rejects(() => fs.access(interrupted.target), { code: "ENOENT" });
    const recovered = await service.inspect("interrupted.txt");
    assert.equal(recovered.content, "old disk v1");
    await assert.rejects(() => fs.access(interrupted.manifest), { code: "ENOENT" });
    await publicFailure(
      () => service.write("interrupted.txt", "inspect cannot authorize"),
      WorkspaceFileError,
      "READ_REQUIRED",
    );
    phase = "external winner and orphan evidence";
    const winner = await v1Transaction("winner.json", true);
    await publicFailure(
      () => readJsonFile(winner.target),
      AtomicWriteConflictError,
      undefined,
      "uncertain",
    );
    assert.equal(await fs.readFile(winner.target, "utf8"), "external winner");
    await fs.access(winner.backup);
    await fs.access(winner.manifest);
    await publicFailure(
      () => service.read("winner.json"),
      AtomicWriteConflictError,
      undefined,
      "uncertain",
    );
    const orphanPath = path.join(root, "orphan.json");
    await fs.writeFile(orphanPath, "{}");
    const canonical = await fs.realpath(orphanPath),
      key = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 20);
    const orphan = path.join(root, `orphan.json.${key}.atomic-old.evidence`);
    await fs.writeFile(orphan, "keep evidence");
    await publicFailure(
      () => readJsonFile(orphanPath),
      AtomicWriteConflictError,
      undefined,
      "uncertain",
    );
    assert.equal(await fs.readFile(orphan, "utf8"), "keep evidence");
    phase = "borrowed logger lifecycle and redaction";
    const closedApps = await Promise.allSettled(
      resources
        .splice(0)
        .reverse()
        .map((app) => app.close()),
    );
    assert(closedApps.every((result) => result.status === "fulfilled"));
    assert.equal(loggerClosed, 0);
    borrowed.info("acceptance.borrowed_alive", { value: 1 });
    assert(records.some((record) => record.event === "acceptance.borrowed_alive"));
    const serialized = JSON.stringify(records);
    for (const privateValue of [
      secretName,
      content,
      "private line",
      "private denied body",
      "alpha alpha",
      "external legacy winner",
      root,
    ])
      assert(!serialized.includes(privateValue));
    await logs.close();
    assert.equal(loggerClosed, 1);
    logs = undefined;
    return {
      publicEntries: "native Node ESM resolved",
      privateImports: "rejected",
      plainConversationCompleted: true,
      allFiveToolsCompleted: true,
      modelConsumedRealToolResults: true,
      defaultReadOnly: true,
      authorizationPrecedesFilesystem: true,
      approvalRejectionAndRevocation: true,
      cancellationBeforeMutation: true,
      boundedSearchAndTraversal: true,
      unicodeFullCoverage: true,
      installationIsolation: true,
      mutationRevokesObservation: true,
      staleVersionAndInodeRejected: true,
      legacyReceiptContinuesAfterMutation: true,
      realPluginLegacyCompetition: true,
      jsonBackupRepaired: true,
      diskV1RecoveredByPublicService: true,
      readOnlyDoesNotRecoverOrLock: true,
      unknownWinnerAndOrphanPreserved: true,
      publicErrorInstanceof: true,
      borrowedLoggerNotClosed: true,
      logsDoNotContainPayloads: true,
      leasesReleased: true,
      modeChecked: process.platform !== "win32",
      platform: process.platform,
    };
  } catch {
    throw new Error(`Packed tools acceptance failed: ${phase}`);
  } finally {
    const closedApps = await Promise.allSettled(resources.reverse().map((app) => app.close()));
    try {
      if (logs) await logs.close();
      assert(closedApps.every((result) => result.status === "fulfilled"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

async function main() {
  assert(Number(process.versions.node.split(".")[0]) >= 24, "Node 24 required");
  const npmCli = await findNpmCli();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-harness-tools-package-"));
  try {
    assert(!within(await realpath(repositoryRoot), await realpath(temporaryRoot)));
    const project = path.join(temporaryRoot, "consumer"),
      cache = path.join(temporaryRoot, "npm-cache");
    await mkdir(project);
    const npm = (args, cwd, label) => runNode([npmCli, ...args, "--cache", cache], cwd, label);
    const workspaces = new Map();
    for (const directory of ["packages/harness", "packages/logs", "packages/tools"]) {
      const absolute = path.join(repositoryRoot, directory),
        manifest = JSON.parse(await readFile(path.join(absolute, "package.json"), "utf8"));
      workspaces.set(manifest.name, { directory: absolute, manifest });
    }
    const closure = new Map(),
      omittedOptionalPeers = new Set();
    async function installedDependency(name, from) {
      for (let current = from; ; current = path.dirname(current)) {
        const directory = path.join(current, "node_modules", name);
        try {
          const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
          return { directory: await realpath(directory), manifest };
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
        }
        if (path.dirname(current) === current)
          throw new Error("Required installed runtime dependency unavailable");
      }
    }
    async function visit(item) {
      const { name, version } = item.manifest,
        previous = closure.get(name);
      if (previous) {
        assert.equal(
          previous.manifest.version,
          version,
          "Conflicting runtime versions require an explicit isolated lock closure",
        );
        return;
      }
      closure.set(name, item);
      const required = new Set(Object.keys(item.manifest.dependencies ?? {}));
      for (const peer of Object.keys(item.manifest.peerDependencies ?? {})) {
        if (item.manifest.peerDependenciesMeta?.[peer]?.optional)
          omittedOptionalPeers.add(`${name}:${peer}`);
        else required.add(peer);
      }
      for (const dependency of required)
        await visit(
          workspaces.get(dependency) ?? (await installedDependency(dependency, item.directory)),
        );
      for (const dependency of Object.keys(item.manifest.optionalDependencies ?? {}))
        await visit(await installedDependency(dependency, item.directory));
    }
    for (const workspace of workspaces.values()) await visit(workspace);
    for (const dependency of ["proper-lockfile", "zod"]) assert(closure.has(dependency));
    const tarballs = [];
    for (const item of closure.values()) {
      const packed = JSON.parse(
        (
          await npm(
            [
              "pack",
              item.directory,
              "--offline",
              "--ignore-scripts",
              "--json",
              "--pack-destination",
              temporaryRoot,
            ],
            temporaryRoot,
            `Pack ${item.manifest.name}`,
          )
        ).stdout,
      );
      assert.equal(packed.length, 1);
      const tarball = path.resolve(temporaryRoot, packed[0].filename);
      assert(within(temporaryRoot, tarball));
      await access(tarball);
      if (workspaces.has(item.manifest.name)) {
        assert(
          !packed[0].files.some(
            ({ path: file }) =>
              file.startsWith("src/") ||
              file.startsWith("tests/") ||
              file.includes("node_modules/"),
          ),
        );
        assert(
          packed[0].files.some(
            ({ path: file }) => file.startsWith("dist/") && file.endsWith(".js"),
          ),
        );
        assert(
          packed[0].files.some(
            ({ path: file }) => file.startsWith("dist/") && file.endsWith(".d.ts"),
          ),
        );
      }
      tarballs.push(tarball);
      await npm(
        ["cache", "add", tarball, "--offline", "--ignore-scripts"],
        temporaryRoot,
        `Cache ${item.manifest.name}`,
      );
    }
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify({
        name: "tools-packed-consumer",
        version: "1.0.0",
        private: true,
        type: "module",
      }),
    );
    await npm(
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--bin-links=false",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        ...tarballs,
      ],
      project,
      "Install complete offline tarball closure",
    );
    await rejectLinks(path.join(project, "node_modules"));
    for (const [name, item] of closure) {
      const installed = path.join(project, "node_modules", name);
      assert(within(await realpath(temporaryRoot), await realpath(installed)));
      const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
      assert.equal(manifest.name, name);
      assert.equal(manifest.version, item.manifest.version);
    }
    const tree = JSON.parse(
      (await npm(["ls", "--all", "--json"], project, "Inspect installed dependency closure"))
        .stdout,
    );
    assert(!tree.problems?.length);
    const installedTools = path.join(project, "node_modules/@agent-harness/tools"),
      manifest = JSON.parse(await readFile(path.join(installedTools, "package.json"), "utf8"));
    assert.equal(manifest.name, "@agent-harness/tools");
    assert.equal(manifest.version, "0.1.0");
    assert.equal(manifest.private, true);
    assert.equal(manifest.type, "module");
    assert.equal(manifest.engines?.node, ">=24");
    assert.deepEqual(
      Object.keys(manifest.exports).sort(),
      entries.map((entry) => `./${entry}`).sort(),
    );
    for (const entry of entries) {
      assert.deepEqual(manifest.exports[`./${entry}`], {
        types: `./dist/${entry}.d.ts`,
        import: `./dist/${entry}.js`,
      });
      await access(path.join(installedTools, "dist", `${entry}.js`));
      await access(path.join(installedTools, "dist", `${entry}.d.ts`));
    }
    const compiler = path.join(repositoryRoot, "node_modules/typescript/bin/tsc");
    await access(compiler);
    await writeFile(path.join(project, "generic.ts"), genericConsumer);
    await writeFile(path.join(project, "node.ts"), nodeConsumer);
    const forbidden = [...privateEntries, ...oldEntries];
    await writeFile(
      path.join(project, "private.ts"),
      forbidden
        .map(
          (entry, index) =>
            `import type * as Private${index} from ${JSON.stringify(entry)}; export type Rejected${index} = typeof Private${index};`,
        )
        .join("\n"),
    );
    const base = {
      target: "ES2024",
      lib: ["ES2024", "DOM", "DOM.Iterable"],
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      types: [],
      forceConsistentCasingInFileNames: true,
    };
    for (const [name, module, moduleResolution, file, extra] of [
      ["bundler-dom", "ESNext", "Bundler", "generic.ts", {}],
      ["nodenext-dom", "NodeNext", "NodeNext", "generic.ts", {}],
      [
        "nodenext-factory",
        "NodeNext",
        "NodeNext",
        "node.ts",
        { types: ["node"], typeRoots: [path.join(repositoryRoot, "node_modules/@types")] },
      ],
    ]) {
      const config = `tsconfig.${name}.json`,
        compilerOptions = { ...base, module, moduleResolution, ...extra };
      await writeFile(
        path.join(project, config),
        JSON.stringify({ compilerOptions, files: [file] }),
      );
      await runNode(
        [compiler, "-p", config, "--pretty", "false"],
        project,
        `Compile isolated ${name}`,
      );
      const negative = `tsconfig.${name}.private.json`;
      await writeFile(
        path.join(project, negative),
        JSON.stringify({ compilerOptions, files: ["private.ts"] }),
      );
      const rejected = await runNode(
        [compiler, "-p", negative, "--pretty", "false"],
        project,
        `Reject ${name} private paths`,
        { allowFailure: true },
      );
      assert.notEqual(rejected.code, 0);
      for (const entry of forbidden) assert(rejected.stdout.includes(`'${entry}'`));
      const codes = [...rejected.stdout.matchAll(/error TS(\d+):/g)].map((match) => match[1]);
      assert(codes.length && codes.every((code) => code === "2307"));
    }
    await writeFile(
      path.join(project, "runtime.mjs"),
      `const configuration = ${JSON.stringify({ entries, privateEntries, oldEntries })};\ntry { console.log(JSON.stringify(await (${runtimeAcceptance.toString()})(configuration))); } catch (error) { console.error(JSON.stringify({ ok: false, stage: error.message })); process.exitCode = 1; }\n`,
    );
    const runtime = await runNode(
      ["runtime.mjs"],
      project,
      "Native Node public Core and real file acceptance",
      { allowFailure: true },
    );
    if (runtime.code !== 0) {
      try {
        const failure = JSON.parse(runtime.stderr);
        if (
          typeof failure.stage === "string" &&
          /^Packed tools acceptance failed: [a-zA-Z0-9 /-]+$/.test(failure.stage)
        )
          stage = failure.stage;
      } catch {
        /* Keep safe stage. */
      }
      throw new Error("Native acceptance failed");
    }
    return {
      package: "@agent-harness/tools@0.1.0",
      packedAlreadyBuiltPackages: [...workspaces.keys()],
      isolatedOfflineInstall: true,
      isolatedNpmCache: true,
      installationScripts: false,
      symlinks: false,
      runtimeDependencyClosure: [...closure.values()]
        .map(({ manifest }) => `${manifest.name}@${manifest.version}`)
        .sort(),
      omittedOptionalPeers: [...omittedOptionalPeers].sort(),
      declarationConsumers: ["Bundler DOM types:[]", "NodeNext DOM types:[]", "NodeNext factory"],
      skipLibCheck: false,
      compilerSideNodeTypes:
        "Repository compiler/@types/node only; runtime uses isolated tarballs exclusively",
      limitations: [
        "Controlled in-memory stores exercise public CAS/leases but are not durable/cross-process storage.",
        "Single installed version per dependency name is required; conflicts fail closed.",
        "Symlink/junction privilege, platform-specific fsync/mode behavior and forced post-publication failure injection remain package/platform tests.",
        "Original pre-migration waiting recovery, real Electron CLI/UI, watch, ASAR and legacy IPC are separate parent acceptance; no remote APIs are called.",
      ],
      ...JSON.parse(runtime.stdout),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
try {
  console.log(JSON.stringify({ ...(await main()), temporaryArtifactsRemoved: true }));
} catch {
  console.error(
    JSON.stringify({
      ok: false,
      stage,
      error: "Tools package verification failed; raw diagnostics intentionally withheld.",
    }),
  );
  process.exitCode = 1;
}
