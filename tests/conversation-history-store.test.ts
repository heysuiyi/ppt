import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentModelContentBlock,
  AgentModelGateway,
  AgentModelRequest,
} from "../src/main/agent/gateway/types";
import { DurableConversationHistoryStore } from "../src/main/agent/persistence/conversation-history-store";
import { DurableRunStore } from "../src/main/agent/persistence/durable-run-store";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { ConversationDatabase } from "../src/main/conversation-database";
import { readPresentationSnapshotTool } from "../src/main/plugins/ppt/tools/read-presentation-snapshot";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

const history = [
  { role: "user" as const, content: [{ type: "text" as const, text: "inspect" }] },
  {
    role: "assistant" as const,
    content: [{ type: "tool_use" as const, id: "read-1", name: "Read", input: {} }],
  },
  {
    role: "user" as const,
    content: [
      {
        type: "tool_result" as const,
        toolUseId: "read-1",
        content: [{ type: "text" as const, text: "result" }],
      },
    ],
  },
];

describe("canonical conversation history store", () => {
  it("round-trips complete ContentBlock history through the file fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-history-"));
    const store = new DurableConversationHistoryStore(root);
    await store.save("thread", history);
    expect(await store.load("thread")).toEqual(history);
  });

  it("round-trips complete ContentBlock history through SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-history-db-"));
    const database = new ConversationDatabase(join(root, "conversation.sqlite"));
    try {
      const store = new DurableConversationHistoryStore(database);
      await store.save("thread", history);
      expect(await store.load("thread")).toEqual(history);
    } finally {
      database.close();
    }
  });

  it("starts a fresh query from canonical tool history without restoring completed state", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-history-runtime-"));
    const requests: AgentModelRequest[] = [];
    const responses: AgentModelContentBlock[][] = [
      [{ type: "tool_use", id: "read-1", name: "ReadPresentationSnapshot", input: {} }],
      [{ type: "text", text: "first completed" }],
      [{ type: "text", text: "second completed" }],
    ];
    const gateway: AgentModelGateway = {
      async queryModel(request) {
        requests.push(request);
        const content = responses.shift();
        if (!content) throw new Error("Unexpected gateway call");
        return { provider: "openai", model: "test", content };
      },
      async *queryModelStream(request) {
        const response = await this.queryModel(request);
        yield { type: "complete" as const, content: response.content };
      },
    };
    const registry = new ToolRegistry();
    registry.register(readPresentationSnapshotTool);
    const runtime = createPptRuntime(registry, gateway);
    const presentationSnapshot = createStarterPresentation();

    await runtime.run({
      threadId: "history-thread",
      runId: "first-run",
      request: "inspect",
      presentationSnapshot,
      selectedElementIds: [],
      workspaceRoot: root,
    });
    await runtime.run({
      threadId: "history-thread",
      runId: "second-run",
      request: "follow up",
      startMode: { type: "new_query" },
      presentationSnapshot,
      selectedElementIds: [],
      workspaceRoot: root,
    });

    const secondMessages = requests[2]!.messages!;
    expect(secondMessages.flatMap((message) => message.content)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_use", id: "read-1" }),
        expect.objectContaining({ type: "tool_result", toolUseId: "read-1" }),
        expect.objectContaining({ type: "text", text: "follow up" }),
      ]),
    );
    const checkpoint = await new DurableRunStore(root).load("history-thread");
    expect(checkpoint).toMatchObject({
      version: 2,
      lastRunId: "second-run",
      // The fresh Query counts its own terminal model turn, but does not carry
      // the previous Query's counter forward (which would produce 2).
      committedState: {
        turnCount: 1,
        transition: { reason: "completed" },
      },
    });
  });

  it("recovers terminal History from checkpoint when the independent store write was lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-terminal-history-recovery-"));
    const requests: AgentModelRequest[] = [];
    const responses: AgentModelContentBlock[][] = [
      [{ type: "text", text: "durable first answer" }],
      [{ type: "text", text: "second answer" }],
    ];
    const gateway: AgentModelGateway = {
      async queryModel(request) {
        requests.push(request);
        const content = responses.shift();
        if (!content) throw new Error("Unexpected gateway call");
        return { provider: "openai", model: "test", content };
      },
      async *queryModelStream(request) {
        const response = await this.queryModel(request);
        yield { type: "complete" as const, content: response.content };
      },
    };
    const historySave = vi
      .spyOn(DurableConversationHistoryStore.prototype, "save")
      .mockRejectedValueOnce(new Error("simulated crash before History commit"));
    try {
      await createPptRuntime(new ToolRegistry(), gateway).run({
        threadId: "terminal-history-thread",
        runId: "terminal-history-first",
        request: "first question",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        workspaceRoot: root,
      });
    } finally {
      historySave.mockRestore();
    }
    expect(
      await new DurableConversationHistoryStore(root).load("terminal-history-thread"),
    ).toBeUndefined();
    const checkpoint = await new DurableRunStore(root).load("terminal-history-thread");
    expect(checkpoint?.version === 2 ? checkpoint.terminalHistory : undefined).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [expect.objectContaining({ type: "text", text: "durable first answer" })],
        }),
      ]),
    );

    await createPptRuntime(new ToolRegistry(), gateway).run({
      threadId: "terminal-history-thread",
      runId: "terminal-history-second",
      request: "second question",
      startMode: { type: "new_query" },
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot: root,
    });

    expect(requests[1]!.messages!.flatMap((message) => message.content)).toContainEqual({
      type: "text",
      text: "durable first answer",
    });
  });

  it("prefers a newer terminal checkpoint over an older stored History", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-stale-history-recovery-"));
    const requests: AgentModelRequest[] = [];
    const responses: AgentModelContentBlock[][] = [
      [{ type: "text", text: "first persisted answer" }],
      [{ type: "text", text: "newer checkpoint answer" }],
      [{ type: "text", text: "third answer" }],
    ];
    const gateway: AgentModelGateway = {
      async queryModel(request) {
        requests.push(request);
        const content = responses.shift();
        if (!content) throw new Error("Unexpected gateway call");
        return { provider: "openai", model: "test", content };
      },
      async *queryModelStream(request) {
        const response = await this.queryModel(request);
        yield { type: "complete" as const, content: response.content };
      },
    };
    const runtime = createPptRuntime(new ToolRegistry(), gateway);
    const baseInput = {
      threadId: "stale-history-thread",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [] as string[],
      workspaceRoot: root,
    };
    await runtime.run({
      ...baseInput,
      runId: "stale-history-first",
      request: "first question",
    });

    const historySave = vi
      .spyOn(DurableConversationHistoryStore.prototype, "save")
      .mockRejectedValueOnce(new Error("simulated second History commit loss"));
    try {
      await runtime.run({
        ...baseInput,
        runId: "stale-history-second",
        request: "second question",
      });
    } finally {
      historySave.mockRestore();
    }

    const staleHistory = await new DurableConversationHistoryStore(root).load(
      "stale-history-thread",
    );
    expect(staleHistory?.flatMap((message) => message.content)).not.toContainEqual({
      type: "text",
      text: "newer checkpoint answer",
    });
    const checkpoint = await new DurableRunStore(root).load("stale-history-thread");
    expect(checkpoint?.version === 2 ? checkpoint.terminalHistory : undefined).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [
            expect.objectContaining({
              type: "text",
              text: "newer checkpoint answer",
            }),
          ],
        }),
      ]),
    );

    await runtime.run({
      ...baseInput,
      runId: "stale-history-third",
      request: "third question",
    });
    expect(requests[2]!.messages!.flatMap((message) => message.content)).toContainEqual({
      type: "text",
      text: "newer checkpoint answer",
    });
  });

  it("reads History after lease handoff instead of using a pre-lease snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-history-lease-handoff-"));
    const historyStore = new DurableConversationHistoryStore(root);
    await historyStore.save("lease-handoff-thread", [
      { role: "user", content: [{ type: "text", text: "first question" }] },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    ]);

    const originalOpenLease = DurableRunStore.prototype.openLease;
    const openLease = vi
      .spyOn(DurableRunStore.prototype, "openLease")
      .mockImplementationOnce(async function (this: DurableRunStore, input) {
        await historyStore.save("lease-handoff-thread", [
          { role: "user", content: [{ type: "text", text: "first question" }] },
          { role: "assistant", content: [{ type: "text", text: "first answer" }] },
          { role: "user", content: [{ type: "text", text: "handoff question" }] },
          { role: "assistant", content: [{ type: "text", text: "handoff answer" }] },
        ]);
        return await originalOpenLease.call(this, input);
      });
    const requests: AgentModelRequest[] = [];
    const gateway: AgentModelGateway = {
      async queryModel(request) {
        requests.push(request);
        return {
          provider: "openai",
          model: "test",
          content: [{ type: "text", text: "new owner answer" }],
        };
      },
      async *queryModelStream(request) {
        const response = await this.queryModel(request);
        yield { type: "complete" as const, content: response.content };
      },
    };
    try {
      await createPptRuntime(new ToolRegistry(), gateway).run({
        threadId: "lease-handoff-thread",
        runId: "new-owner-run",
        request: "new owner question",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        workspaceRoot: root,
      });
    } finally {
      openLease.mockRestore();
    }

    expect(requests[0]!.messages!.flatMap((message) => message.content)).toContainEqual({
      type: "text",
      text: "handoff answer",
    });
  });
});
