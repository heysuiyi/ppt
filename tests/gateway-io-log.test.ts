import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGatewayIoLogEntry,
  buildGatewayIoLogRequest,
  buildGatewayIoLogResponse,
  gatewayIoLogRelativePath,
  getGatewayIoLogDirectory,
  isGatewayIoLogEnabled,
  measureGatewayIoLogUsage,
  pruneGatewayIoLogFiles,
  writeGatewayIoLog,
} from "../src/main/agent/gateway/gateway-io-log";
import type {
  AgentModelContentBlock,
  PreparedAgentModelRequest,
} from "../src/main/agent/gateway/types";
import {
  clearLogFiles,
  getLogContext,
  getLogManagerStatus,
  withLogContext,
} from "../src/main/agent/logger";

const originalDataDir = process.env.AGENT_PPT_DATA_DIR;
const originalIoLog = process.env.AGENT_GATEWAY_IO_LOG;
const originalLogFile = process.env.AGENT_LOG_FILE;
const originalLogLevel = process.env.AGENT_LOG_LEVEL;

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ppt-gateway-io-"));
  process.env.AGENT_PPT_DATA_DIR = dataDir;
  process.env.AGENT_GATEWAY_IO_LOG = "true";
  process.env.AGENT_LOG_FILE = "false";
  process.env.AGENT_LOG_LEVEL = "error";
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.AGENT_PPT_DATA_DIR;
  else process.env.AGENT_PPT_DATA_DIR = originalDataDir;
  if (originalIoLog === undefined) delete process.env.AGENT_GATEWAY_IO_LOG;
  else process.env.AGENT_GATEWAY_IO_LOG = originalIoLog;
  if (originalLogFile === undefined) delete process.env.AGENT_LOG_FILE;
  else process.env.AGENT_LOG_FILE = originalLogFile;
  if (originalLogLevel === undefined) delete process.env.AGENT_LOG_LEVEL;
  else process.env.AGENT_LOG_LEVEL = originalLogLevel;
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
    expect(getGatewayIoLogDirectory()).toBe(path.join(dataDir, "logs", "gateway"));
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
          gatewayRequestId: "req-1",
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

    const absolute = await writeGatewayIoLog(entry);
    expect(absolute).toBeDefined();
    expect(absolute).toContain(path.join("logs", "gateway"));

    const parsed = JSON.parse(fs.readFileSync(absolute as string, "utf8"));
    expect(parsed).toMatchObject({
      gatewayRequestId: "req-1",
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

    const usage = await measureGatewayIoLogUsage();
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
    const written = await writeGatewayIoLog(entry);
    expect(written).toBeUndefined();
    const usage = await measureGatewayIoLogUsage();
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
      gatewayRequestId: "req-clear",
      kind: "query",
      status: "completed",
      provider: "openai",
      model: "gpt-test",
      callPath: "chat",
      startedAt: new Date(),
      durationMs: 3,
      request: buildGatewayIoLogRequest(samplePreparedRequest()),
    });
    await writeGatewayIoLog(entry);

    const status = await getLogManagerStatus();
    expect(status.fileCount).toBeGreaterThanOrEqual(1);
    expect(status.totalBytes).toBeGreaterThan(0);

    const removed = await clearLogFiles();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(getGatewayIoLogDirectory())).toBe(false);
  });

  it("prunes gateway day directories outside retention", async () => {
    const oldEntry = buildGatewayIoLogEntry({
      gatewayRequestId: "old",
      kind: "query",
      status: "completed",
      provider: "openai",
      model: "gpt-test",
      callPath: "chat",
      startedAt: new Date("2020-01-01T00:00:00.000Z"),
      durationMs: 1,
      request: buildGatewayIoLogRequest(samplePreparedRequest()),
    });
    await writeGatewayIoLog(oldEntry);
    const usageBefore = await measureGatewayIoLogUsage();
    expect(usageBefore.fileCount).toBe(1);

    const removed = await pruneGatewayIoLogFiles(7, new Date("2026-08-01T00:00:00.000Z"));
    expect(removed).toBe(1);
    const usageAfter = await measureGatewayIoLogUsage();
    expect(usageAfter.fileCount).toBe(0);
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
