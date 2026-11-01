import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cliChild,
  cliSdkServer,
  cliToolOutput,
  jsonlRecords,
  runCliChild,
  waitingQuery,
} from "./fixtures/node-cli-process.js";

describe.skipIf(process.platform !== "win32")("production Node CLI approval and restart", () => {
  it("preserves waiting on EOF, rotates the same connection key, and resumes a real write with a fresh Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "node-cli-resume-"));
    const marker = `write-${crypto.randomUUID()}`;
    const server = await cliSdkServer(({ body, authorization }) => {
      if (cliToolOutput(body)) {
        expect(authorization).toBe("Bearer controlled-cli-rotated-key");
        return "write-authoritative-result";
      }
      return {
        name: "write",
        callId: "write-persistent",
        input: { path: "created.txt", content: marker, mode: "create" },
      };
    });
    try {
      await mkdir(join(root, "workspace"));
      expect((await runCliChild(root, server.endpoint, [], "", "seed")).code).toBe(0);
      const waiting = await runCliChild(root, server.endpoint, [
        "--prompt",
        "create a file",
        "--tools",
        "read-write",
        "--output",
        "jsonl",
      ]);
      expect(waiting.code).toBe(3);
      const pending = waitingQuery(waiting);
      const identity = pending.identity;
      const interactionId = pending.interaction.interactionId;
      await expect(stat(join(root, "workspace", "created.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const before = await runCliChild(
        root,
        server.endpoint,
        [identity.threadId, identity.queryId],
        "",
        "inspect",
      );
      expect(JSON.parse(before.stdout)).toMatchObject({
        status: "waiting",
        leaseReleased: true,
        interactionId,
      });
      expect((await runCliChild(root, server.endpoint, [], "", "rotate-key")).code).toBe(0);
      const resumed = cliChild(
        root,
        server.endpoint,
        ["--thread", identity.threadId, "--resume", identity.queryId],
        "interactive",
      );
      await resumed.waitFor("stderr", /输入 choiceId interactionId/);
      resumed.child.stdin.write(`allow ${interactionId}\r`);
      const result = await resumed.finished;
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("write-authoritative-result\n");
      expect(await readFile(join(root, "workspace", "created.txt"), "utf8")).toBe(marker);
      const after = JSON.parse(
        (
          await runCliChild(
            root,
            server.endpoint,
            [identity.threadId, identity.queryId],
            "",
            "inspect",
          )
        ).stdout,
      );
      expect(after).toMatchObject({ status: "completed", leaseReleased: true });
      expect(after.runId).not.toBe(identity.runId);
      expect(result.stdout + result.stderr).not.toContain("controlled-cli-rotated-key");
      expect(server.requests).toHaveLength(2);
      expect(server.errors).toEqual([]);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);

  it.each(["reject", "cancel"] as const)(
    "%s after restarting waiting never creates the file",
    async (action) => {
      const root = await mkdtemp(join(tmpdir(), `node-cli-${action}-`));
      const server = await cliSdkServer(({ body }) => {
        const output = cliToolOutput(body);
        if (output) {
          expect(output.isError).toBe(true);
          return "rejection-consumed";
        }
        return {
          name: "write",
          input: { path: "denied.txt", content: "must-not-exist", mode: "create" },
        };
      });
      try {
        await mkdir(join(root, "workspace"));
        expect((await runCliChild(root, server.endpoint, [], "", "seed")).code).toBe(0);
        const waiting = await runCliChild(root, server.endpoint, [
          "--prompt",
          "write",
          "--tools",
          "read-write",
          "--output",
          "jsonl",
        ]);
        expect(waiting.code).toBe(3);
        const pending = waitingQuery(waiting);
        const identity = pending.identity;
        const id = pending.interaction.interactionId;
        const resumed = cliChild(
          root,
          server.endpoint,
          ["--thread", identity.threadId, "--resume", identity.queryId],
          "interactive",
        );
        await resumed.waitFor("stderr", /输入 choiceId interactionId/);
        // A stale answer must not consume the stored interaction.
        resumed.child.stdin.write(`${action} stale-interaction\r`);
        await resumed.waitFor("stderr", /必须输入当前完整 interactionId/);
        resumed.child.stdin.write(`${action} ${id}\r`);
        const result = await resumed.finished;
        expect(result.code).toBe(action === "cancel" ? 130 : 0);
        await expect(stat(join(root, "workspace", "denied.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        const checkpoint = JSON.parse(
          (
            await runCliChild(
              root,
              server.endpoint,
              [identity.threadId, identity.queryId],
              "",
              "inspect",
            )
          ).stdout,
        );
        expect(checkpoint).toMatchObject({
          status: action === "cancel" ? "cancelled" : "completed",
          leaseReleased: true,
        });
        expect(server.requests).toHaveLength(action === "cancel" ? 1 : 2);
        expect(server.errors).toEqual([]);
      } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    45000,
  );

  it("refuses changed execution bindings without consuming persistent waiting", async () => {
    const root = await mkdtemp(join(tmpdir(), "node-cli-binding-"));
    const server = await cliSdkServer(() => ({
      name: "write",
      input: { path: "unchanged.txt", content: "no", mode: "create" },
    }));
    try {
      await mkdir(join(root, "workspace"));
      expect((await runCliChild(root, server.endpoint, [], "", "seed")).code).toBe(0);
      const first = await runCliChild(root, server.endpoint, [
        "--prompt",
        "write",
        "--tools",
        "read-write",
        "--output",
        "jsonl",
      ]);
      const { identity } = waitingQuery(first);
      expect((await runCliChild(root, server.endpoint, [], "", "change-budget")).code).toBe(0);
      const resumed = await runCliChild(root, server.endpoint, [
        "--thread",
        identity.threadId,
        "--resume",
        identity.queryId,
        "--output",
        "jsonl",
      ]);
      expect(resumed.code).toBe(1);
      expect(jsonlRecords(resumed).find((record) => record.type === "error")).toMatchObject({
        error: { code: "HOST_BINDING_CHANGED" },
      });
      const inspection = JSON.parse(
        (
          await runCliChild(
            root,
            server.endpoint,
            [identity.threadId, identity.queryId],
            "",
            "inspect",
          )
        ).stdout,
      );
      expect(inspection).toMatchObject({ status: "waiting", leaseReleased: true });
      await expect(stat(join(root, "workspace", "unchanged.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);
});
