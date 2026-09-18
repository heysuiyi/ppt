import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generate = vi.fn();
const generateStream = vi.fn();

vi.mock("../src/main/agent/gateway/openai", () => ({
  chatDriver: {
    generate: (...args: unknown[]) => generate(...args),
    generateStream: (...args: unknown[]) => generateStream(...args),
  },
  responsesDriver: {
    generate: (...args: unknown[]) => generate(...args),
    generateStream: (...args: unknown[]) => generateStream(...args),
  },
}));

vi.mock("../src/main/agent/gateway/anthropic", () => ({
  anthropicDriver: {
    generate: (...args: unknown[]) => generate(...args),
    generateStream: (...args: unknown[]) => generateStream(...args),
  },
}));

import { AgentGateway } from "../src/main/agent/gateway";
import { getGatewayIoLogDirectory } from "../src/main/agent/gateway/gateway-io-log";
import type { AgentModelResponse } from "../src/main/agent/gateway/types";

const originalDataDir = process.env.AGENT_PPT_DATA_DIR;
const originalIoLog = process.env.AGENT_GATEWAY_IO_LOG;
const originalLogFile = process.env.AGENT_LOG_FILE;
const originalLogLevel = process.env.AGENT_LOG_LEVEL;

let dataDir: string;

function listGatewayIoFiles(): string[] {
  const root = getGatewayIoLogDirectory();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((day) =>
      fs
        .readdirSync(path.join(root, day.name), { withFileTypes: true })
        .filter((file) => file.isFile())
        .map((file) => path.join(root, day.name, file.name)),
    );
}

function readSingleGatewayIoLog(): Record<string, unknown> {
  const files = listGatewayIoFiles();
  expect(files).toHaveLength(1);
  return JSON.parse(fs.readFileSync(files[0], "utf8"));
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ppt-gateway-agent-"));
  process.env.AGENT_PPT_DATA_DIR = dataDir;
  process.env.AGENT_GATEWAY_IO_LOG = "true";
  process.env.AGENT_LOG_FILE = "false";
  process.env.AGENT_LOG_LEVEL = "error";
  generate.mockReset();
  generateStream.mockReset();
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
});

function configureGateway(): AgentGateway {
  const gateway = new AgentGateway();
  gateway.configure({
    provider: "openai",
    model: "gpt-test",
    apiKey: "test-key",
  });
  return gateway;
}

describe("AgentGateway request/response logs", () => {
  it("archives non-stream model request and response under logs/gateway", async () => {
    const response: AgentModelResponse = {
      provider: "openai",
      model: "gpt-test",
      content: [{ type: "text", text: "slide ready" }],
      stopReason: "end",
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    };
    generate.mockResolvedValueOnce(response);

    const gateway = configureGateway();
    const result = await gateway.queryModel({
      prompt: "Build a cover slide",
      systemPrompt: "Design agent system prompt",
      tools: [
        {
          name: "PreviewSvgPage",
          description: "preview",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(result.content).toEqual(response.content);
    const log = readSingleGatewayIoLog();
    expect(log).toMatchObject({
      kind: "query",
      status: "completed",
      provider: "openai",
      model: "gpt-test",
      callPath: "responses",
      request: {
        systemPrompt: "Design agent system prompt",
        toolNames: ["PreviewSvgPage"],
      },
      response: {
        stopReason: "end",
        textLength: 11,
        content: [{ type: "text", text: "slide ready" }],
      },
    });
  });

  it("archives failed model requests", async () => {
    generate.mockRejectedValueOnce(new Error("provider down"));

    const gateway = configureGateway();
    await expect(gateway.queryModel({ prompt: "hello" })).rejects.toThrow();
    const log = readSingleGatewayIoLog();
    expect(log).toMatchObject({
      kind: "query",
      status: "failed",
      error: { message: expect.stringContaining("provider") },
    });
  });

  it("archives streaming model request and completed response", async () => {
    generateStream.mockImplementationOnce(async function* () {
      yield { type: "text_delta", text: "hel" };
      yield { type: "text_delta", text: "lo" };
      yield {
        type: "complete",
        content: [{ type: "text", text: "hello" }],
        stopReason: "end",
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      };
    });

    const gateway = configureGateway();
    const chunks: string[] = [];
    for await (const chunk of gateway.queryModelStream({
      prompt: "stream please",
      systemPrompt: "stream system",
    })) {
      if (chunk.type === "text_delta") chunks.push(chunk.text);
    }

    expect(chunks).toEqual(["hel", "lo"]);
    const log = readSingleGatewayIoLog();
    expect(log).toMatchObject({
      kind: "stream",
      status: "completed",
      callPath: "responses",
      request: { systemPrompt: "stream system" },
      response: {
        stopReason: "end",
        content: [{ type: "text", text: "hello" }],
      },
    });
  });

  it("does not write gateway I/O files when disabled", async () => {
    process.env.AGENT_GATEWAY_IO_LOG = "false";
    generate.mockResolvedValueOnce({
      provider: "openai",
      model: "gpt-test",
      content: [{ type: "text", text: "ok" }],
    });

    const gateway = configureGateway();
    await gateway.queryModel({ prompt: "no log" });
    expect(listGatewayIoFiles()).toHaveLength(0);
  });
});
