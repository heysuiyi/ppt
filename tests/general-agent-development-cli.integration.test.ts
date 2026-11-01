import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  cliChild,
  cliAuthority,
  expectCliAuthority,
  cliSdkServer,
  cliToolOutput,
  jsonlRecords,
  queryRecord,
  runCliChild,
} from "./fixtures/node-cli-process.js";

describe("production Node CLI startup", () => {
  it("serves help, invalid arguments and empty stdin without initializing user data", async () => {
    const root = await mkdtemp(join(tmpdir(), "node-cli-startup-"));
    try {
      const environment = { ...process.env, AGENT_HARNESS_CLI_DATA_DIR: join(root, "data") };
      const help = spawnSync(process.execPath, [resolve("cli/dist/main.js"), "--help"], {
        input: "",
        encoding: "utf8",
        env: environment,
      });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("Agent Harness");
      expect(help.stdout).not.toContain("electron");
      const invalid = spawnSync(process.execPath, [resolve("cli/dist/main.js"), "--resume", "q"], {
        input: "",
        encoding: "utf8",
        env: environment,
      });
      expect(invalid.status).toBe(2);
      expect(invalid.stdout).toBe("");
      expect(invalid.stderr).toContain("--thread");
      const empty = spawnSync(process.execPath, [resolve("cli/dist/main.js")], {
        input: "",
        encoding: "utf8",
        env: environment,
      });
      expect(empty.status).toBe(0);
      expect(empty.stdout).toBe("");
      expect(empty.stderr).toBe("");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== "win32")(
  "Node CLI with real DPAPI and local SDK transport",
  () => {
    it("executes a no-plugin piped query with strict authoritative JSONL, not commands or deltas", async () => {
      const root = await mkdtemp(join(tmpdir(), "node-cli-conversation-"));
      const server = await cliSdkServer(({ body, authorization }) => {
        expect(authorization).toBe("Bearer controlled-cli-integration-key");
        expect(body.tools ?? []).toEqual([]);
        expect(JSON.stringify(body.input)).toContain("/exit");
        return "authoritative-conversation\u001b]52;c;injected\u0007";
      });
      try {
        await mkdir(join(root, "workspace"));
        expect((await runCliChild(root, server.endpoint, [], "", "seed")).code).toBe(0);
        const result = await runCliChild(
          root,
          server.endpoint,
          ["--tools", "none", "--output", "jsonl"],
          "/exit\nplain task\n",
        );
        expect(result.code).toBe(0);
        const records = jsonlRecords(result);
        expect(records.find((record) => record.type === "session")).toMatchObject({
          capabilities: [],
        });
        expect(records.filter((record) => record.type === "assistant.message")).toEqual([
          expect.objectContaining({
            content: [
              { contentIndex: 0, text: expect.stringContaining("authoritative-conversation") },
            ],
          }),
        ]);
        expect(records.at(-1)).toMatchObject({
          type: "process.finished",
          exitCode: 0,
          reason: "completed",
        });
        const identity = queryRecord(result).identity;
        const authority = cliAuthority(root, identity);
        expectCliAuthority(authority, identity, "completed", ["user", "assistant"]);
        expect(JSON.stringify(authority.messages)).toContain("authoritative-conversation");
        for (const record of records) {
          if (record.identity) expect(record.identity).toEqual(identity);
        }
        expect(records.some((record) => record.type === "model.delta")).toBe(false);
        expect(result.stdout).not.toContain("\u001b");
        expect(result.stdout + result.stderr).not.toContain("controlled-cli-integration-key");
        expect(server.errors).toEqual([]);
        expect(server.requests).toHaveLength(1);
      } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 40000);

    it("consumes real read-only file results while retaining private replay only in model transport", async () => {
      const root = await mkdtemp(join(tmpdir(), "node-cli-read-"));
      const notes = `node-cli-real-${crypto.randomUUID()}`;
      const server = await cliSdkServer(({ body }) => {
        const output = cliToolOutput(body);
        if (output) {
          expect(output.content).toBe(notes);
          expect(JSON.stringify(body.input)).toContain("PRIVATE_REPLAY_SENTINEL");
          return `read:${String(output.content)}`;
        }
        return { name: "read", input: { path: "notes.txt" } };
      });
      try {
        await mkdir(join(root, "workspace"));
        await writeFile(join(root, "workspace", "notes.txt"), notes);
        expect((await runCliChild(root, server.endpoint, [], "", "seed")).code).toBe(0);
        const result = await runCliChild(root, server.endpoint, [
          "--prompt",
          "read notes",
          "--output",
          "jsonl",
        ]);
        expect(result.code).toBe(0);
        const records = jsonlRecords(result);
        expect(
          records.find((record) => record.type === "tool" && record.phase === "completed"),
        ).toMatchObject({ status: "succeeded", effects: "none" });
        expect(records.find((record) => record.type === "assistant.message")).toMatchObject({
          content: [{ contentIndex: 0, text: `read:${notes}` }],
        });
        expect(result.stdout).not.toContain("PRIVATE_REPLAY_SENTINEL");
        expect(records.some((record) => record.type === "model.delta")).toBe(false);
        expect(await readFile(join(root, "workspace", "notes.txt"), "utf8")).toBe(notes);
        const { identity } = queryRecord(result);
        const authority = cliAuthority(root, identity);
        expectCliAuthority(authority, identity, "completed", ["user", "assistant", "tool", "assistant"]);
        expect(JSON.stringify(authority.messages.at(-1))).toContain(`read:${notes}`);
        for (const record of records) {
          if (record.identity) expect(record.identity).toEqual(identity);
        }
        const inspection = await runCliChild(
          root,
          server.endpoint,
          [identity.threadId, identity.queryId],
          "",
          "inspect",
        );
        expect(JSON.parse(inspection.stdout)).toMatchObject({
          status: "completed",
          leaseReleased: true,
        });
        expect(server.errors).toEqual([]);
        expect(server.requests).toHaveLength(2);
      } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 40000);

    it("drains a real execution after the downstream JSONL pipe closes", async () => {
      const root = await mkdtemp(join(tmpdir(), "node-cli-epipe-"));
      const requested = Promise.withResolvers<void>();
      const response = Promise.withResolvers<void>();
      const server = await cliSdkServer(async () => {
        requested.resolve();
        await response.promise;
        return "authoritative result after downstream closure";
      });
      try {
        await mkdir(join(root, "workspace"));
        expect((await runCliChild(root, server.endpoint, [], "", "seed")).code).toBe(0);
        const execution = cliChild(root, server.endpoint, [
          "--prompt",
          "pipe boundary",
          "--tools",
          "none",
          "--output",
          "jsonl",
        ]);
        execution.child.stdin.end();
        await Promise.all([
          requested.promise,
          execution.waitFor("stdout", /"phase":"run.started"[^\n]*\n/),
        ]);
        execution.child.stdout.destroy();
        response.resolve();
        const result = await execution.finished;
        expect(result.code).toBe(141);
        const completePrefix = result.stdout.slice(0, result.stdout.lastIndexOf("\n") + 1);
        const records = jsonlRecords({ ...result, stdout: completePrefix });
        const started = z
          .object({
            identity: z.object({
              agentId: z.string(),
              threadId: z.string(),
              queryId: z.string(),
              runId: z.string(),
            }),
          })
          .parse(
            records.find((record) => record.type === "progress" && record.phase === "run.started"),
          );
        const inspection = JSON.parse(
          (
            await runCliChild(
              root,
              server.endpoint,
              [started.identity.threadId, started.identity.queryId],
              "",
              "inspect",
            )
          ).stdout,
        );
        expect(inspection.leaseReleased).toBe(true);
        expect(["completed", "interrupted"]).toContain(inspection.status);
        const authority = cliAuthority(root, started.identity);
        expectCliAuthority(
          authority, started.identity, inspection.status,
          inspection.status === "completed" ? ["user", "assistant"] : ["user"],
        );
        if (inspection.status === "completed") {
          expect(JSON.stringify(authority.messages.at(-1))).toContain("authoritative result after downstream closure");
        } else {
          expect(JSON.stringify(authority.messages)).not.toContain("authoritative result after downstream closure");
        }
        expect(server.requests).toHaveLength(1);
        expect(server.errors).toEqual([]);
      } finally {
        response.resolve();
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 40000);
  },
);
