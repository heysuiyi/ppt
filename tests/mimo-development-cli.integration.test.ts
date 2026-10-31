import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const desktopAvailable =
  process.platform === "win32" || process.platform === "darwin" || Boolean(process.env.DISPLAY);
describe.skipIf(!desktopAvailable)("native MiMo Electron development entry", () => {
  it("discovers with encrypted credentials and preserves waiting, replay, refusal and cancellation across processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mimo-cli-"));
    const root = join(directory, "data");
    const workspace = join(directory, "workspace");
    const nonce = randomUUID();
    const requests: Record<string, unknown>[] = [];
    const serverErrors: string[] = [];
    let expectedKey = "tp-isolated-native-integration";
    const reasoning = {
      id: "reasoning-native",
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text: "private-native-replay" }],
    };
    const call = {
      id: "function-native",
      type: "function_call",
      call_id: "read-native",
      name: "read",
      arguments: '{"path":"notes.txt"}',
      status: "completed",
    };
    const server = createServer((request, response) => {
      void (async () => {
        expect(request.headers.authorization).toBe(`Bearer ${expectedKey}`);
        if (request.url === "/v1/models") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              object: "list",
              data: [{ id: "mimo-v2.6-flash", object: "model", owned_by: "mimo" }],
            }),
          );
          return;
        }
        expect(request.url).toBe("/v1/responses");
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requests.push(body);
        expect(body.model).toBe("mimo-v2.6-flash");
        expect(body.reasoning).toEqual({ effort: "high" });
        const input = body.input as Array<Record<string, unknown>>;
        const result = input.at(-1)?.type === "function_call_output" ? input.at(-1) : undefined;
        let output: Record<string, unknown>[];
        if (result) {
          expect(input).toContainEqual(reasoning);
          expect(input).toContainEqual(call);
          const text = Array.isArray(result.output)
            ? result.output.map((part) => String((part as Record<string, unknown>).text)).join("\n")
            : String(result.output);
          // 拒绝不读取工作区，批准后的结果必须来自审批之后的真实磁盘版本。
          if (!text.includes(nonce)) expect(text).not.toContain("before approval");
          output = [
            {
              id: "message-native",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: text.includes(nonce) ? `verified ${nonce}` : "Tool denied; no file read.",
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
            input_tokens: 12,
            output_tokens: 7,
            output_tokens_details: { reasoning_tokens: 4 },
          },
        };
        if (body.stream) {
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
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(final));
        }
      })().catch((error: unknown) => {
        serverErrors.push(
          error instanceof Error ? error.message : "HTTP consumer assertion failed",
        );
        response.writeHead(500);
        response.end("{}");
      });
    });
    let buildRoot: string | undefined;
    try {
      await mkdir(workspace);
      await writeFile(join(workspace, "notes.txt"), "before approval", "utf8");
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected HTTP endpoint");
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_PPT_DATA_DIR: root,
        MIMO_TEST_HTTP_ENDPOINT: `http://127.0.0.1:${address.port}/v1`,
      };
      delete environment.ELECTRON_RUN_AS_NODE;
      const electron = createRequire(import.meta.url)("electron") as string;
      const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
        dependencies: Record<string, string>;
      };
      const dependencies = Object.keys(manifest.dependencies);
      const builtins = new Set(builtinModules);
      await mkdir(resolve(".vite/agent-dev"), { recursive: true });
      buildRoot = await mkdtemp(resolve(".vite/agent-dev/mimo-integration-"));
      await build({
        configFile: false,
        resolve: {
          alias: {
            "@shared": resolve("src/shared"),
            "@main": resolve("src/main"),
            "@ppt": resolve("src/ppt"),
            "@design-system": resolve("src/design-system"),
          },
        },
        build: {
          ssr: true,
          target: "node24",
          outDir: buildRoot,
          emptyOutDir: false,
          rollupOptions: {
            input: resolve("tests/fixtures/mimo-development-entry.ts"),
            external: (id) =>
              id === "electron" ||
              id.startsWith("node:") ||
              builtins.has(id) ||
              dependencies.some((name) => id === name || id.startsWith(`${name}/`)),
            output: { format: "es", entryFileNames: "mimo-entry.mjs" },
          },
        },
      });
      const run = async (args: string[], input = "") => {
        const child = spawn(electron, [join(buildRoot!, "mimo-entry.mjs"), ...args], {
          env: environment,
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          timeout: 20000,
        });
        let stdout = "";
        let stderr = "";
        child.stdout!.on("data", (part) => {
          stdout += String(part);
        });
        child.stderr!.on("data", (part) => {
          stderr += String(part);
        });
        child.on("message", (message) => {
          if (
            message &&
            typeof message === "object" &&
            "type" in message &&
            message.type === "agent-dev.ready"
          ) {
            if (input) child.send({ type: "agent-dev.input", text: input });
            child.send({ type: "agent-dev.end" });
          }
        });
        const [code] = await once(child, "exit");
        const records = stdout
          .split(/\r?\n/)
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(stdout + stderr).not.toContain("tp-isolated-native-integration");
        expect(stdout + stderr).not.toContain("tp-rotated-native-integration");
        expect(stdout + stderr).not.toContain("private-native-replay");
        return { code, records, diagnostic: stdout + stderr };
      };
      const seed = await run(["seed"]);
      expect(seed.code, seed.diagnostic).toBe(0);
      expect(seed.records).toContainEqual({ type: "seeded", models: ["mimo-v2.6-flash"] });
      expect(await readFile(join(root, "credentials.v2.json"), "utf8")).not.toContain(
        "tp-isolated-native-integration",
      );
      const common = [
        "--model",
        "mimo-configured",
        "--workspace",
        workspace,
        "--thread",
        "mimo-thread",
      ];
      const waiting = await run([...common, "--prompt", "Read notes.txt", "--query", "approved"]);
      expect(waiting.code, waiting.diagnostic).toBe(0);
      const waitingResult = waiting.records.find((record) => record.type === "result");
      expect(waitingResult).toMatchObject({ status: "waiting", queryId: "approved" });
      expect(requests).toHaveLength(1);
      const persistedWaiting = await run(["inspect", "approved"]);
      expect(persistedWaiting.code, persistedWaiting.diagnostic).toBe(0);
      expect(persistedWaiting.records).toContainEqual(
        expect.objectContaining({ type: "checkpoint", status: "waiting", leaseReleased: true }),
      );
      for (const [mode, incompatible, original] of [
        ["set-effort", "medium", "high"],
        ["set-budget", "2048", "1024"],
      ]) {
        const changed = await run([mode, incompatible]);
        expect(changed.code, changed.diagnostic).toBe(0);
        const incompatibleResume = await run([...common, "--resume", "approved"], "yes\n");
        expect(incompatibleResume.code, incompatibleResume.diagnostic).toBe(1);
        expect(incompatibleResume.records).toContainEqual(
          expect.objectContaining({
            type: "error",
            error: expect.objectContaining({ code: "HOST_BINDING_CHANGED" }),
          }),
        );
        expect(requests).toHaveLength(1);
        const restored = await run([mode, original]);
        expect(restored.code, restored.diagnostic).toBe(0);
      }
      const rotated = await run(["rotate-key"]);
      expect(rotated.code, rotated.diagnostic).toBe(0);
      expectedKey = "tp-rotated-native-integration";
      await writeFile(join(workspace, "notes.txt"), nonce, "utf8");
      const resumed = await run([...common, "--resume", "approved"], "yes\n");
      expect(resumed.code, resumed.diagnostic).toBe(0);
      const completed = resumed.records.filter((record) => record.type === "result").at(-1);
      expect(completed).toMatchObject({ status: "completed", queryId: "approved" });
      if (!completed) throw new Error("Expected completed query");
      expect((completed.messages as Record<string, unknown>[]).at(-1)).toEqual({
        role: "assistant",
        text: `verified ${nonce}`,
      });
      expect(completed?.runId).not.toBe(waitingResult?.runId);
      const final = await run(["inspect", "approved"]);
      expect(final.code, final.diagnostic).toBe(0);
      expect(final.records).toContainEqual(
        expect.objectContaining({
          status: "completed",
          leaseReleased: true,
          replay: ["mimo-token-plan-cn/responses-output", "mimo-token-plan-cn/responses-output"],
        }),
      );
      const denied = await run(
        [...common, "--prompt", "Read notes.txt", "--query", "denied"],
        "no\n",
      );
      expect(denied.code, denied.diagnostic).toBe(0);
      expect(denied.records).toContainEqual(
        expect.objectContaining({
          type: "tool.completed",
          status: "failed",
          effects: "none",
          error: expect.objectContaining({ code: "tool_approval_rejected" }),
        }),
      );
      const beforeCancel = requests.length;
      const cancelled = await run(
        [...common, "--prompt", "Read notes.txt", "--query", "cancelled"],
        "cancel\n",
      );
      expect(cancelled.code, cancelled.diagnostic).toBe(130);
      expect(cancelled.records).toContainEqual(
        expect.objectContaining({ type: "result", status: "cancelled" }),
      );
      expect(requests).toHaveLength(beforeCancel + 1);
      const cancellation = await run(["inspect", "cancelled"]);
      expect(cancellation.records).toContainEqual(
        expect.objectContaining({ status: "cancelled", leaseReleased: true }),
      );
      expect(serverErrors).toEqual([]);
      expect(await readFile(join(workspace, "notes.txt"), "utf8")).toBe(nonce);
      const logRoot = join(root, "agent-development-logs");
      const instances = await readdir(logRoot);
      const lines: string[] = [];
      for (const instance of instances) {
        for (const file of await readdir(join(logRoot, instance))) {
          if (file.endsWith(".jsonl"))
            lines.push(await readFile(join(logRoot, instance, file), "utf8"));
        }
      }
      const logText = lines.join("");
      for (const secret of [
        "tp-isolated-native-integration",
        "tp-rotated-native-integration",
        "private-native-replay",
        nonce,
      ])
        expect(logText).not.toContain(secret);
      const logs = logText
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(logs).toContainEqual(
        expect.objectContaining({
          name: "models",
          event: "request.completed",
          context: expect.objectContaining({
            queryId: "approved",
            requestId: expect.any(String),
            step: expect.any(Number),
          }),
          data: expect.objectContaining({
            providerId: "mimo-token-plan-cn",
            reasoningEffort: "high",
          }),
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          name: "tools",
          event: "tools.execution.completed",
          context: expect.objectContaining({ queryId: "approved", toolCallId: "read-native" }),
        }),
      );
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
      await rm(directory, { recursive: true, force: true });
      if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
    }
  }, 120000);
});
