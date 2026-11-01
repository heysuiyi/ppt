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
const entries = ["log-contract", "logs", "node-logs"];
const privateEntries = [
  "@agent-harness/logs",
  "@agent-harness/logs/package.json",
  "@agent-harness/logs/internal/log-runtime",
  "@agent-harness/logs/dist/logs.js",
  "@agent-harness/logs/dist/internal/log-safety.js",
  "@agent-harness/logs/src/logs.ts",
];
const oldEntries = [
  "@agent-ppt/logs",
  ...entries.map((entry) => `@agent-ppt/logs/${entry}`),
  ...privateEntries
    .slice(1)
    .map((entry) => entry.replace("@agent-harness/logs/", "@agent-ppt/logs/")),
];

// Same npm-cli discovery as verify-harness-package: never interpolate a Windows shell command.
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
        /* Not an npm directory. */
      }
    }
  for (const candidate of candidates) {
    if (!candidate || path.basename(candidate).toLowerCase() !== "npm-cli.js") continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try next location. */
    }
  }
  throw new Error("Cannot locate npm-cli.js; install npm alongside Node or run through npm.");
}
const childEnvironment = { ...process.env };
for (const key of Object.keys(childEnvironment))
  if (["node_path", "node_options"].includes(key.toLowerCase())) delete childEnvironment[key];
