import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGatewayIoLogEntry,
  buildGatewayIoLogRequest,
  buildGatewayIoLogResponse,
  clearGatewayIoLogFiles,
  GatewayIoLogManagementError,
  gatewayIoLogRelativePath,
  getGatewayIoLogDirectory,
  isGatewayIoLogEnabled,
  measureGatewayIoLogUsage,
  pruneGatewayIoLogFiles,
  writeGatewayIoLog,
} from "../app/main/agent/gateway/gateway-io-log";
import type {
  AgentModelContentBlock,
  PreparedAgentModelRequest,
} from "../app/main/agent/gateway/types";
import { createDesktopLogs } from "../app/main/logging/desktop-logs";
import { getLogContext, withLogContext } from "../app/main/logging/log-context";

const originalIoLog = process.env.AGENT_GATEWAY_IO_LOG;

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ppt-gateway-io-"));
  process.env.AGENT_GATEWAY_IO_LOG = "true";
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalIoLog === undefined) delete process.env.AGENT_GATEWAY_IO_LOG;
  else process.env.AGENT_GATEWAY_IO_LOG = originalIoLog;
  vi.restoreAllMocks();
});

function samplePreparedRequest(): PreparedAgentModelRequest {
  return {
    systemPrompt: "You are a presentation design agent.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Create a cover slide." }],
      },
    ],
    tools: [
      {
        name: "PreviewSvgPage",
        description: "Preview one SVG page",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    maxOutputTokens: 4096,
  };
}

describe("gateway I/O log enablement", () => {
  it("defaults to enabled and honors explicit off switches", () => {
    expect(isGatewayIoLogEnabled({})).toBe(true);
    expect(isGatewayIoLogEnabled({ AGENT_GATEWAY_IO_LOG: "true" })).toBe(true);
    expect(isGatewayIoLogEnabled({ AGENT_GATEWAY_IO_LOG: "false" })).toBe(false);
    expect(isGatewayIoLogEnabled({ AGENT_GATEWAY_IO_LOG: "0" })).toBe(false);
    expect(isGatewayIoLogEnabled({ AGENT_GATEWAY_IO_LOG: "off" })).toBe(false);
  });

  it("locates files under the application logs/gateway directory", () => {
    expect(getGatewayIoLogDirectory(path.join(dataDir, "logs"))).toBe(
      path.join(dataDir, "logs", "gateway"),
    );
  });
});

