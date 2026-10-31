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
const entries = [
  "application/agent-application",
  "agent-contract",
  "agent-factory",
  "protocol-values",
  "protocol-errors",
  "extensions/plugin-contract",
  "model/model-contract",
  "tools/tool-contract",
  "session/session-contract",
  "session/checkpoint-contract",
  "session/session-events",
  "session-host",
];
const privateEntries = [
  "@agent-ppt/harness",
  "@agent-ppt/harness/runtime/default-agent",
  "@agent-ppt/harness/dist/agent/runtime/default-agent.js",
  "@agent-ppt/harness/src/agent/protocol-errors.ts",
  "@agent-ppt/harness/package.json",
];

// Invoke npm's JavaScript entry with Node: no cmd.exe quoting or shell interpolation on Windows.
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
  if (process.platform !== "win32") {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      try {
        candidates.push(await realpath(path.join(directory, "npm")));
      } catch {
        /* Not an npm directory. */
      }
    }
  }
  for (const candidate of candidates) {
    if (!candidate || path.basename(candidate).toLowerCase() !== "npm-cli.js") continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try the next installed npm location. */
    }
  }
  throw new Error("Cannot locate npm-cli.js; install npm alongside Node or run through npm.");
}

const childEnvironment = { ...process.env };
for (const key of Object.keys(childEnvironment)) {
  if (["node_path", "node_options"].includes(key.toLowerCase())) delete childEnvironment[key];
}
function runNode(arguments_, cwd, label, { allowFailure = false, diagnostics = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, {
      cwd,
      env: childEnvironment,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () => reject(new Error(`${label}: could not start Node`)));
    child.on("close", (code) => {
      if (code !== 0 && !allowFailure) {
        // npm output may contain registry configuration; never echo it or inherited environment.
        reject(new Error(`${label}: exited ${code}${diagnostics ? `\n${stdout}${stderr}` : ""}`));
      } else resolve({ code, stdout, stderr });
    });
  });
}
function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
async function rejectLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const stat = await lstat(file);
    assert(!stat.isSymbolicLink(), `Packed install must not contain symlinks: ${entry.name}`);
    if (stat.isDirectory()) await rejectLinks(file);
  }
}

