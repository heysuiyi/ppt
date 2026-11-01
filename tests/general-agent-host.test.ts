import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelMessage, ModelSelection } from "@agent-harness/core/model/model-contract";
import type { CheckpointKey } from "@agent-harness/core/session/checkpoint-contract";
import type { AgentCheckpoint } from "@agent-harness/core/session/session-contract";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteAgentStores } from "../cli/host/sqlite-agent-stores.js";

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

  it("blocks new queries until each released unfinished query is resumed and completed", async () => {
    const stores = openStores(databasePath());
    expect(await stores.checkpoints.findUnfinished("agent", "thread")).toBeNull();
    for (const status of ["running", "waiting", "interrupted"] as const) {
      const identity = { ...key, queryId: status };
      const activation = await stores.checkpoints.acquire(identity, "writer");
      if (activation.status !== "acquired") throw new Error("Expected acquisition.");
      expect(
        await stores.checkpoints.save(activation.lease, 0, checkpoint(identity, status)),
      ).toEqual({
        status: "saved",
        revision: 1,
      });
      await stores.checkpoints.release(activation.lease);
      expect(await stores.checkpoints.findUnfinished("agent", "thread")).toEqual(
        checkpoint(identity, status),
      );
      expect(await stores.checkpoints.findUnfinished("other-agent", "thread")).toBeNull();
      expect(await stores.checkpoints.acquire(key, "new-query")).toEqual({
        status: "thread-pending",
        queryId: status,
      });
      const resumed = await stores.checkpoints.acquire(identity, "resume");
      if (resumed.status !== "acquired") throw new Error("Expected same-query resumption.");
      expect(resumed.currentRevision).toBe(1);
      expect(resumed.lease.generation).toBe(2);
      expect(
        await stores.checkpoints.save(resumed.lease, 1, checkpoint(identity, "completed")),
      ).toEqual({ status: "saved", revision: 2 });
      expect(await stores.checkpoints.findUnfinished("agent", "thread")).toBeNull();
      expect(await stores.checkpoints.acquire(key, "before-release")).toEqual({
        status: "thread-pending",
        queryId: status,
      });
      await stores.checkpoints.release(resumed.lease);
    }
    const next = await stores.checkpoints.acquire(key, "new-query");
    expect(next).toMatchObject({
      status: "acquired",
      currentRevision: 0,
      checkpoint: null,
      lease: { generation: 1 },
    });
  });

  it("admits atomically before first save and preserves released empty-row generations", async () => {
    const path = databasePath();
    const first = openStores(path);
    const second = openStores(path);
    const otherKey = { ...key, queryId: "other" };
    const empty = await first.checkpoints.acquire(key, "first");
    if (empty.status !== "acquired") throw new Error("Expected initial empty lease.");
    expect(await second.checkpoints.findUnfinished(key.agentId, key.threadId)).toBeNull();
    expect(await second.checkpoints.acquire(otherKey, "second")).toEqual({
      status: "thread-pending",
      queryId: key.queryId,
    });
    expect(
      await second.checkpoints.acquire(otherKey, "second", {
        replace: { ...empty.lease, key: otherKey },
      }),
    ).toEqual({ status: "stale" });
    expect(await second.checkpoints.acquire(key, "first")).toEqual({
      status: "busy",
      lease: empty.lease,
    });
    expect(
      await second.checkpoints.acquire(key, "replacement", {
        replace: { ...empty.lease, generation: 0 },
      }),
    ).toEqual({ status: "stale" });
    for (const independent of [
      { ...key, threadId: "other-thread" },
      { ...key, agentId: "other-agent" },
    ]) {
      const acquired = await second.checkpoints.acquire(independent, "independent");
      expect(acquired.status).toBe("acquired");
      if (acquired.status !== "acquired") throw new Error("Expected independent admission.");
      await second.checkpoints.release(acquired.lease);
    }
    await first.checkpoints.release(empty.lease);
    const other = await second.checkpoints.acquire(otherKey, "second");
    expect(other).toMatchObject({ status: "acquired", lease: { generation: 1 } });
    if (other.status !== "acquired") throw new Error("Expected empty release to unblock.");
    expect(await first.checkpoints.acquire(key, "blocked")).toEqual({
      status: "thread-pending",
      queryId: otherKey.queryId,
    });
    await second.checkpoints.release(other.lease);
    const reacquired = await first.checkpoints.acquire(key, "first-again");
    expect(reacquired).toMatchObject({
      status: "acquired",
      lease: { generation: 2 },
      currentRevision: 0,
      checkpoint: null,
    });
    if (reacquired.status !== "acquired") throw new Error("Expected preserved empty row.");
    await first.checkpoints.save(reacquired.lease, 0, checkpoint(key, "completed"));
    expect(await second.checkpoints.acquire(otherKey, "before-terminal-release")).toEqual({
      status: "thread-pending",
      queryId: key.queryId,
    });
    await first.checkpoints.release(reacquired.lease);
    expect(await second.checkpoints.acquire(otherKey, "after-terminal-release")).toMatchObject({
      status: "acquired",
      lease: { generation: 2 },
      currentRevision: 0,
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

  it("reads a committed history snapshot while another connection holds an uncommitted write", async () => {
    const path = databasePath();
    const stores = openStores(path);
    const first: ModelMessage = { role: "user", content: [{ type: "text", text: "committed" }] };
    const second: ModelMessage = {
      role: "assistant",
      content: [{ type: "text", text: "next committed answer" }],
    };
    expect(await stores.history.append("thread", 0, [first], "first")).toEqual({
      status: "appended",
      revision: 1,
    });
    const writer = new DatabaseSync(path);
    cleanup.push(() => writer.close());
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("UPDATE general_agent_history SET revision = 2 WHERE thread_id = ?").run("thread");
    writer
      .prepare(
        "INSERT INTO general_agent_history_batches(thread_id, batch_id, revision, payload) VALUES (?, ?, ?, ?)",
      )
      .run("thread", "second", 2, JSON.stringify([second]));
    // 读必须在 writer 提交前完成，且 head 与消息只能来自同一已提交视图。
    expect(await stores.history.read("thread")).toEqual({
      threadId: "thread",
      revision: 1,
      messages: [first],
    });
    writer.exec("COMMIT");
    expect(await stores.history.read("thread")).toEqual({
      threadId: "thread",
      revision: 2,
      messages: [first, second],
    });
    expect(await stores.history.read("absent")).toEqual({
      threadId: "absent",
      revision: 0,
      messages: [],
    });
    expect(
      writer.prepare("SELECT thread_id FROM general_agent_history WHERE thread_id = ?").get("absent"),
    ).toBeUndefined();
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
