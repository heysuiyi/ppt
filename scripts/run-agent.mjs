import { execFileSync, spawn } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoot = process.env.INIT_CWD || process.cwd();
const require = createRequire(import.meta.url);
const electron = require("electron");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const dependencies = Object.keys(manifest.dependencies);
const builtins = new Set(builtinModules);
if (process.platform === "win32") {
  try { execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "chcp 65001"], { stdio: ["inherit", "ignore", "pipe"], windowsHide: true }); }
  catch { console.warn("[agent:dev] 无法设置终端 UTF-8；日志文件仍使用 UTF-8。"); }
}
// 不写 out/**，避免开发入口混进生产安装包；每次启动使用独立目录。
const cacheRoot = join(root, ".vite/agent-dev");
await mkdir(cacheRoot, { recursive: true });
const buildRoot = await mkdtemp(join(cacheRoot, "run-"));
try {
await build({
  configFile: false, root,
  resolve: { alias: { "@shared": resolve(root, "src/shared"), "@ppt": resolve(root, "src/ppt"), "@main": resolve(root, "src/main"), "@design-system": resolve(root, "src/design-system") } },
  build: {
    ssr: true, target: "node24", outDir: buildRoot, emptyOutDir: true,
    rollupOptions: {
      input: join(root, "src/main/agent-host/development-runner.ts"),
      external: (id) => id === "electron" || id.startsWith("node:") || builtins.has(id) || dependencies.some((name) => id === name || id.startsWith(`${name}/`)),
      output: { format: "es", entryFileNames: "agent-dev.mjs" },
    },
  },
});
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
// Windows Electron Main 的 stdin 不可靠；输入与控制信号统一走就绪后的父子 IPC。
const child = spawn(electron, [join(buildRoot, "agent-dev.mjs"), ...process.argv.slice(2)], { cwd: root, stdio: ["ignore", "inherit", "inherit", "ipc"], env: environment });
let stopping = false;
let terminal;
const send = (message, callback) => {
  if (!child.connected) return;
  child.send(message, (error) => {
    if (error && child.connected) {
      console.error("[agent:dev] 无法向开发入口传递输入。");
      process.exitCode = 1;
    }
    callback?.();
  });
};
const forwardInput = (text) => {
  process.stdin.pause();
  send({ type: "agent-dev.input", text }, () => { if (child.connected && !stopping) process.stdin.resume(); });
};
const endInput = () => send({ type: "agent-dev.end" });
const interrupt = () => { stopping = true; send({ type: "agent-dev.cancel" }); terminal?.close(); process.stdin.pause(); };
const terminate = () => { stopping = true; send({ type: "agent-dev.shutdown" }); terminal?.close(); process.stdin.pause(); };
child.on("message", (message) => {
  if (message?.type !== "agent-dev.ready") return;
  send({ type: "agent-dev.context", workspaceRoot, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
  process.stdin.setEncoding("utf8");
  if (process.stdin.isTTY) {
    terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    terminal.on("line", (text) => send({ type: "agent-dev.input", text: `${text}\n` }));
    terminal.on("SIGINT", interrupt);
    terminal.on("close", endInput);
    if (stopping) terminal.close();
  } else {
    process.stdin.on("data", forwardInput);
    if (process.stdin.readableEnded) endInput();
    else {
      process.stdin.once("end", endInput);
      if (!stopping) process.stdin.resume();
    }
  }
});
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
  const [code, signal] = await once(child, "exit");
  process.exitCode = process.exitCode || code || (signal === "SIGINT" ? 130 : signal ? 1 : 0);
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  process.stdin.removeListener("data", forwardInput);
  process.stdin.removeListener("end", endInput);
  terminal?.close();
  process.stdin.pause();
}
} finally {
  await rm(buildRoot, { recursive: true, force: true });
}