// This fixture has no Node typings, repository imports, aliases, or ambient package types.
// The same real ports and Zod definitions are checked under both consumer resolution modes.
const consumerSource = `
import { createAgentApplication, type AgentApplication } from "@agent-ppt/harness/application/agent-application";
import type { Agent, AgentDefinition, AgentRunHandle, AgentRunResult } from "@agent-ppt/harness/agent-contract";
import type { AgentCreationOptions, AgentServices } from "@agent-ppt/harness/agent-factory";
import { sameValue, snapshot, type ProtocolError } from "@agent-ppt/harness/protocol-values";
import { AgentError, asProtocolError } from "@agent-ppt/harness/protocol-errors";
import type { AgentPlugin } from "@agent-ppt/harness/extensions/plugin-contract";
import type { ModelClientFactory, ModelMessage, ModelRequest, ModelResponse, ModelSelection } from "@agent-ppt/harness/model/model-contract";
import type { ImmediateToolDefinition, ToolAuthorizationPolicy } from "@agent-ppt/harness/tools/tool-contract";
import type { AgentCheckpoint, SessionHistory, SessionHistoryStore } from "@agent-ppt/harness/session/session-contract";
import type { CheckpointKey, CheckpointLease, CheckpointStore } from "@agent-ppt/harness/session/checkpoint-contract";
import type { RuntimeEvent } from "@agent-ppt/harness/session/session-events";
import { createSessionHost, type SessionHost } from "@agent-ppt/harness/session-host";
import { z } from "zod";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  check(sameValue(actual, expected), message);
}
async function publicError(operation: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try { await operation(); } catch (error) {
    check(error instanceof AgentError, "Error must share the public AgentError constructor");
    check(error.code === code, "Unexpected public error code");
    equal(asProtocolError(error), { code, message: error.message }, "Protocol conversion must preserve public error");
    return;
  }
  throw new Error("Expected public AgentError: " + code);
}

// Deterministic, single-process in-memory acceptance ports. They provide CAS, fencing,
// snapshots and batch idempotency, NOT disk durability or cross-process persistence.
function memoryPorts() {
  const histories = new Map<string, SessionHistory>();
  const batches = new Map<string, { messages: readonly ModelMessage[]; revision: number }>();
  const rows = new Map<string, {
    key: CheckpointKey; generation: number; revision: number; savedAt: number;
    lease: CheckpointLease | null; checkpoint: AgentCheckpoint | null;
  }>();
  let clock = 0;
  let borrowedDisposals = 0;
  const keyOf = (key: CheckpointKey) => JSON.stringify([key.agentId, key.threadId, key.queryId]);
  const history: SessionHistoryStore & { dispose(): Promise<void> } = {
    async read(threadId) {
      return snapshot(histories.get(threadId) ?? { threadId, revision: 0, messages: [] });
    },
    async append(threadId, expectedRevision, messages, batchId) {
      const batchKey = JSON.stringify([threadId, batchId]);
      const prior = batches.get(batchKey);
      if (prior) {
        check(sameValue(prior.messages, messages), "Batch ID reused with different content");
        return { status: "appended", revision: prior.revision };
      }
      const current = histories.get(threadId) ?? { threadId, revision: 0, messages: [] };
      if (current.revision !== expectedRevision) return { status: "conflict", currentRevision: current.revision };
      const revision = current.revision + 1;
      histories.set(threadId, snapshot({ threadId, revision, messages: [...current.messages, ...messages] }));
      batches.set(batchKey, snapshot({ messages, revision }));
      return { status: "appended", revision };
    },
    async dispose() { borrowedDisposals++; },
  };
  const checkpoints: CheckpointStore & { dispose(): Promise<void> } = {
    async findUnfinished(agentId, threadId) {
      const matching = [...rows.values()].filter((row) => row.key.agentId === agentId && row.key.threadId === threadId
        && row.checkpoint && ["running", "waiting", "interrupted"].includes(row.checkpoint.status));
      matching.sort((left, right) => right.savedAt - left.savedAt);
      return snapshot(matching[0]?.checkpoint ?? null);
    },
    async acquire(key, ownerId, options) {
      const id = keyOf(key);
      let row = rows.get(id);
      if (!row) {
        row = { key: snapshot(key), generation: 0, revision: 0, savedAt: 0, lease: null, checkpoint: null };
        rows.set(id, row);
      }
      if (options?.replace && !sameValue(row.lease, options.replace)) return { status: "stale" };
      if (row.lease && !options?.replace) return { status: "busy", lease: snapshot(row.lease) };
      row.lease = { key: snapshot(key), ownerId, generation: ++row.generation };
      return { status: "acquired", lease: snapshot(row.lease), currentRevision: row.revision, checkpoint: snapshot(row.checkpoint) };
    },
    async save(lease, expectedRevision, checkpoint) {
      const row = rows.get(keyOf(lease.key));
      if (!row || !sameValue(row.lease, lease)) return { status: "stale" };
      if (row.revision !== expectedRevision) return { status: "conflict", currentRevision: row.revision };
      equal({ agentId: checkpoint.agentId, threadId: checkpoint.threadId, queryId: checkpoint.queryId }, lease.key, "Checkpoint key mismatch");
      row.checkpoint = snapshot(checkpoint);
      row.savedAt = ++clock;
      return { status: "saved", revision: ++row.revision };
    },
    async release(lease) {
      const row = rows.get(keyOf(lease.key));
      if (row && sameValue(row.lease, lease)) row.lease = null;
    },
    async dispose() { borrowedDisposals++; },
  };
  return { history, checkpoints, borrowedDisposals: () => borrowedDisposals };
}

const model: ModelSelection = { providerId: "acceptance", modelId: "deterministic" };
const definition: AgentDefinition = { id: "packed-consumer", version: "1", instructions: "Use deterministic acceptance ports." };
function options(agentId: string, plugins: readonly AgentPlugin[] = []): AgentCreationOptions {
  return { agentId, definition, model, maxSteps: 4, plugins };
}
function models(respond: (request: ModelRequest) => ModelResponse) {
  let bindingsDisposed = 0;
  let borrowedDisposals = 0;
  const factory: ModelClientFactory & { dispose(): Promise<void> } = {
    async create(selection, signal) {
      signal.throwIfAborted();
      return {
        client: {
          selection,
          capabilities: { streaming: false, toolCalls: true, images: false, reasoning: false },
          async generate(request, signal) { signal.throwIfAborted(); return respond(request); },
          async *stream(request, signal) { signal.throwIfAborted(); yield { type: "completed" as const, response: respond(request) }; },
        },
        async dispose() { bindingsDisposed++; },
      };
    },
    async dispose() { borrowedDisposals++; },
  };
  return { factory, bindingsDisposed: () => bindingsDisposed, borrowedDisposals: () => borrowedDisposals };
}
const textResponse = (text: string): ModelResponse => ({ message: { role: "assistant", content: [{ type: "text", text }] }, finishReason: "stop" });
const input = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];
async function finish(handle: AgentRunHandle): Promise<AgentRunResult> {
  const events: RuntimeEvent[] = [];
  const consume = (async () => { for await (const event of handle.events) events.push(event); })();
  const result = await handle.completed;
  await consume;
  check(events.some((event) => event.kind === "fact" && event.type === "run." + result.status && event.identity.runId === result.identity.runId), "Native Node event stream must report the authoritative run boundary");
  return result;
}

const plainPorts = memoryPorts();
const plainModels = models((request) => {
  check(!request.tools?.length, "Plugin-free application must have no tools");
  return textResponse("plain conversation");
});
const allow: ToolAuthorizationPolicy = () => ({ type: "allow" });
const plainServices: AgentServices = { ...plainPorts, models: plainModels.factory, authorizeTool: allow };
const application: AgentApplication = createAgentApplication(plainServices);
const agent: Agent = await application.agents.create(options("plain-agent"));
await publicError(() => application.agents.create(options("plain-agent")), "duplicate-agent");
const plain = await finish(await agent.run({ threadId: "plain-thread", queryId: "plain-query", runId: "plain-run", input }));
check(plain.status === "completed", "Plugin-free native Node conversation must complete");
check(plain.output.some((message) => message.role === "assistant" && message.content.some((content) => content.type === "text" && content.text === "plain conversation")), "Plain assistant output missing");
await application.close();
await application.close();
await publicError(() => application.agents.create(options("closed-agent")), "application-closed");
check((await plainPorts.history.read("plain-thread")).messages.length === 2, "Borrowed history must remain readable after application close");
check(plainPorts.borrowedDisposals() === 0 && plainModels.borrowedDisposals() === 0, "Application must not dispose borrowed ports");
check(plainModels.bindingsDisposed() === 1, "Application must release its model binding exactly once");
await publicError(() => snapshot({ invalid: undefined }), "INVALID_PROTOCOL_VALUE");
const safe: ProtocolError = asProtocolError(new Error("not public"));
check(safe.code === "EXECUTION_FAILED" && !safe.message.includes("not public"), "Unknown errors must remain private");

let sideEffects = 0;
let pluginDisposals = 0;
const tool: ImmediateToolDefinition<{ amount: number }, { total: number }> = {
  name: "increment", owner: "packed-tool", version: "1", description: "Increment an in-memory acceptance counter",
  mode: "immediate", inputSchema: z.object({ amount: z.number().int().positive() }), outputSchema: z.object({ total: z.number().int() }),
  async execute(value) { sideEffects += value.amount; return { status: "succeeded", effects: "applied", output: { total: sideEffects } }; },
  toModelContent(result) { return [{ type: "text", text: result.status === "succeeded" ? String(result.output.total) : result.error.code }]; },
};
const plugin: AgentPlugin = {
  id: "packed-tool", version: "1",
  setup(context) {
    context.tools.register(tool);
    context.scope.own({ async dispose() { pluginDisposals++; } });
  },
};

async function toolCase(mode: "approve" | "reject" | "deny" | "invalid") {
  const ports = memoryPorts();
  let schemaObserved = false;
  let authorizations = 0;
  let bindingsEnsured = 0;
  const responseModels = models((request) => {
    const schema = request.tools?.find((candidate) => candidate.name === "increment")?.inputSchema;
    check(schema && schema.type === "object", "Real Zod schema must reach the model as JSON Schema");
    schemaObserved = true;
    const result = request.messages.findLast((message) => message.role === "tool");
    if (result?.role === "tool") return textResponse("tool complete");
    return {
      message: { role: "assistant", content: [{ type: "tool-call", callId: "increment-call", name: "increment", input: { amount: mode === "invalid" ? "bad" : 2 } }] },
      finishReason: "tool-calls",
    };
  });
  const interaction = { id: "approve-" + mode, owner: "host-policy", payload: { type: "approval", version: 1, data: { tool: "increment" } } };
  const authorizeTool: ToolAuthorizationPolicy = () => {
    authorizations++;
    return mode === "deny" ? { type: "deny", reason: "Acceptance policy denied" } : { type: "approval", interaction };
  };
  const services: AgentServices = { ...ports, models: responseModels.factory, authorizeTool };
  const host: SessionHost = await createSessionHost({
    services, agent: options("tool-" + mode, [plugin]), threadId: "thread-" + mode,
    binding: { async ensure() { bindingsEnsured++; } },
  });
  const before = sideEffects;
  let result = await finish(await host.run({ queryId: "query-" + mode, runId: "initial-" + mode, input }));
  if (mode === "approve" || mode === "reject") {
    check(result.status === "waiting", "Approval must suspend the run");
    equal(result.interaction, interaction, "Waiting must expose the stored interaction");
    check(sideEffects === before, "Waiting must not execute the tool");
    check((await ports.checkpoints.findUnfinished("tool-" + mode, "thread-" + mode))?.status === "waiting", "Waiting checkpoint must be committed before return");
    result = await finish(await host.resume({
      queryId: "query-" + mode, runId: "resumed-" + mode,
      response: mode === "approve" ? { interactionId: interaction.id, type: "answer", value: true } : { interactionId: interaction.id, type: "reject" },
    }));
  }
  check(result.status === "completed", "Tool completion must return to the model and complete");
  check(sideEffects === before + (mode === "approve" ? 2 : 0), "Rejected, denied, or invalid inputs must have no side effects");
  check(schemaObserved && bindingsEnsured === 1, "Host must validate binding and expose schema");
  check(authorizations === (mode === "invalid" ? 0 : mode === "deny" ? 1 : 2), "Input must be validated before policy and resume must reauthorize");
  const stored = await ports.history.read("thread-" + mode);
  const results = stored.messages.flatMap((message) => message.role === "tool" ? message.content : []);
  check(results.length === 1, "Exactly one tool result must be committed");
  check(Boolean(results[0].isError) === (mode !== "approve"), "Denied/rejected/invalid tool results must report an error");
  if (mode === "reject" || mode === "deny") {
    const code = mode === "reject" ? "tool_approval_rejected" : "tool_denied";
    check(results[0].content.some((content) => content.type === "text" && content.text.includes(code)), "Public tool error identity must survive protocol conversion");
  }
  await host.close();
  await host.close();
  await publicError(() => host.run({ queryId: "closed", runId: "closed", input }), "HOST_CLOSED");
  equal(await ports.history.read("thread-" + mode), stored, "Closing host must preserve borrowed history");
  check(ports.borrowedDisposals() === 0 && responseModels.borrowedDisposals() === 0, "Host must not dispose borrowed services");
  check(responseModels.bindingsDisposed() === 1, "Host must release its own binding exactly once");
  return ports;
}

const approvedPorts = await toolCase("approve");
await toolCase("reject");
await toolCase("deny");
await toolCase("invalid");
check(pluginDisposals === 4 && sideEffects === 2, "Owned plugins must close once; only approved tool may execute");

// Exercise the ports' own concurrency semantics rather than pretending a Map is durable storage.
const historyMessages = [{ role: "user" as const, content: [{ type: "text" as const, text: "batch" }] }];
equal(await approvedPorts.history.append("port-thread", 0, historyMessages, "batch-1"), { status: "appended", revision: 1 }, "History append");
equal(await approvedPorts.history.append("port-thread", 0, historyMessages, "batch-1"), { status: "appended", revision: 1 }, "Batch replay must be idempotent");
equal(await approvedPorts.history.append("port-thread", 0, historyMessages, "batch-2"), { status: "conflict", currentRevision: 1 }, "History CAS");
check((await approvedPorts.history.read("port-thread")).messages.length === 1, "Conflict/replay must not duplicate history");
const key = { agentId: "tool-approve", threadId: "thread-approve", queryId: "query-approve" };
const store = approvedPorts.checkpoints;
const first = await store.acquire(key, "writer-1");
check(first.status === "acquired" && first.checkpoint, "Completed checkpoint must survive release");
check((await store.acquire(key, "writer-1")).status === "busy", "Same owner cannot reacquire a live lease");
check((await store.save(first.lease, first.currentRevision - 1, first.checkpoint)).status === "conflict", "Checkpoint revision CAS");
const second = await store.acquire(key, "writer-2", { replace: first.lease });
check(second.status === "acquired", "Exact lease takeover");
check(second.lease.generation > first.lease.generation, "Generations must increase");
check((await store.save(first.lease, first.currentRevision, first.checkpoint)).status === "stale", "Old generation must be fenced");
await store.release(first.lease);
check((await store.acquire(key, "writer-3")).status === "busy", "Stale release must not release new owner");
check((await store.acquire(key, "writer-3", { replace: first.lease })).status === "stale", "Stale replacement must fail");
const saved = await store.save(second.lease, second.currentRevision, first.checkpoint);
check(saved.status === "saved" && saved.revision === second.currentRevision + 1, "Current fenced CAS must save");
await store.release(second.lease);
await store.release(second.lease);
check((await store.save(second.lease, saved.revision, first.checkpoint)).status === "stale", "Released writer must be fenced");
check((await store.acquire(key, "writer-3", { replace: second.lease })).status === "stale", "Released lease cannot authorize takeover");
const third = await store.acquire(key, "writer-3");
check(third.status === "acquired" && third.lease.generation > second.lease.generation && third.currentRevision === saved.revision, "Release must preserve revision and never reuse generation");
await store.release(third.lease);

console.log(JSON.stringify({
  nativeNode: true, plainConversation: true, zodSchema: true,
  approvalWaitingResume: true, rejectionWithoutEffects: true, policyDenialWithoutEffects: true,
  schemaValidationBeforeAuthorization: true, borrowedHistoryAfterClose: true,
  publicAgentErrorIdentity: true, protocolErrorConversion: true,
  inMemoryPorts: { historyIdempotency: true, revisionCas: true, leaseFencing: true, crossProcessDurability: false },
}));
`;

