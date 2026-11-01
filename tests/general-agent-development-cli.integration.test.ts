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
  it("starts the real runner without an ESM-ready deadlock and reads automatically after reopening encrypted configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "general-agent-cli-"));
    const dataRoot = join(directory, "data");
    const workspace = join(directory, "workspace");
    let seedBuild: string | undefined;
    const require = createRequire(import.meta.url);
    const electron = require("electron") as string;
    const key = "isolated-cli-integration-credential";
    const notes = "Real workspace text read without approval.";
    const requests: Array<Record<string, unknown>> = [];
    const serverErrors: string[] = [];
    const reasoning = {
      id: "reasoning-integration",
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text: "private-replay-marker" }],
    };
    const call = {
      id: "function-integration",
      type: "function_call",
      call_id: "read-integration",
      name: "read",
      arguments: JSON.stringify({ path: "notes.txt" }),
      status: "completed",
    };
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        expect(request.headers.authorization).toBe(`Bearer ${key}`);
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/responses");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requests.push(body);
        expect(body.model).toBe("mimo-v2.6-flash");
        expect(body.stream).toBe(true);
        expect(body.reasoning).toEqual({ effort: "high" });
        const input = body.input as Array<Record<string, unknown>>;
        const result = input.at(-1)?.type === "function_call_output" ? input.at(-1) : undefined;
        let output: Record<string, unknown>[];
        if (result) {
          expect(input).toContainEqual(reasoning);
          expect(input).toContainEqual(call);
          expect(input.slice(-3)).toEqual([reasoning, call, result]);
          expect(result.call_id).toBe(call.call_id);
          const text = Array.isArray(result.output)
            ? result.output.map((part) => String((part as Record<string, unknown>).text)).join("\n")
            : String(result.output);
          expect(JSON.parse(text)).toMatchObject({
            path: "notes.txt",
            content: notes,
            startOffset: 0,
            endOffset: notes.length,
            hasMore: false,
            version: expect.any(String),
          });
          output = [
            {
              id: "message-integration",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "The workspace notes.txt was read.",
                  annotations: [],
                },
              ],
            },
          ];
        } else output = [reasoning, call];
        const final = {
          id: `resp-${requests.length}`,
          object: "response",
          status: "completed",
          model: "mimo-v2.6-flash",
          output,
          usage: {
            input_tokens: 8,
            output_tokens: 4,
            output_tokens_details: { reasoning_tokens: 2 },
          },
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [index, item] of output.entries()) {
          const initial = {
            ...item,
            status: "in_progress",
            ...(item.type === "message" || item.type === "reasoning" ? { content: [] } : {}),
            ...(item.type === "function_call" ? { arguments: "" } : {}),
          };
          for (const event of [
            { type: "response.output_item.added", output_index: index, item: initial },
            { type: "response.output_item.done", output_index: index, item },
          ])
            response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        response.end(
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: final })}\n\ndata: [DONE]\n\n`,
        );
      })().catch((error: unknown) => {
        serverErrors.push(error instanceof Error ? error.message : "HTTP assertion failed");
        response.writeHead(500);
        response.end("{}");
      });
    });
    try {
      await mkdir(workspace);
      await writeFile(join(workspace, "notes.txt"), notes, "utf8");
      const listening = once(server, "listening");
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected local HTTP address");
      const endpoint = `http://127.0.0.1:${address.port}/v1`;
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_PPT_DATA_DIR: dataRoot,
        AGENT_DEV_TEST_ENDPOINT: endpoint,
        AGENT_DEV_TEST_KEY: key,
      };
      for (const name of [
        "ELECTRON_RUN_AS_NODE",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
      ])
        delete environment[name as keyof typeof environment];
      const run = async (args: readonly string[], input = ""): Promise<ProcessOutput> => {
        // 原生期限只回收卡住的真实 Electron 子进程；正常路径等待 exit，不依赖睡眠。
        const child = spawn(electron, [join(seedBuild!, "integration-seed.mjs"), ...args], {
          cwd: process.cwd(),
          env: environment,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          timeout: 15000,
        });
        let stdout = "";
        let stderr = "";
        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        child.stdout!.on("data", (part: string) => {
          stdout += part;
        });
        child.stderr!.on("data", (part: string) => {
          stderr += part;
        });
        child.on("message", (message) => {
          if (
            message &&
            typeof message === "object" &&
            "type" in message &&
            message.type === "agent-dev.ready"
          ) {
            child.send({ type: "agent-dev.context", workspaceRoot: workspace, interactive: false });
            if (input) child.send({ type: "agent-dev.input", text: input });
            child.send({ type: "agent-dev.end" });
          }
        });
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
            "@app": resolve("app"),
            "@shared": resolve("src/shared"),
            "@ppt": resolve("src/ppt"),
            "@main": resolve("app/main"),
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
      const seed = await run(["seed"]);
      expect(seed.code, seed.stderr + seed.stdout).toBe(0);
      expect(seed.records).toContainEqual({ type: "seeded", configured: true });
      expect(await readFile(join(dataRoot, "credentials.v2.json"), "utf8")).not.toContain(key);
      const settingsBeforeHelp = await readFile(join(dataRoot, "agent-settings.json"), "utf8");
      const credentialsBeforeHelp = await readFile(join(dataRoot, "credentials.v2.json"), "utf8");
      const helped = await run(["--help"]);
      expect(helped.code, helped.stderr + helped.stdout).toBe(0);
      expect(helped.stdout).toContain("--prompt");
      expect(helped.stdout + helped.stderr).not.toContain(key);
      expect(requests).toEqual([]);
      expect(await readFile(join(dataRoot, "agent-settings.json"), "utf8")).toBe(
        settingsBeforeHelp,
      );
      expect(await readFile(join(dataRoot, "credentials.v2.json"), "utf8")).toBe(
        credentialsBeforeHelp,
      );
      // 直接运行真实 Electron runner，以 IPC 上下文指定工作区并模拟管道 EOF。
      const executed = await run(["--prompt", "Read notes.txt"]);
      expect(executed.code, executed.stderr + executed.stdout).toBe(0);
      expect(executed.records.some((record) => record.type === "approval")).toBe(false);
      expect(executed.records).toEqual(
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
      const completed = executed.records.filter((record) => record.type === "result").at(-1);
      if (!completed) throw new Error("Expected execution result");
      expect(executed.records.filter((record) => record.type === "result")).toEqual([
        expect.objectContaining({
          status: "completed",
          queryId: expect.any(String),
        }),
      ]);
      expect((completed.messages as Record<string, unknown>[]).at(-1)).toEqual({
        role: "assistant",
        text: "The workspace notes.txt was read.",
      });
      expect(requests).toHaveLength(2);
      for (const output of [executed]) {
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