describe("buildGatewayIoLogRequest / response", () => {
  it("captures prepared request payload for end-to-end verification", () => {
    const payload = buildGatewayIoLogRequest(samplePreparedRequest());
    expect(payload.systemPrompt).toContain("presentation design agent");
    expect(payload.messageCount).toBe(1);
    expect(payload.toolNames).toEqual(["PreviewSvgPage"]);
    expect(payload.maxOutputTokens).toBe(4096);
  });

  it("omits binary image data from response content", () => {
    const content: AgentModelContentBlock[] = [
      { type: "text", text: "done" },
      { type: "image", mediaType: "image/png", data: "a".repeat(120) },
    ];
    const payload = buildGatewayIoLogResponse({
      provider: "openai",
      model: "gpt-test",
      content,
      stopReason: "end",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
    expect(payload.textLength).toBe(4);
    expect(payload.content[0]).toEqual({ type: "text", text: "done" });
    expect(payload.content[1]).toMatchObject({
      type: "image",
      data: "[omitted 120 characters]",
    });
  });
});

describe("writeGatewayIoLog", () => {
  it("writes a pretty-printed JSON archive file and indexes usage", async () => {
    const prepared = samplePreparedRequest();
    const request = buildGatewayIoLogRequest(prepared);
    const entry = withLogContext(
      { sessionId: "session-1", runId: "run-1", threadId: "thread-1", queryId: "query-1" },
      () =>
        buildGatewayIoLogEntry({
          gatewayRequestId: "11111111-1111-4111-8111-111111111111",
          kind: "query",
          status: "completed",
          provider: "openai",
          model: "gpt-test",
          callPath: "responses",
          startedAt: new Date("2026-08-01T12:00:00.000Z"),
          durationMs: 42,
          request,
          response: {
            provider: "openai",
            model: "gpt-test",
            content: [{ type: "text", text: "ok" }],
            stopReason: "end",
          },
        }),
    );

    const absolute = await writeGatewayIoLog(entry, path.join(dataDir, "logs"));
    expect(absolute).toBeDefined();
    expect(absolute).toContain(path.join("logs", "gateway"));

    const parsed = JSON.parse(fs.readFileSync(absolute as string, "utf8"));
    expect(parsed).toMatchObject({
      gatewayRequestId: "11111111-1111-4111-8111-111111111111",
      kind: "query",
      status: "completed",
      callPath: "responses",
      context: {
        sessionId: "session-1",
        runId: "run-1",
        threadId: "thread-1",
        queryId: "query-1",
      },
      request: {
        systemPrompt: "You are a presentation design agent.",
        toolNames: ["PreviewSvgPage"],
      },
      response: {
        stopReason: "end",
        textLength: 2,
      },
    });

    const usage = await measureGatewayIoLogUsage(path.join(dataDir, "logs"));
    expect(usage.fileCount).toBe(1);
    expect(usage.totalBytes).toBeGreaterThan(0);
  });

  it("skips writes when disabled", async () => {
    process.env.AGENT_GATEWAY_IO_LOG = "false";
    const entry = buildGatewayIoLogEntry({
      gatewayRequestId: "req-off",
      kind: "query",
      status: "completed",
      provider: "openai",
      model: "gpt-test",
      callPath: "chat",
      startedAt: new Date(),
      durationMs: 1,
      request: buildGatewayIoLogRequest(samplePreparedRequest()),
    });
    const written = await writeGatewayIoLog(entry, path.join(dataDir, "logs"));
    expect(written).toBeUndefined();
    const usage = await measureGatewayIoLogUsage(path.join(dataDir, "logs"));
    expect(usage.fileCount).toBe(0);
  });

  it("builds a stable relative path from startedAt and gatewayRequestId", () => {
    const entry = buildGatewayIoLogEntry({
      gatewayRequestId: "abc",
      kind: "stream",
      status: "failed",
      provider: "anthropic",
      model: "claude-test",
      callPath: "anthropic",
      startedAt: new Date("2026-08-02T01:02:03.000Z"),
      durationMs: 5,
      request: buildGatewayIoLogRequest(samplePreparedRequest()),
      error: new Error("boom"),
    });
    // startedAt is stored as ISO; day folder uses the ISO date prefix.
    expect(gatewayIoLogRelativePath(entry)).toBe(
      path.join("gateway", entry.startedAt.slice(0, 10), "abc.json"),
    );
    expect(entry.error?.message).toBe("boom");
  });
});

describe("log manager integration", () => {
  it("includes gateway I/O files in clear and status", async () => {
    const entry = buildGatewayIoLogEntry({
      gatewayRequestId: "22222222-2222-4222-8222-222222222222",
      kind: "query",
      status: "completed",
      provider: "openai",
      model: "gpt-test",
      callPath: "chat",
      startedAt: new Date(),
      durationMs: 3,
      request: buildGatewayIoLogRequest(samplePreparedRequest()),
    });
    const logs = await createDesktopLogs({
      directory: path.join(dataDir, "logs"),
      environment: { AGENT_LOG_FILE: "false", AGENT_LOG_LEVEL: "error" },
    });
    try {
      await writeGatewayIoLog(entry, logs.directory);
      const status = await logs.getStatus();
      expect(status.fileCount).toBeGreaterThanOrEqual(1);
      expect(status.totalBytes).toBeGreaterThan(0);
      const result = await logs.clear();
      expect(result.removedFiles).toBeGreaterThanOrEqual(1);
      expect(result.skipped).toEqual([]);
      expect((await measureGatewayIoLogUsage(logs.directory)).fileCount).toBe(0);
    } finally {
      await logs.close();
    }
  });

  it("prunes gateway day directories outside retention", async () => {
    const oldEntry = buildGatewayIoLogEntry({
      gatewayRequestId: "33333333-3333-4333-8333-333333333333",
      kind: "query",
      status: "completed",
      provider: "openai",
      model: "gpt-test",
      callPath: "chat",
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      durationMs: 1,
      request: buildGatewayIoLogRequest(samplePreparedRequest()),
    });
    await writeGatewayIoLog(oldEntry, path.join(dataDir, "logs"));
    const usageBefore = await measureGatewayIoLogUsage(path.join(dataDir, "logs"));
    expect(usageBefore.fileCount).toBe(1);

    const removed = await pruneGatewayIoLogFiles(
      7,
      new Date("2026-08-01T00:00:00.000Z"),
      path.join(dataDir, "logs"),
    );
    expect(removed).toBe(1);
    const usageAfter = await measureGatewayIoLogUsage(path.join(dataDir, "logs"));
    expect(usageAfter.fileCount).toBe(0);
  });
});

describe("Gateway archive ownership and coordination", () => {
  function archive(id: string) {
    return buildGatewayIoLogEntry({
      gatewayRequestId: id,
      kind: "query",
      status: "completed",
      provider: "openai",
      model: "test",
      callPath: "chat",
      startedAt: new Date("2026-08-01T12:00:00.000Z"),
      durationMs: 1,
      request: buildGatewayIoLogRequest(samplePreparedRequest()),
    });
  }

  it("orders writes and clearing on the same root and remains writable", async () => {
    const root = path.join(dataDir, "logs");
    const first = archive("44444444-4444-4444-8444-444444444444");
    const second = archive("55555555-5555-4555-8555-555555555555");
    const [written, removed, next] = await Promise.all([
      writeGatewayIoLog(first, root),
      clearGatewayIoLogFiles(root),
      writeGatewayIoLog(second, root),
    ]);
    expect(written).toBeDefined();
    expect(removed).toBe(1);
    expect(next).toBeDefined();
    expect((await measureGatewayIoLogUsage(root)).fileCount).toBe(1);
  });

  it("preserves unknown files while reporting actual removals and skipped paths", async () => {
    const root = path.join(dataDir, "logs");
    const entry = archive("44444444-4444-4444-8444-444444444444");
    const file = await writeGatewayIoLog(entry, root);
    const unknown = path.join(path.dirname(file as string), "sentinel.json");
    fs.writeFileSync(unknown, "keep");
    await expect(clearGatewayIoLogFiles(root)).rejects.toMatchObject({
      name: "GatewayIoLogManagementError",
      removedFiles: 1,
      skipped: [expect.stringContaining(unknown)],
    });
    expect(fs.readFileSync(unknown, "utf8")).toBe("keep");
    expect(fs.existsSync(file as string)).toBe(false);
  });

  it("does not count a failed unlink as a successful deletion", async () => {
    const root = path.join(dataDir, "logs");
    await writeGatewayIoLog(archive("44444444-4444-4444-8444-444444444444"), root);
    await writeGatewayIoLog(archive("55555555-5555-4555-8555-555555555555"), root);
    vi.spyOn(fs.promises, "unlink").mockRejectedValueOnce(new Error("denied"));
    const failure = await clearGatewayIoLogFiles(root).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayIoLogManagementError);
    expect(failure).toMatchObject({ removedFiles: 1, skipped: [expect.any(String)] });
    expect((await measureGatewayIoLogUsage(root)).fileCount).toBe(1);
  });

  it("keeps active and crash-abandoned per-file locks local to the old artifact", async () => {
    const root = path.join(dataDir, "logs");
    const old = await writeGatewayIoLog(archive("44444444-4444-4444-8444-444444444444"), root);
    expect(old).toBeDefined();
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      require("proper-lockfile").lock(process.argv[1], {
        realpath: false, stale: Number.MAX_SAFE_INTEGER, update: 10000, retries: 0,
      }).then(() => process.send("locked")).catch(() => process.exit(1));
      process.on("message", () => {});
    `,
        old as string,
      ],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const exited = once(child, "exit");
    try {
      await Promise.race([
        once(child, "message"),
        exited.then(() => {
          throw new Error("Archive lock child exited before acquiring its lock.");
        }),
      ]);
      expect(fs.existsSync(`${old}.lock`)).toBe(true);
      const next = await writeGatewayIoLog(archive("55555555-5555-4555-8555-555555555555"), root);
      expect(next).toBeDefined();
      await expect(clearGatewayIoLogFiles(root)).rejects.toMatchObject({
        name: "GatewayIoLogManagementError",
        removedFiles: 1,
        skipped: expect.arrayContaining([expect.stringContaining(old as string)]),
      });
      expect(fs.existsSync(old as string)).toBe(true);
      child.kill("SIGKILL");
      await exited;
      expect(fs.existsSync(`${old}.lock`)).toBe(true);
      const afterCrash = await writeGatewayIoLog(
        archive("66666666-6666-4666-8666-666666666666"),
        root,
      );
      expect(afterCrash).toBeDefined();
      await expect(clearGatewayIoLogFiles(root)).rejects.toMatchObject({
        removedFiles: 1,
        skipped: expect.arrayContaining([expect.stringContaining(old as string)]),
      });
      expect(fs.existsSync(old as string)).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("archives every concurrently submitted distinct request ID", async () => {
    const root = path.join(dataDir, "logs");
    const ids = [
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
    ];
    const written = await Promise.all(ids.map((id) => writeGatewayIoLog(archive(id), root)));
    expect(written.every((file) => file !== undefined && fs.existsSync(file))).toBe(true);
    expect((await measureGatewayIoLogUsage(root)).fileCount).toBe(ids.length);
  });

  it("does not let a legacy root lock block new request IDs", async () => {
    const root = path.join(dataDir, "logs");
    const gatewayDirectory = getGatewayIoLogDirectory(root);
    fs.mkdirSync(gatewayDirectory, { recursive: true });
    fs.mkdirSync(`${gatewayDirectory}.lock`);
    const written = await writeGatewayIoLog(archive("44444444-4444-4444-8444-444444444444"), root);
    expect(written).toBeDefined();
    expect(fs.existsSync(`${gatewayDirectory}.lock`)).toBe(true);
    await expect(measureGatewayIoLogUsage(root)).resolves.toMatchObject({ fileCount: 1 });
  });
});

describe("getLogContext", () => {
  it("returns a copy of the active async log context", () => {
    expect(getLogContext()).toEqual({});
    withLogContext({ runId: "run-ctx" }, () => {
      expect(getLogContext()).toEqual({ runId: "run-ctx" });
    });
  });
});
