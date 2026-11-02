import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this script through npm run package:cli.");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const output = join(root, "dist", "cli");
const temporary = await mkdtemp(join(tmpdir(), "agent-harness-cli-package-"));

function npm(args, cwd) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

try {
  const staging = join(temporary, "package");
  const vendor = join(staging, "vendor");
  await mkdir(vendor, { recursive: true });
  await mkdir(output, { recursive: true });
  const dependencies = {};
  // 私有包随 CLI 捆绑发布，消费方不依赖仓库链接或未发布的 registry 包。
  for (const workspace of manifest.workspaces) {
    const directory = resolve(root, workspace);
    const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    const [packed] = JSON.parse(
      npm(["pack", "--ignore-scripts", "--json", "--pack-destination", vendor], directory),
    );
    dependencies[pkg.name] = `file:vendor/${packed.filename}`;
  }
  for (const name of ["@incremark/core", "string-width", "zod"]) {
    dependencies[name] = lock.packages[`node_modules/${name}`].version;
  }
  await cp(join(root, "cli", "dist"), join(staging, "dist"), { recursive: true });
  await mkdir(join(staging, "bin"));
  await writeFile(
    join(staging, "bin", "agent-harness.js"),
    '#!/usr/bin/env node\nimport { runCli } from "../dist/main.js";\nprocess.exitCode = await runCli(process.argv.slice(2));\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(staging, "package.json"),
    `${JSON.stringify(
      {
        name: "agent-harness-cli",
        version: manifest.version,
        private: true,
        type: "module",
        license: "UNLICENSED",
        engines: { node: ">=24" },
        bin: { "agent-harness": "bin/agent-harness.js" },
        files: ["bin", "dist"],
        dependencies,
        bundledDependencies: Object.keys(dependencies),
      },
      null,
      2,
    )}\n`,
  );
  npm(
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"],
    staging,
  );
  const filename = npm(
    ["pack", "--ignore-scripts", "--silent", "--pack-destination", output],
    staging,
  ).trim();
  // 从最终归档离线安装并启动，避免只验证仓库中的 workspace 依赖。
  const prefix = join(temporary, "installed");
  npm(
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--offline",
      "--cache",
      join(temporary, "offline-cache"),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(output, filename),
    ],
    temporary,
  );
  const installed = join(
    prefix,
    process.platform === "win32" ? "node_modules" : "lib/node_modules",
    "agent-harness-cli",
  );
  const launcher = join(installed, "bin", "agent-harness.js");
  execFileSync(process.execPath, [launcher, "--help"], { cwd: temporary, stdio: "inherit" });
  // 加载真实宿主依赖，但使用空配置数据根，不调用远程模型或读取用户凭据。
  const probe = spawnSync(
    process.execPath,
    [launcher, "--prompt", "packaging smoke", "--tools", "none", "--output", "jsonl"],
    {
      cwd: temporary,
      encoding: "utf8",
      env: { ...process.env, AGENT_HARNESS_CLI_DATA_DIR: join(temporary, "data") },
    },
  );
  assert.equal(probe.status, 1, "Isolated CLI must reject missing model configuration.");
  const records = probe.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(
    records.some(
      (record) => record.type === "error" && record.error?.code === "CLI_MODEL_SETUP_REQUIRED",
    ),
    "Packaged CLI must load its real host before reporting missing configuration.",
  );
  console.log(`CLI package verified: ${join(output, filename)}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