function runNode(args, cwd, label, { allowFailure = false, diagnostics = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: childEnvironment,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () => reject(new Error(`${label}: could not start Node`)));
    child.on("close", (code) =>
      code !== 0 && !allowFailure
        ? reject(new Error(`${label}: exited ${code}${diagnostics ? `\n${stdout}${stderr}` : ""}`))
        : resolve({ code, stdout, stderr }),
    );
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
    const file = path.join(directory, entry.name);
    const stat = await lstat(file);
    assert(!stat.isSymbolicLink(), `Packed install contains a symlink: ${entry.name}`);
    if (stat.isDirectory()) await rejectLinks(file);
  }
}
const genericConsumer = `
import { createLogs } from '@agent-harness/logs/logs';
import type { Logger, LogRecord, Logs, NodeLogsOptions, NodeLogsSettings } from '@agent-harness/logs/log-contract';
const records: LogRecord[] = [];
const logs: Logs = createLogs({ outputs: [{ id: 'capture', minimumLevel: 'debug', exporter: { export(record) { records.push(record); }, async close() {} } }] });
const logger: Logger = logs.getLogger('consumer').child({ operation: 'compile' });
logger.info('consumer.ready', { value: document.title });
const structural: NodeLogsOptions = { directory: 'unused', terminal: { enabled: false }, file: { enabled: true } };
const settings = (value: NodeLogsSettings): number => value.recent.capacity;
void structural; void settings; void logs.close();
`;
const nodeConsumer = `
import { createLogs } from '@agent-harness/logs/logs';
import { createNodeLogs } from '@agent-harness/logs/node-logs';
import type { LogRecord, NodeLogs, Logger } from '@agent-harness/logs/log-contract';
const records: LogRecord[] = [];
const logs = createLogs({ outputs: [{ id: 'capture', minimumLevel: 'info', exporter: { export(record) { records.push(record); }, async close() {} } }] });
const logger: Logger = logs.getLogger('consumer');
const node: NodeLogs = await createNodeLogs({ directory: 'unused', terminal: { enabled: false }, file: { enabled: true } });
void logger; void node; void logs;
`;
const runtimeSource = `
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogs } from '@agent-harness/logs/logs';
import { createNodeLogs } from '@agent-harness/logs/node-logs';
for (const entry of ${JSON.stringify(entries)}) {
  const specifier = '@agent-harness/logs/' + entry;
  assert.equal(fileURLToPath(import.meta.resolve(specifier)), path.join(process.cwd(), 'node_modules/@agent-harness/logs/dist', entry + '.js'));
  await import(specifier);
}
for (const entry of ${JSON.stringify(privateEntries)}) await assert.rejects(() => import(entry), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
for (const entry of ${JSON.stringify(oldEntries)}) await assert.rejects(() => import(entry), { code: 'ERR_MODULE_NOT_FOUND' });
const records = [];
let closed = 0, failedClosed = 0;
const logs = createLogs({ outputs: [
  { id: 'capture', minimumLevel: 'debug', exporter: { export(record) { records.push(record); }, async close() { closed++; } } },
  { id: 'failure', minimumLevel: 'debug', exporter: { export() { throw new Error('export failure'); }, async close() { failedClosed++; } } }
] });
const context = { operation: 'before', sessionId: 'session', step: 1 };
const borrowed = logs.getLogger('acceptance').child(context);
context.operation = 'after';
for (const key of ['close', 'getStatus', 'updateSettings', 'clearFiles', 'getLogger']) assert.equal(key in borrowed, false);
const nested = { value: 'before' };
const data = { nested, password: 'private-password-value', url: 'https://user:private-userinfo@example.test/?token=private-query-value', text: 'Bearer private-bearer-value' };
let getterCalls = 0;
Object.defineProperty(data, 'getter', { enumerable: true, get() { getterCalls++; throw new Error('must not run'); } });
const cycle = {}; cycle.self = cycle; data.cycle = cycle;
assert.doesNotThrow(() => borrowed.info('acceptance.record', data));
nested.value = 'after';
assert.equal(getterCalls, 0);
assert.equal(records.length, 1);
const record = records[0];
assert.equal(record.schemaVersion, 1);
assert.equal(record.name, 'acceptance');
assert.equal(record.event, 'acceptance.record');
assert.equal(record.context.operation, 'before');
assert.equal(record.data.nested.value, 'before');
assert.equal(record.sequence, 1);
assert(Number.isFinite(Date.parse(record.timestamp)));
assert.equal(typeof record.instanceId, 'string');
assert(Object.isFrozen(record) && Object.isFrozen(record.context) && Object.isFrozen(record.data));
const serialized = JSON.stringify(record);
for (const secret of ['private-password-value', 'private-userinfo', 'private-query-value', 'private-bearer-value']) assert(!serialized.includes(secret), 'Secret survived logging transform');
const failure = logs.getStatus().outputs.find((output) => output.id === 'failure');
assert.equal(failure.failureCount, 1);
assert.equal(failure.lastFailure.operation, 'export');
const close = logs.close();
assert.strictEqual(logs.close(), close);
await close;
await logs.close();
assert.equal(closed, 1); assert.equal(failedClosed, 1);
assert.equal(logs.getStatus().state, 'closed');
borrowed.info('acceptance.late');
assert.equal(records.length, 1); assert.equal(logs.getStatus().lateWriteCount, 1);
let rejectedCloseCount = 0;
const badClose = createLogs({ outputs: [{ id: 'badclose', minimumLevel: 'info', exporter: { export() {}, async close() { rejectedCloseCount++; throw new Error('close failure'); } } }] });
await assert.rejects(badClose.close(), AggregateError);
await assert.rejects(badClose.close(), AggregateError);
assert.equal(rejectedCloseCount, 1);
assert.equal(badClose.getStatus().state, 'closed');
assert.equal(badClose.getStatus().outputs[0].lastFailure.operation, 'close');
const directory = path.join(process.cwd(), 'log-output');
const node = await createNodeLogs({ directory, terminal: { enabled: false }, file: { enabled: true, minimumLevel: 'debug' }, recent: { enabled: true, minimumLevel: 'debug', capacity: 10 } });
try {
  const logger = node.getLogger('node_acceptance').child({ operation: 'file' });
  logger.info('node.first', { password: 'node-private-value', value: 42 });
  const recent = node.getRecentEntries();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].event, 'node.first');
  const status = await node.getFileStatus();
  const files = await readdir(status.directory);
  const lines = (await Promise.all(files.map((name) => readFile(path.join(status.directory, name), 'utf8')))).join('').trim().split('\\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(lines, JSON.parse(JSON.stringify(recent)));
  assert(!JSON.stringify(lines).includes('node-private-value'));
  assert(status.fileCount >= 1 && status.totalBytes > 0);
  assert.equal(status.failureCount, 0);
  const changed = await node.updateSettings({ file: { minimumLevel: 'error' }, recent: { minimumLevel: 'warn', capacity: 2 } });
  assert.equal(changed.file.minimumLevel, 'error'); assert.equal(node.getSettings().recent.capacity, 2);
  logger.info('node.filtered');
  assert.equal(node.getRecentEntries().length, 1);
  logger.error('node.second', { value: 43 });
  assert.equal(node.getRecentEntries()[0].event, 'node.second');
  const currentPath = path.join(status.directory, files[0]);
  const currentBeforeClear = await readFile(currentPath, 'utf8');
  await writeFile(path.join(status.directory, 'diagnostic-2000-01-01.jsonl'), '{}\\n');
  assert.equal(await node.clearFiles(), 1);
  assert.equal((await node.getFileStatus()).fileCount, status.fileCount);
  assert.equal(await readFile(currentPath, 'utf8'), currentBeforeClear);
  logger.error('node.after_clear');
  assert((await node.getFileStatus()).totalBytes > 0);
} finally { await node.close(); }
await node.close();
assert.equal(node.getStatus().state, 'closed');
await assert.rejects(node.updateSettings({ recent: { capacity: 3 } }));
await assert.rejects(node.clearFiles());
console.log(JSON.stringify({ publicEntries: 'resolved', privateImports: 'rejected', oldAliases: 'absent', snapshotsAndSecurity: true, exporterFailureContained: true, borrowedLoggerHasNoManagement: true, ownedExportersClosedOnce: true, nodeFileRecentSettingsClear: true }));
`;

