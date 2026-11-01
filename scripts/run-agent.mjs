import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPackages } from "./workspace-build.mjs";

// Only build orchestration lives here; the compiled Node entry owns stdin/signals.
// Development emit never removes or changes the production CLI artifact.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
buildPackages({ stderr: true });
const cache = join(root, ".vite", "cli-dev");
await mkdir(cache, { recursive: true });
const buildRoot = await mkdtemp(join(cache, "run-"));
try {
  execFileSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "-p",
      join(root, "cli", "tsconfig.json"),
      "--outDir",
      buildRoot,
      "--declaration",
      "false",
    ],
    {
      cwd: root,
      stdio: ["ignore", 2, 2],
    },
  );
  if (!process.env.AGENT_HARNESS_CLI_DATA_DIR?.trim()) {
    process.env.AGENT_HARNESS_CLI_DATA_DIR = join(homedir(), ".agent-harness", "cli-development");
  }
  const { runCli } = await import(pathToFileURL(join(buildRoot, "main.js")).href);
  process.exitCode = await runCli(process.argv.slice(2));
} finally {
  await rm(buildRoot, { recursive: true, force: true });
}
