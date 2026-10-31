import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";

interface ProcessOutput {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly records: readonly Record<string, unknown>[];
}
const desktopAvailable =
  process.platform === "win32" || process.platform === "darwin" || Boolean(process.env.DISPLAY);

describe.skipIf(!desktopAvailable)("independent Electron Main CLI", () => {
  it("starts without an ESM-ready deadlock and consumes piped approval after reopening real encrypted configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "general-agent-cli-"));
    const dataRoot = join(directory, "data");
    const workspace = join(directory, "workspace");
    let seedBuild: string | undefined;
    const require = createRequire(import.meta.url);
    const electron = require("electron") as string;
    const key = "isolated-cli-integration-credential";
    const requests: Array<Record<string, unknown>> = [];
    const serverErrors: string[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        expect(request.headers.authorization).toBe(`Bearer ${key}`);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requests.push(body);
        const messages = body.messages as Array<{ role: string; content: string }>;
        let message: Record<string, unknown>;
        if (messages.at(-1)?.role === "tool") {
          expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({
            path: "notes.txt",
            content: "revision created after approval request",
          });
          expect(JSON.parse(messages.at(-1)!.content)).toMatchObject({
            startOffset: 0,
            endOffset: "revision created after approval request".length,
            hasMore: false,
            version: expect.any(String),
          });
          message = { role: "assistant", content: "The approved notes.txt was read." };
        } else
          message = {
            role: "assistant",
            content: "Need read approval.",
            reasoning_content: "private-replay-marker",
            tool_calls: [
              {
                id: "read-integration",
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: "notes.txt" }) },
              },
            ],
          };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: `chat-${requests.length}`,
            object: "chat.completion",
            created: 1,
            model: "integration-remote",
            choices: [
              { index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" },
            ],
            usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
          }),
        );
      })().catch((error: unknown) => {
        serverErrors.push(error instanceof Error ? error.message : "HTTP assertion failed");
        response.writeHead(500);
        response.end("{}");
      });
    });
    try {
      await mkdir(workspace);
      await writeFile(join(workspace, "notes.txt"), "before approval", "utf8");
      const listening = once(server, "listening");
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected local HTTP address");
      const endpoint = `http://127.0.0.1:${address.port}/v1`;
      const environment = {
        ...process.env,
        AGENT_PPT_DATA_DIR: dataRoot,
        AGENT_DEV_TEST_ENDPOINT: endpoint,
        AGENT_DEV_TEST_KEY: key,
        AGENT_LOG_FILE: "false",
      };
      for (const name of [
        "ELECTRON_RUN_AS_NODE",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
      ])
        delete environment[name as keyof typeof environment];
      const run = async (
        executable: string,
        args: readonly string[],
        input = "",
      ): Promise<ProcessOutput> => {
        // 原生期限只回收卡住的真实 Electron 子进程；正常路径等待 exit，不依赖睡眠。
        const child = spawn(executable, [...args], {
          cwd: process.cwd(),
          env: environment,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 15000,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (part: string) => {
          stdout += part;
        });
        child.stderr.on("data", (part: string) => {
          stderr += part;
        });
        child.stdin.end(input);
        const [code] = (await once(child, "exit")) as [number | null];
        return {
          code,
          stdout,
          stderr,
          records: stdout
            .split(/\r?\n/)
            .filter((line) => line.startsWith("{"))
            .map((line) => JSON.parse(line) as Record<string, unknown>),
        };
      };
      const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
        dependencies: Record<string, string>;
      };
      const dependencies = Object.keys(manifest.dependencies);
      const builtins = new Set(builtinModules);
      const cacheRoot = resolve(".vite/agent-dev");
      await mkdir(cacheRoot, { recursive: true });
      seedBuild = await mkdtemp(join(cacheRoot, "seed-"));
      await build({
        configFile: false,
        resolve: {
          alias: {
            "@shared": resolve("src/shared"),
            "@ppt": resolve("src/ppt"),
            "@main": resolve("src/main"),
            "@design-system": resolve("src/design-system"),
          },
        },
        build: {
          ssr: true,
          target: "node24",
          outDir: seedBuild,
          emptyOutDir: false,
          rollupOptions: {
            input: resolve("tests/fixtures/general-agent-configuration-seed.ts"),
            external: (id) =>
              id === "electron" ||
              id.startsWith("node:") ||
              builtins.has(id) ||
              dependencies.some((name) => id === name || id.startsWith(`${name}/`)),
            output: { format: "es", entryFileNames: "integration-seed.mjs" },
          },
        },
      });
      const seed = await run(electron, [join(seedBuild, "integration-seed.mjs")]);
      expect(seed.code, seed.stderr + seed.stdout).toBe(0);
      expect(seed.records).toContainEqual({ type: "seeded", configured: true });
      expect(await readFile(join(dataRoot, "credentials.v2.json"), "utf8")).not.toContain(key);
      const common = [
        "scripts/run-agent.mjs",
        "--model",
        "integration-configured",
        "--workspace",
        workspace,
        "--thread",
        "integration-thread",
      ];
      const waiting = await run(process.execPath, [
        ...common,
        "--prompt",
        "Read notes.txt",
        "--query",
        "integration-query",
      ]);
      expect(waiting.code, waiting.stderr + waiting.stdout).toBe(0);
      expect(waiting.records).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "result", status: "waiting" })]),
      );
      expect(waiting.records).toContainEqual(
        expect.objectContaining({
          type: "approval",
          tool: "read",
          path: "notes.txt",
        }),
      );
      expect(requests).toHaveLength(1);
      await writeFile(
        join(workspace, "notes.txt"),
        "revision created after approval request",
        "utf8",
      );
      const resumed = await run(
        process.execPath,
        [...common, "--resume", "integration-query"],
        "yes\n",
      );
      expect(resumed.code, resumed.stderr + resumed.stdout).toBe(0);
      expect(resumed.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "result", status: "completed" }),
          expect.objectContaining({
            type: "tool.completed",
            tool: "read",
            status: "succeeded",
            effects: "none",
          }),
        ]),
      );
      expect(requests).toHaveLength(2);
      for (const output of [waiting, resumed]) {
        expect(output.stdout + output.stderr).not.toContain(key);
        expect(output.stdout + output.stderr).not.toContain("private-replay-marker");
        expect(output.stdout).not.toContain("replayState");
      }
      expect(serverErrors).toEqual([]);
      expect(await readdir(workspace)).toEqual(["notes.txt"]);
    } finally {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
      await rm(directory, { recursive: true, force: true });
      if (seedBuild) await rm(seedBuild, { recursive: true, force: true });
    }
  }, 60000);
});