async function main() {
  assert(Number(process.versions.node.split(".")[0]) >= 24, "Node 24 or newer is required");
  const npmCli = await findNpmCli();
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-harness-logs-package-"));
  try {
    assert(
      !within(await realpath(repositoryRoot), await realpath(temporaryRoot)),
      "Consumer must be outside repository",
    );
    const project = path.join(temporaryRoot, "consumer");
    await mkdir(project);
    const npm = (args, cwd, label) => runNode([npmCli, ...args], cwd, label);
    const packed = JSON.parse(
      (
        await npm(
          [
            "pack",
            path.join(repositoryRoot, "packages/logs"),
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            temporaryRoot,
          ],
          temporaryRoot,
          "Pack already-built logs package",
        )
      ).stdout,
    );
    assert(
      Array.isArray(packed) && packed.length === 1 && typeof packed[0].filename === "string",
      "Missing packed tarball",
    );
    const tarball = path.resolve(temporaryRoot, packed[0].filename);
    assert(within(temporaryRoot, tarball), "Tarball escaped temporary directory");
    await access(tarball);
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify({
        name: "agent-harness-logs-packed-consumer",
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
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        tarball,
      ],
      project,
      "Install real tarball outside repository",
    );
    await rejectLinks(path.join(project, "node_modules"));
    const tree = JSON.parse(
      (await npm(["ls", "--all", "--json"], project, "Inspect installed closure")).stdout,
    );
    assert.deepEqual(Object.keys(tree.dependencies ?? {}), ["@agent-harness/logs"]);
    const dependency = tree.dependencies["@agent-harness/logs"];
    assert(
      !dependency.missing &&
        !dependency.invalid &&
        !Object.keys(dependency.dependencies ?? {}).length,
      "Logs must have zero runtime dependencies",
    );
    const installed = path.join(project, "node_modules/@agent-harness/logs");
    assert(
      within(await realpath(temporaryRoot), await realpath(installed)),
      "Install resolved back to repository",
    );
    const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
    assert.equal(manifest.name, "@agent-harness/logs");
    assert.equal(manifest.version, "0.1.0");
    assert.equal(manifest.private, true);
    assert.equal(manifest.type, "module");
    assert.equal(manifest.engines?.node, ">=24");
    for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"])
      assert.equal(Object.keys(manifest[kind] ?? {}).length, 0);
    assert.deepEqual(
      Object.keys(manifest.exports).sort(),
      entries.map((entry) => `./${entry}`).sort(),
    );
    for (const entry of entries)
      assert.deepEqual(manifest.exports[`./${entry}`], {
        types: `./dist/${entry}.d.ts`,
        import: `./dist/${entry}.js`,
      });
    const compiler = path.join(repositoryRoot, "node_modules/typescript/bin/tsc");
    await access(compiler);
    await writeFile(path.join(project, "generic.ts"), genericConsumer);
    await writeFile(path.join(project, "node.ts"), nodeConsumer);
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
      [
        "nodenext",
        "NodeNext",
        "NodeNext",
        "node.ts",
        { types: ["node"], typeRoots: [path.join(repositoryRoot, "node_modules/@types")] },
      ],
      ["nodenext-generic", "NodeNext", "NodeNext", "generic.ts", {}],
    ]) {
      const config = `tsconfig.${name}.json`;
      await writeFile(
        path.join(project, config),
        JSON.stringify({
          compilerOptions: { ...base, module, moduleResolution, ...extra },
          files: [file],
        }),
      );
      await runNode(
        [compiler, "-p", config, "--pretty", "false"],
        project,
        `Compile isolated ${name} consumer`,
        { diagnostics: true },
      );
      await writeFile(
        path.join(project, "private.ts"),
        privateEntries
          .map(
            (entry, index) =>
              `import type * as Private${index} from ${JSON.stringify(entry)}; export type Rejected${index} = typeof Private${index};`,
          )
          .join("\n"),
      );
      const negativeConfig = `tsconfig.${name}.private.json`;
      await writeFile(
        path.join(project, negativeConfig),
        JSON.stringify({
          compilerOptions: { ...base, module, moduleResolution, ...extra },
          files: ["private.ts"],
        }),
      );
      const rejected = await runNode(
        [compiler, "-p", negativeConfig, "--pretty", "false"],
        project,
        `Reject ${name} private imports`,
        { allowFailure: true },
      );
      assert(rejected.code !== 0, "Private imports compiled");
      for (const entry of privateEntries)
        assert(rejected.stdout.includes(`'${entry}'`), `Missing rejection for ${entry}`);
      const codes = [...rejected.stdout.matchAll(/error TS(\d+):/g)].map((match) => match[1]);
      assert(
        codes.length > 0 && codes.every((code) => code === "2307"),
        "Private import check had unrelated diagnostics",
      );
    }
    await writeFile(path.join(project, "runtime.mjs"), runtimeSource);
    const runtime = JSON.parse(
      (
        await runNode(["runtime.mjs"], project, "Run native Node packed logging acceptance", {
          diagnostics: true,
        })
      ).stdout,
    );
    return {
      package: "@agent-harness/logs@0.1.0",
      packedAlreadyBuiltPackage: true,
      isolatedOfflineInstall: true,
      installationScripts: false,
      runtimeDependencies: [],
      declarationConsumers: ["NodeNext", "Bundler/DOM types:[]", "NodeNext types:[]"],
      skipLibCheck: false,
      nodeConsumerTypes:
        "Repository compiler-side @types/node only; not installed as a package runtime dependency",
      ...runtime,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
try {
  console.log(JSON.stringify({ ...(await main()), temporaryArtifactsRemoved: true }));
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "Packed logs verification failed",
    }),
  );
  process.exitCode = 1;
}
