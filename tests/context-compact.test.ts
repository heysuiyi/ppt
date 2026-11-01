import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentModelGateway, AgentModelMessage } from "../app/main/agent/gateway/types";
import {
  adjustSnipBoundary,
  emergencyTrimContext,
  emergencyTrimModelMessages,
  findLastToolResultBlock,
  microCompactTranscript,
  prepareContext,
  resolveContextSoftTokenThreshold,
  resolveContextTokenThreshold,
  snipCompactConversation,
  snipCompactTranscript,
  toolResultBudget,
} from "../app/main/agent/runtime/context-compact";
import { compactHistory } from "../app/main/agent/runtime/context-compact/compact-history";

const temporaryDirectories: string[] = [];

async function createWorkspace() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-context-compact-"));
  temporaryDirectories.push(workspaceRoot);
  return workspaceRoot;
}

function nativeToolHistory(count: number, resultChars: number): AgentModelMessage[] {
  return Array.from({ length: count }, (_, index): AgentModelMessage[] => [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `native-call-${index}`,
          name: "ReadFile",
          input: { path: `file-${index}.txt` },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: `native-call-${index}`,
          content: [{ type: "text", text: `result-${index}-${"x".repeat(resultChars)}` }],
        },
      ],
    },
  ]).flat();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("snip_compact", () => {
  it("keeps head and tail when messages exceed threshold", () => {
    const conversation = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message-${index}`,
    }));

    const compacted = snipCompactConversation(conversation)!;
    expect(compacted).toHaveLength(51);
    expect(compacted[0].content).toBe("message-0");
    expect(compacted[1].content).toBe("message-1");
    expect(compacted[2].content).toBe("message-2");
    expect(compacted[3].content).toContain("Snipped");
    expect(compacted.at(-1)?.content).toBe("message-59");
  });

  it("does not split assistant tool_use from tool result at boundary", () => {
    const transcript = [
      ...Array.from({ length: 48 }, (_, index) => ({ role: "user", content: `u-${index}` })),
      { role: "assistant", kind: "tool_use", content: "Read" },
      { role: "tool", toolName: "Read", result: "file-body" },
    ];

    const compacted = snipCompactTranscript(transcript);
    const toolUseIndex = compacted.findIndex((entry) => entry.kind === "tool_use");
    const toolResultIndex = compacted.findIndex((entry) => entry.role === "tool");

    expect(toolUseIndex).toBeGreaterThan(-1);
    expect(toolResultIndex).toBe(toolUseIndex + 1);
  });

  it("adjustSnipBoundary walks back across tool_result entries", () => {
    const messages = [
      { role: "assistant", kind: "tool_use" },
      { role: "tool", toolName: "Read", result: "x" },
    ];
    expect(adjustSnipBoundary(messages, 1, 0)).toBe(0);
  });
});

describe("micro_compact", () => {
  it("compacts sizeable older tool results while keeping the last three in full", () => {
    const transcript = Array.from({ length: 6 }, (_, index) => ({
      role: "tool",
      toolName: `tool-${index}`,
      result: `payload-${index}-${"x".repeat(3_000)}`,
    }));

    const compacted = microCompactTranscript(transcript, 3);
    expect(compacted[0].result).toContain("compacted");
    expect(compacted[0].result).toContain("payload-0");
    expect(compacted[2].result).toContain("compacted");
    expect(compacted[3].result).toBe(transcript[3].result);
    expect(compacted[5].result).toBe(transcript[5].result);
  });

  it("keeps small results and the latest durable state result intact", () => {
    const transcript = [
      { role: "tool", toolName: "small-1", result: "small result" },
      { role: "tool", toolName: "TaskList", result: "x".repeat(3_000) },
      { role: "tool", toolName: "large-1", result: "x".repeat(3_000) },
      { role: "tool", toolName: "large-2", result: "x".repeat(3_000) },
      { role: "tool", toolName: "large-3", result: "x".repeat(3_000) },
      { role: "tool", toolName: "large-4", result: "x".repeat(3_000) },
    ];

    const compacted = microCompactTranscript(transcript, 2);
    expect(compacted[0].result).toBe("small result");
    expect(compacted[1].result).toBe(transcript[1].result);
    expect(compacted[2].result).toContain("compacted");
  });

  it("keeps the persisted recovery path in a compacted preview", () => {
    const transcript = [
      {
        role: "tool",
        toolName: "Read",
        result: "x".repeat(3_000),
        modelResult: { persistedPath: ".task_outputs/tool-results/thread/read.json" },
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        role: "tool",
        toolName: `recent-${index}`,
        result: "x".repeat(3_000),
      })),
    ];

    const compacted = microCompactTranscript(transcript, 3);
    expect(compacted[0].result).toContain(".task_outputs/tool-results/thread/read.json");
    expect(compacted[0].compaction).toMatchObject({
      originalChars: 3_002,
      persistedPath: ".task_outputs/tool-results/thread/read.json",
    });
  });
});

describe("tool_result_budget", () => {
  it("persists oversized trailing tool results to disk", async () => {
    const workspaceRoot = await createWorkspace();
    const large = "x".repeat(150_000);
    const transcript = [
      { role: "user", content: "step" },
      { role: "tool", toolName: "Read", result: large },
      { role: "tool", toolName: "Read", result: large },
    ];

    const block = findLastToolResultBlock(transcript);
    expect(block).toEqual([1, 2]);

    const { transcript: compacted, notes } = await toolResultBudget(
      transcript,
      workspaceRoot,
      200_000,
    );
    expect(notes.length).toBeGreaterThan(0);
    expect(String(compacted[1].result)).toContain("<persisted-output");
    expect(String(compacted[1].result)).toContain(".task_outputs/tool-results/");

    const persistedPath = String(compacted[1].result).match(/path="([^"]+)"/)?.[1];
    expect(persistedPath).toBeTruthy();
    const diskContent = await readFile(join(workspaceRoot, persistedPath!), "utf8");
    expect(diskContent).toBe(large);
  });
});

describe("compact_history", () => {
  it("archives transcript and replaces active context with summary", async () => {
    const workspaceRoot = await createWorkspace();
    let responseContract: string | undefined;
    const gateway: AgentModelGateway = {
      async queryModel(request) {
        responseContract = request.responseContract;
        return {
          provider: "openai",
          model: "gpt",
          content: [{ type: "text", text: "## Goal\nFinish slides." }],
        };
      },
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };

    const payload = {
      request: "build deck",
      conversation: [{ role: "user" as const, content: "hello" }],
      transcript: [
        { role: "user", content: "build deck" },
        { role: "tool", toolName: "Read", result: "old" },
      ],
    };

    const result = await compactHistory({
      payload,
      workspaceRoot,
      threadId: "thread-1",
      gateway,
    });

    expect(result.skipped).toBe(false);
    expect(responseContract).toBe("markdown-summary");
    expect(result.savedPath).toContain("thread-1-");
    expect(result.savedPath).toContain(".transcripts");
    expect(result.payload.transcript[0]).toMatchObject({
      role: "system",
      kind: "compact_boundary",
    });
    expect(String(result.payload.transcript[0].content)).toContain("Finish slides");
  });

  it("does not replace canonical history with a truncated summary", async () => {
    const workspaceRoot = await createWorkspace();
    const gateway: AgentModelGateway = {
      async queryModel() {
        return {
          provider: "openai",
          model: "gpt",
          content: [{ type: "text", text: "Plausible but incomplete summary." }],
          stopReason: "max_tokens",
        };
      },
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };
    const payload = {
      request: "build deck",
      transcript: [{ role: "user", content: "retain this complete history" }],
    };

    const result = await compactHistory({
      payload,
      workspaceRoot,
      threadId: "truncated-summary",
      gateway,
    });

    expect(result.skipped).toBe(true);
    expect(result.failures).toBe(1);
    expect(result.reason).toContain("truncated");
    expect(result.payload).toEqual(payload);
  });

  it("does not replace canonical history when the summary emits tool_use", async () => {
    const workspaceRoot = await createWorkspace();
    const gateway: AgentModelGateway = {
      async queryModel() {
        return {
          provider: "openai",
          model: "gpt",
          content: [
            { type: "text", text: "Checking..." },
            { type: "tool_use", id: "call-1", name: "Read", input: {} },
          ],
        };
      },
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };
    const payload = {
      request: "build deck",
      transcript: [{ role: "user", content: "retain this complete history" }],
    };

    const result = await compactHistory({
      payload,
      workspaceRoot,
      threadId: "tool-use-summary",
      gateway,
    });

    expect(result.skipped).toBe(true);
    expect(result.failures).toBe(1);
    expect(result.reason).toContain("tool_use");
    expect(result.payload).toEqual(payload);
  });

  it("opens circuit breaker after consecutive failures", async () => {
    const gateway: AgentModelGateway = {
      async queryModel() {
        throw new Error("summary failed");
      },
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };

    const payload = { transcript: [{ role: "user", content: "x" }] };
    const blocked = await compactHistory({
      payload,
      workspaceRoot: "/tmp",
      threadId: "t1",
      gateway,
      compactHistoryFailures: 3,
    });

    expect(blocked.skipped).toBe(true);
    expect(blocked.failures).toBe(3);
    expect(blocked.reason).toContain("circuit breaker");

    const failing = await compactHistory({
      payload,
      workspaceRoot: "/tmp",
      threadId: "t1",
      gateway,
      compactHistoryFailures: 2,
    });
    expect(failing.failures).toBe(3);
  });
});

describe("prepareContext", () => {
  it("defaults to 256K and opts into the model's 1M context window", () => {
    const defaultThreshold = resolveContextTokenThreshold({});
    const extendedThreshold = resolveContextTokenThreshold({}, true);

    expect(defaultThreshold).toBe(256_000);
    expect(resolveContextSoftTokenThreshold(defaultThreshold, {})).toBe(204_800);
    expect(extendedThreshold).toBe(1_000_000);
    expect(resolveContextSoftTokenThreshold(extendedThreshold, {})).toBe(800_000);
  });

  it("does not compact solely because more than three tool results exist", async () => {
    const progress: string[] = [];
    const transcript = Array.from({ length: 8 }, (_, index) => ({
      role: "tool",
      toolName: `tool-${index}`,
      result: `small-${index}`,
    }));

    const result = await prepareContext({
      payload: { request: "task", transcript },
      systemPrompt: "system",
      tokenThreshold: 100_000,
      onProgress: (message) => progress.push(message),
    });

    expect(result.payload.transcript).toEqual(transcript);
    expect(result.notes).toEqual([]);
    expect(result.contextChanged).toBe(false);
    expect(progress).toEqual([]);
  });

  it("counts and micro-compacts canonical native tool history", async () => {
    const messages = nativeToolHistory(6, 4_000);
    const original = structuredClone(messages);

    const result = await prepareContext({
      payload: { request: "task", transcript: [] },
      messages,
      systemPrompt: "system",
      tokenThreshold: 100_000,
      softTokenThreshold: 1_000,
    });

    expect(result.contextChanged).toBe(true);
    expect(result.notes.some((note) => note.startsWith("L2 micro_compact:"))).toBe(true);
    expect(result.messages).toHaveLength(messages.length);
    const firstResult = result.messages?.[1]?.content[0];
    expect(firstResult).toMatchObject({ type: "tool_result", toolUseId: "native-call-0" });
    expect(JSON.stringify(firstResult)).toContain("<compacted-tool-result");
    expect(JSON.stringify(result.messages?.at(-1))).toContain("result-5-");
    expect(messages).toEqual(original);
  });

  it("summarizes canonical native history at the hard threshold", async () => {
    const workspaceRoot = await createWorkspace();
    const messages: AgentModelMessage[] = Array.from({ length: 16 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: [{ type: "text" as const, text: `native-${index}-${"x".repeat(2_000)}` }],
    }));
    let summaryInput: Record<string, unknown> | undefined;
    const gateway: AgentModelGateway = {
      async queryModel(request) {
        summaryInput = JSON.parse(request.prompt) as Record<string, unknown>;
        return {
          provider: "openai",
          model: "gpt",
          content: [{ type: "text", text: "Native history summary." }],
        };
      },
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };

    const result = await prepareContext({
      payload: {
        transcript: [],
        queryContext: {
          source: "user",
          user: { locale: "zh-CN" },
          system: { surface: "desktop" },
        },
      },
      messages,
      systemPrompt: "system",
      workspaceRoot,
      threadId: "native-history",
      gateway,
      tokenThreshold: 1_000,
    });

    expect((summaryInput?.messages as unknown[] | undefined)?.length).toBe(messages.length);
    expect(result.payload.transcript).toEqual([]);
    expect(result.messages?.length).toBeLessThan(messages.length);
    expect(JSON.stringify(result.messages?.[0])).toContain("Native history summary.");
    expect(JSON.stringify(result.messages)).not.toContain('"locale":"zh-CN"');
    expect(result.notes.some((note) => note.startsWith("L4 compact_history:"))).toBe(true);
  });

  it("uses preview-preserving micro compaction only after the soft threshold", async () => {
    const queryModel = vi.fn();
    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };
    const progress: string[] = [];
    const transcript = Array.from({ length: 6 }, (_, index) => ({
      role: "tool",
      toolName: `tool-${index}`,
      result: `important-${index}-${"x".repeat(4_000)}`,
    }));

    const result = await prepareContext({
      payload: { request: "task", transcript },
      systemPrompt: "system",
      gateway,
      tokenThreshold: 10_000,
      softTokenThreshold: 5_000,
      onProgress: (message) => progress.push(message),
    });

    expect(queryModel).not.toHaveBeenCalled();
    expect(result.contextChanged).toBe(true);
    expect(result.notes.some((note) => note.startsWith("L2 micro_compact:"))).toBe(true);
    expect(String(result.payload.transcript[0].result)).toContain("important-0");
    expect(progress).toEqual(["上下文空间接近阈值，已精简较早的工具结果并保留可恢复摘要…"]);
  });

  it("persists large results and triggers L4 when still over the hard threshold", async () => {
    const workspaceRoot = await createWorkspace();
    const queryModel = vi.fn().mockResolvedValue({
      provider: "openai",
      model: "gpt",
      content: [{ type: "text", text: "compressed summary" }],
    });
    const gateway: AgentModelGateway = {
      queryModel,
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };

    const transcript = Array.from({ length: 60 }, (_, _index) => ({
      role: "tool",
      toolName: "Read",
      result: "x".repeat(8_000),
    }));
    const userProgress: string[] = [];

    const result = await prepareContext({
      payload: {
        request: "task",
        transcript,
      },
      systemPrompt: "system",
      workspaceRoot,
      threadId: "thread-2",
      gateway,
      tokenThreshold: 1_000,
      onProgress: (message) => userProgress.push(message),
    });

    expect(result.payload.transcript.length).toBeLessThan(transcript.length);
    expect(queryModel).toHaveBeenCalledTimes(1);
    expect(result.notes.some((note) => /L[1-4]|Persisted oversized/.test(note))).toBe(true);
    expect(result.contextChanged).toBe(true);
    expect(userProgress).toEqual(["上下文空间接近上限，已总结较早的会话记录并继续处理…"]);
    expect(userProgress.join(" ")).not.toMatch(
      /snip_compact|micro_compact|compact_history|tool_result|\.task_outputs/i,
    );
  });
});

describe("emergencyTrimContext", () => {
  it("aggressively trims on API overflow recovery", () => {
    const payload = {
      request: "task",
      conversation: Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `c-${index}`,
      })),
      transcript: Array.from({ length: 20 }, (_, index) => ({
        role: "tool",
        toolName: `tool-${index}`,
        result: `r-${index}`,
      })),
    };

    const trimmed = emergencyTrimContext(payload);
    expect(trimmed.transcript.length).toBeLessThanOrEqual(5);
    expect(trimmed.conversation?.length ?? 0).toBeLessThanOrEqual(4);
  });

  it("trims canonical native history without splitting tool protocol pairs", () => {
    const messages = nativeToolHistory(8, 100);
    const trimmed = emergencyTrimModelMessages(messages)!;

    expect(trimmed.length).toBeLessThan(messages.length);
    for (let index = 0; index < trimmed.length; index += 1) {
      const message = trimmed[index]!;
      if (
        message.role === "assistant" &&
        message.content.some((block) => block.type === "tool_use")
      ) {
        expect(trimmed[index + 1]?.content.some((block) => block.type === "tool_result")).toBe(
          true,
        );
      }
    }
  });
});