async function main() {
  assert(Number(process.versions.node.split(".")[0]) >= 24, "Node 24 or newer is required");
  const npmCli = await findNpmCli();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-ppt-harness-package-"));
  try {
    const outsideRoot = await realpath(temporaryRoot);
    assert(
      !isWithin(await realpath(repositoryRoot), outsideRoot),
      "Consumer project must be outside the repository",
    );
    const project = path.join(temporaryRoot, "consumer");
    await mkdir(project);
    const npm = (args, cwd, label) => runNode([npmCli, ...args], cwd, label);
    async function pack(args, cwd, label) {
      const result = await npm(
        ["pack", ...args, "--ignore-scripts", "--json", "--pack-destination", temporaryRoot],
        cwd,
        label,
      );
      const packed = JSON.parse(result.stdout);
      assert(
        Array.isArray(packed) && packed.length === 1 && typeof packed[0].filename === "string",
        `${label}: missing tarball`,
      );
      const tarball = path.resolve(temporaryRoot, packed[0].filename);
      assert(isWithin(temporaryRoot, tarball), `${label}: tarball escaped temporary directory`);
      await access(tarball);
      return tarball;
    }
    // --ignore-scripts is deliberate: the workspace must already contain distributable JS + d.ts.
    const harnessTarball = await pack(
      ["--workspace", "@agent-ppt/harness"],
      repositoryRoot,
      "Pack harness workspace",
    );
    const zodTarball = await pack(
      [path.join(repositoryRoot, "node_modules/zod")],
      temporaryRoot,
      "Pack installed real Zod",
    );
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify({
        name: "harness-packed-consumer",
        version: "1.0.0",
        private: true,
        type: "module",
      }),
    );
    await npm(
      [
        "install",
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        harnessTarball,
        zodTarball,
      ],
      project,
      "Install packed packages outside repository",
    );
    await rejectLinks(path.join(project, "node_modules"));
    const tree = JSON.parse(
      (await npm(["ls", "--all", "--json"], project, "Inspect installed dependency closure"))
        .stdout,
    );
    const installed = new Set();
    function visitDependencies(node) {
      for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
        assert(
          ["@agent-ppt/harness", "zod"].includes(name),
          `Unexpected packed consumer dependency: ${name}`,
        );
        assert(!dependency.missing && !dependency.invalid, `Invalid installed dependency: ${name}`);
        installed.add(name);
        visitDependencies(dependency);
      }
    }
    visitDependencies(tree);
    assert(
      installed.has("@agent-ppt/harness") && installed.has("zod"),
      "Real packed harness and Zod must be installed",
    );
    const installedHarness = path.join(project, "node_modules/@agent-ppt/harness");
    const manifest = JSON.parse(
      await readFile(path.join(installedHarness, "package.json"), "utf8"),
    );
    assert(
      manifest.name === "@agent-ppt/harness" &&
        manifest.version === "0.1.0" &&
        manifest.private === true &&
        manifest.type === "module",
      "Packed package identity must match the private ESM workspace",
    );
    assert(
      !manifest.scripts?.postinstall,
      "Installed package must not depend on postinstall compilation",
    );
    assert(
      isWithin(outsideRoot, await realpath(installedHarness)),
      "Installed harness must not resolve back into the repository",
    );
    await writeFile(path.join(project, "consumer.ts"), consumerSource);
    const compiler = path.join(repositoryRoot, "node_modules/typescript/bin/tsc");
    await access(compiler);
    const baseOptions = {
      target: "ES2024",
      lib: ["ES2024", "DOM", "DOM.Iterable"],
      types: [],
      strict: true,
      skipLibCheck: false,
      noEmitOnError: true,
      forceConsistentCasingInFileNames: true,
    };
    for (const [name, module, moduleResolution, noEmit] of [
      ["nodenext", "NodeNext", "NodeNext", false],
      ["bundler-dom", "ESNext", "Bundler", true],
    ]) {
      const config = `tsconfig.${name}.json`;
      await writeFile(
        path.join(project, config),
        JSON.stringify({
          compilerOptions: { ...baseOptions, module, moduleResolution, noEmit, outDir: "compiled" },
          files: ["consumer.ts"],
        }),
      );
      await runNode(
        [compiler, "--project", config, "--pretty", "false"],
        project,
        `Compile isolated ${name} declarations`,
        { diagnostics: true },
      );
      const negative = "private-imports.ts";
      await writeFile(
        path.join(project, negative),
        privateEntries
          .map(
            (entry, index) =>
              `import type * as Private${index} from ${JSON.stringify(entry)};\nexport type Rejected${index} = typeof Private${index};`,
          )
          .join("\n"),
      );
      const negativeConfig = `tsconfig.${name}.private.json`;
      await writeFile(
        path.join(project, negativeConfig),
        JSON.stringify({
          compilerOptions: { ...baseOptions, module, moduleResolution, noEmit: true },
          files: [negative],
        }),
      );
      const rejected = await runNode(
        [compiler, "--project", negativeConfig, "--pretty", "false"],
        project,
        `Reject private imports in ${name}`,
        { allowFailure: true },
      );
      assert(rejected.code !== 0, `${name} must reject private and root imports`);
      for (const entry of privateEntries)
        assert(rejected.stdout.includes(`'${entry}'`), `${name} did not reject ${entry}`);
      const diagnosticCodes = [...rejected.stdout.matchAll(/error TS(\d+):/g)].map(
        (match) => match[1],
      );
      assert(
        diagnosticCodes.length > 0 && diagnosticCodes.every((code) => code === "2307"),
        `${name} private import check had unrelated diagnostics`,
      );
    }
    const entryProbe = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
