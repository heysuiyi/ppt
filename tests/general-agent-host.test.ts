import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage, ModelSelection } from "@agent-harness/core/model/model-contract";
import type { CheckpointKey } from "@agent-harness/core/session/checkpoint-contract";
import type { AgentCheckpoint } from "@agent-harness/core/session/session-contract";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteAgentStores } from "../src/main/agent-host/sqlite-agent-stores";

const cleanup: Array<() => void | Promise<void>> = [];
const selected: ModelSelection = { providerId: "configured-host", modelId: "host-model" };
const key: CheckpointKey = { agentId: "agent", threadId: "thread", queryId: "query" };
const user: ModelMessage = { role: "user", content: [{ type: "text", text: "inspect this" }] };

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "general-agent-host-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "agent.sqlite");
}

function openStores(path: string) {
  const stores = createSqliteAgentStores(path);
  cleanup.push(() => stores.dispose());
  return stores;
}

function checkpoint(
  identity: CheckpointKey = key,
  status: AgentCheckpoint["status"] = "running",
): AgentCheckpoint {
  const base = {
    schemaVersion: 1 as const,
    ...identity,
    lastRunId: "run",
    definition: { id: "definition", version: "1" },
    plugins: [],
    model: selected,
    committed: { historyRevision: 0, messages: [], step: 0 },
    startMessageCount: 0,
    maxSteps: 8,
    extensions: [],
  };
  if (status === "waiting") {
    const call = { type: "tool-call" as const, callId: "pending", name: "approval", input: {} };
    return {
      ...base,
      status,
      inflight: {
        type: "tools",
        response: { message: { role: "assistant", content: [call] }, finishReason: "tool-calls" },
        remaining: [],
        completed: [],
      },
      pending: {
        invocation: {
          identity: { ...identity, runId: "run" },
          call,
          toolVersion: "1",
          state: "pending",
        },
        interaction: {
          id: "question",
          owner: "approval",
          payload: { type: "approval", version: 1, data: {} },
        },
        continuation: { type: "approval", version: 1, data: { callId: "pending" } },
        effects: "none",
      },
    };
  }
  if (status === "failed")
    return { ...base, status, error: { code: "failure", message: "failed" } };
  return { ...base, status };
}