for (const entry of ${JSON.stringify(entries)}) await import('@agent-ppt/harness/' + entry);
for (const entry of ${JSON.stringify(privateEntries)}) {
  await assert.rejects(() => import(entry), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}
const require = createRequire(import.meta.url);
for (const forbidden of ['electron', 'openai', 'better-sqlite3', 'sqlite3']) {
  assert.throws(() => require.resolve(forbidden), { code: 'MODULE_NOT_FOUND' });
}
console.log(JSON.stringify({ publicEntries: 'resolved', privateImports: 'rejected', productionDependencies: 'absent' }));
`;
    await writeFile(path.join(project, "probe.mjs"), entryProbe);
    const probe = JSON.parse(
      (
        await runNode(["probe.mjs"], project, "Resolve public entries with native Node", {
          diagnostics: true,
        })
      ).stdout,
    );
    const runtime = JSON.parse(
      (
        await runNode(
          [path.join("compiled", "consumer.js")],
          project,
          "Run native Node packed consumer",
          { diagnostics: true },
        )
      ).stdout,
    );
    return {
      package: "@agent-ppt/harness@0.1.0",
      packedWorkspace: true,
      isolatedTarballInstall: true,
      installationScripts: false,
      declarationConsumers: ["NodeNext", "Bundler/DOM"],
      skipLibCheck: false,
      dependencies: [...installed].sort(),
      ...probe,
      ...runtime,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  const evidence = await main();
  console.log(JSON.stringify({ ...evidence, temporaryArtifactsRemoved: true }));
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "Packed consumer verification failed",
    }),
  );
  process.exitCode = 1;
}