describe("durable general agent stores", () => {
  it("reopens committed history, checkpoint snapshots, revisions, and active writer fences", async () => {
    const path = databasePath();
    const first = openStores(path);
    const activation = await first.checkpoints.acquire(key, "writer-1");
    if (activation.status !== "acquired") throw new Error("Expected first writer.");
    const saved = checkpoint();
    expect(await first.history.append(key.threadId, 0, [user], "input")).toEqual({
      status: "appended",
      revision: 1,
    });
    expect(await first.checkpoints.save(activation.lease, 0, saved)).toEqual({
      status: "saved",
      revision: 1,
    });
    await first.dispose();
    const reopened = openStores(path);
    expect(await reopened.history.read(key.threadId)).toEqual({
      threadId: key.threadId,
      revision: 1,
      messages: [user],
    });
    expect(await reopened.checkpoints.findUnfinished(key.agentId, key.threadId)).toEqual(saved);
    expect(await reopened.checkpoints.acquire(key, "writer-2")).toEqual({
      status: "busy",
      lease: activation.lease,
    });
    const next = await reopened.checkpoints.acquire(key, "writer-2", { replace: activation.lease });
    expect(next).toEqual({
      status: "acquired",
      lease: { key, ownerId: "writer-2", generation: 2 },
      currentRevision: 1,
      checkpoint: saved,
    });
    if (next.status !== "acquired") throw new Error("Expected takeover.");
    expect(
      await reopened.checkpoints.save(activation.lease, 1, checkpoint(key, "completed")),
    ).toEqual({ status: "stale" });
    await reopened.checkpoints.release(activation.lease);
    expect(await reopened.checkpoints.acquire(key, "third")).toEqual({
      status: "busy",
      lease: next.lease,
    });
    await reopened.checkpoints.release(next.lease);
    expect(
      await reopened.checkpoints.acquire(key, "stale-takeover", { replace: next.lease }),
    ).toEqual({ status: "stale" });
    const third = await reopened.checkpoints.acquire(key, "writer-2");
    expect(third).toMatchObject({
      status: "acquired",
      lease: { generation: 3 },
      currentRevision: 1,
      checkpoint: saved,
    });
  });

  it("enforces CAS across connections and compares the complete observed takeover lease", async () => {
    const path = databasePath();
    const first = openStores(path);
    const second = openStores(path);
    const initial = await first.checkpoints.acquire(key, "same-owner");
    if (initial.status !== "acquired") throw new Error("Expected acquisition.");
    expect(await second.checkpoints.acquire(key, "same-owner")).toEqual({
      status: "busy",
      lease: initial.lease,
    });
    for (const replace of [
      { ...initial.lease, ownerId: "foreign" },
      { ...initial.lease, generation: 0 },
      { ...initial.lease, key: { ...key, queryId: "foreign" } },
    ]) {
      expect(await second.checkpoints.acquire(key, "replacement", { replace })).toEqual({
        status: "stale",
      });
    }
    expect(await first.checkpoints.save(initial.lease, 0, checkpoint())).toEqual({
      status: "saved",
      revision: 1,
    });
    expect(await second.checkpoints.save(initial.lease, 0, checkpoint(key, "completed"))).toEqual({
      status: "conflict",
      currentRevision: 1,
    });
    await expect(
      second.checkpoints.save(initial.lease, 1, checkpoint({ ...key, threadId: "wrong" })),
    ).rejects.toMatchObject({ code: "checkpoint-key-mismatch" });
    const takeover = await second.checkpoints.acquire(key, "replacement", {
      replace: initial.lease,
    });
    if (takeover.status !== "acquired") throw new Error("Expected takeover.");
    expect(await first.checkpoints.save(initial.lease, 0, checkpoint())).toEqual({
      status: "stale",
    });
    expect(await second.checkpoints.save(takeover.lease, 1, checkpoint(key, "completed"))).toEqual({
      status: "saved",
      revision: 2,
    });
    expect(await first.checkpoints.findUnfinished(key.agentId, key.threadId)).toBeNull();
  });

  it("finds the most recently saved running, waiting, or interrupted query, not a terminal query", async () => {
    const stores = openStores(databasePath());
    expect(await stores.checkpoints.findUnfinished("agent", "thread")).toBeNull();
    for (const [queryId, status] of [
      ["running", "running"],
      ["waiting", "waiting"],
      ["interrupted", "interrupted"],
      ["terminal", "completed"],
    ] as const) {
      const identity = { ...key, queryId };
      const activation = await stores.checkpoints.acquire(identity, queryId);
      if (activation.status !== "acquired") throw new Error("Expected acquisition.");
      await stores.checkpoints.save(activation.lease, 0, checkpoint(identity, status));
      await stores.checkpoints.release(activation.lease);
    }
    expect(await stores.checkpoints.findUnfinished("agent", "thread")).toMatchObject({
      queryId: "interrupted",
      status: "interrupted",
    });
    expect(await stores.checkpoints.findUnfinished("other-agent", "thread")).toBeNull();
    const interrupted = await stores.checkpoints.acquire(
      { ...key, queryId: "interrupted" },
      "close",
    );
    if (interrupted.status !== "acquired") throw new Error("Expected acquisition.");
    await stores.checkpoints.save(
      interrupted.lease,
      1,
      checkpoint(interrupted.lease.key, "cancelled"),
    );
    expect(await stores.checkpoints.findUnfinished("agent", "thread")).toMatchObject({
      queryId: "waiting",
      status: "waiting",
    });
  });

  it("deduplicates a lost append receipt after restart and rejects batch payload reuse", async () => {
    const path = databasePath();
    const first = openStores(path);
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", callId: "call", name: "read", input: { a: 1, b: 2 } }],
      },
    ];
    expect(await first.history.append("thread", 0, messages, "committed-before-crash")).toEqual({
      status: "appended",
      revision: 1,
    });
    await first.dispose();
    const next = openStores(path);
    const reordered: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", callId: "call", name: "read", input: { b: 2, a: 1 } }],
      },
    ];
    expect(await next.history.append("thread", 0, reordered, "committed-before-crash")).toEqual({
      status: "appended",
      revision: 1,
    });
    await next.history.append("thread", 1, [user], "later");
    expect(await next.history.append("thread", 2, messages, "committed-before-crash")).toEqual({
      status: "appended",
      revision: 1,
    });
    await expect(
      next.history.append("thread", 2, [user], "committed-before-crash"),
    ).rejects.toMatchObject({ code: "history-batch-conflict" });
    expect(await next.history.read("thread")).toEqual({
      threadId: "thread",
      revision: 2,
      messages: [...messages, user],
    });
    expect(await next.history.append("other-thread", 0, [user], "committed-before-crash")).toEqual({
      status: "appended",
      revision: 1,
    });
  });

  it("does not reserve an uncommitted batch on CAS conflict and rejects lossy protocol values", async () => {
    const stores = openStores(databasePath());
    expect(await stores.history.read("absent")).toEqual({
      threadId: "absent",
      revision: 0,
      messages: [],
    });
    expect(await stores.history.append("thread", 1, [user], "not-committed")).toEqual({
      status: "conflict",
      currentRevision: 0,
    });
    expect(await stores.history.append("thread", 0, [user], "not-committed")).toEqual({
      status: "appended",
      revision: 1,
    });
    for (const value of [undefined, Number.NaN, new Date(), { invalid: undefined }]) {
      const invalid = [
        {
          role: "assistant",
          content: [{ type: "tool-call", callId: "invalid", name: "read", input: { value } }],
        },
      ] as unknown as ModelMessage[];
      await expect(stores.history.append("thread", 1, invalid, "invalid")).rejects.toMatchObject({
        code: "INVALID_PROTOCOL_VALUE",
      });
    }
    const read = await stores.history.read("thread");
    Object.assign(read.messages[0].content[0], { text: "mutated caller copy" });
    expect((await stores.history.read("thread")).messages).toEqual([user]);
    await stores.dispose();
    await expect(stores.history.append("thread", 1, [user], "closed")).rejects.toMatchObject({
      code: "store-disposed",
    });
    expect(() => createSqliteAgentStores(":memory:")).toThrow("persistent database");
  });
});
