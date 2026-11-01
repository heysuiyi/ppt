import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelMessage } from "@agent-harness/core/model/model-contract";
import type { AgentCheckpoint } from "@agent-harness/core/session/session-contract";
import { afterEach, describe, expect, it } from "vitest";
import type { HostSessionBinding } from "../cli/host/host-session-binding";
import { listHostSessions } from "../cli/host/session-directory";
import { createSqliteAgentStores, type SqliteAgentStores } from "../cli/host/sqlite-agent-stores";

const cleanup: Array<() => void | Promise<void>> = [];
const publicIdentity = {
  model: { providerId: "mimo-token-plan-cn", modelId: "mimo-v2.5" },
  connectionFingerprint: "connection-fingerprint",
};

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "development-sessions-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return { root, workspace: realpathSync.native(workspace) };
}

function binding(threadId: string, workspaceRoot: string): HostSessionBinding {
  return {
    schemaVersion: 2,
    agentId: "development-agent",
    threadId,
    workspaceRoot,
    toolMode: "read-write",
    ...publicIdentity,
    definition: { id: "general", version: "1" },
    plugins: [{ id: "tools", version: "1" }],
    maxSteps: 12,
  };
}

async function saveCheckpoint(
  stores: SqliteAgentStores,
  threadId: string,
  queryId: string,
  status: Exclude<AgentCheckpoint["status"], "waiting">,
) {
  const identity = { agentId: "development-agent", threadId, queryId };
  const acquired = await stores.checkpoints.acquire(identity, "active-writer");
  if (acquired.status !== "acquired") throw new Error("Expected checkpoint acquisition.");
  const history = await stores.history.read(threadId);
  const base = {
    schemaVersion: 1 as const,
    ...identity,
    lastRunId: "run",
    definition: { id: "general", version: "1" },
    plugins: [{ id: "tools", version: "1" }],
    model: binding(threadId, "unused").model,
    maxSteps: 12,
    committed: { historyRevision: history.revision, messages: history.messages, step: 0 },
    startMessageCount: history.messages.length,
    extensions: [],
  };
  const checkpoint: AgentCheckpoint =
    status === "failed"
      ? { ...base, status, error: { code: "failure", message: "private failure" } }
      : { ...base, status };
  expect(await stores.checkpoints.save(acquired.lease, 0, checkpoint)).toMatchObject({
    status: "saved",
  });
  return acquired.lease;
}

describe("development session queries", () => {
  it("lists only workspace-bound sessions in checkpoint update order and exposes text only", async () => {
    const { root, workspace } = fixture();
    const databasePath = join(root, "sessions.sqlite");
    const stores = createSqliteAgentStores(databasePath);
    cleanup.push(() => stores.dispose());
    const messages: readonly ModelMessage[] = [
      { role: "system", content: [{ type: "text", text: "private system" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "hello " },
          { type: "image", source: { type: "url", url: "https://private.invalid/image" } },
          { type: "text", text: "world" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private reasoning" },
          { type: "tool-call", callId: "call", name: "read", input: { path: "private path" } },
        ],
        replayState: {
          providerId: "provider",
          modelId: "model",
          format: "private-replay",
          version: 1,
          data: { apiKey: "private-replay-key" },
        },
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            callId: "call",
            content: [{ type: "text", text: "private tool" }],
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "public answer" }] },
    ];
    for (const thread of ["older", "newer", "binding-only"]) {
      await stores.bindings.ensure(binding(thread, workspace));
    }
    await stores.bindings.ensure(binding("foreign", join(workspace, "different-workspace")));
    await stores.history.append("older", 0, messages, "canonical-history");
    await stores.history.append("unbound", 0, messages, "unbound-history");
    await saveCheckpoint(stores, "older", "older-running", "running");
    const completed = await saveCheckpoint(stores, "newer", "newer-completed", "completed");
    await stores.checkpoints.release(completed);
    // 已结束的前序 Query 与当前待决 Query 共存，不绕过线程准入创建多个活动请求。
    const heldLease = await saveCheckpoint(stores, "newer", "newer-interrupted", "interrupted");
    await saveCheckpoint(stores, "foreign", "foreign-query", "running");
    await saveCheckpoint(stores, "unbound", "unbound-query", "running");
    const database = new DatabaseSync(databasePath);
    cleanup.push(() => database.close());
    const before = database
      .prepare("SELECT * FROM general_agent_checkpoints ORDER BY query_id")
      .all();
    const canonical = await stores.history.read("older");

    const sessions = await listHostSessions(root, join(workspace, "."));
    expect(sessions).toEqual([
      {
        threadId: "newer",
        ...publicIdentity,
        toolMode: "read-write",
        history: [],
        unfinished: { queryId: "newer-interrupted", status: "interrupted" },
      },
      {
        threadId: "older",
        ...publicIdentity,
        toolMode: "read-write",
        history: [
          { role: "user", text: "hello \nworld" },
          { role: "assistant", text: "public answer" },
        ],
        unfinished: { queryId: "older-running", status: "running" },
      },
      {
        threadId: "binding-only",
        ...publicIdentity,
        toolMode: "read-write",
        history: [],
      },
    ]);
    expect(JSON.stringify(sessions)).not.toContain("private");
    expect(await stores.history.read("older")).toEqual(canonical);
    expect(
      database.prepare("SELECT * FROM general_agent_checkpoints ORDER BY query_id").all(),
    ).toEqual(before);
    expect(await stores.checkpoints.acquire(heldLease.key, "query-reader")).toMatchObject({
      status: "busy",
      lease: heldLease,
    });
  });

  it("returns only running, waiting and interrupted queries as unfinished", async () => {
    const { root, workspace } = fixture();
    const path = join(root, "sessions.sqlite");
    const stores = createSqliteAgentStores(path);
    cleanup.push(() => stores.dispose());
    for (const status of ["running", "interrupted", "completed", "cancelled", "failed"] as const) {
      await stores.bindings.ensure(binding(status, workspace));
      await saveCheckpoint(stores, status, `${status}-query`, status);
    }
    const waitingBinding = binding("waiting", workspace);
    await stores.bindings.ensure(waitingBinding);
    const waitingLease = await saveCheckpoint(stores, "waiting", "waiting-query", "running");
    const checkpoint = await stores.checkpoints.findUnfinished(waitingBinding.agentId, "waiting");
    if (!checkpoint) throw new Error("Expected running checkpoint.");
    const call = { type: "tool-call" as const, callId: "call", name: "approve", input: {} };
    expect(
      await stores.checkpoints.save(waitingLease, 1, {
        ...checkpoint,
        status: "waiting",
        inflight: {
          type: "tools",
          response: { message: { role: "assistant", content: [call] }, finishReason: "tool-calls" },
          remaining: [],
          completed: [],
        },
        pending: {
          invocation: {
            identity: { ...waitingLease.key, runId: "run" },
            call,
            toolVersion: "1",
            state: "pending",
          },
          interaction: {
            id: "interaction",
            owner: "approve",
            payload: { type: "approval", version: 1, data: {} },
          },
          continuation: { type: "approval", version: 1, data: {} },
          effects: "none",
        },
      }),
    ).toMatchObject({ status: "saved" });
    const sessions = await listHostSessions(root, workspace);
    expect(sessions.map((session) => [session.threadId, session.unfinished?.status])).toEqual([
      ["waiting", "waiting"],
      ["failed", undefined],
      ["cancelled", undefined],
      ["completed", undefined],
      ["interrupted", "interrupted"],
      ["running", "running"],
    ]);
  });

  it("hides unfinished Query assistant text, including an appended batch awaiting checkpoint acknowledgement", async () => {
    const { root, workspace } = fixture();
    const stores = createSqliteAgentStores(join(root, "sessions.sqlite"));
    cleanup.push(() => stores.dispose());
    await stores.bindings.ensure(binding("thread", workspace));
    const completed: readonly ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "settled answer" }] },
    ];
    await stores.history.append("thread", 0, completed, "first-query");
    const lease = await saveCheckpoint(stores, "thread", "pending-query", "running");
    await stores.history.append(
      "thread",
      1,
      [
        { role: "user", content: [{ type: "text", text: "second" }] },
        { role: "assistant", content: [{ type: "text", text: "unfinished private preview" }] },
      ],
      "pending-query:step",
    );
    const sessions = await listHostSessions(root, workspace);
    expect(sessions[0]?.history).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "settled answer" },
      { role: "user", text: "second" },
    ]);
    expect(sessions[0]?.unfinished).toEqual({ queryId: "pending-query", status: "running" });
    expect(await stores.checkpoints.acquire(lease.key, "reader")).toMatchObject({ status: "busy" });
  });

  it("does not create a missing database or its parent directory", async () => {
    const { root, workspace } = fixture();
    const dataRoot = join(root, "not-created");
    expect(await listHostSessions(dataRoot, workspace)).toEqual([]);
    expect(existsSync(dataRoot)).toBe(false);
  });

  it("closes a failed read without changing an unsupported binding", async () => {
    const { root, workspace } = fixture();
    const path = join(root, "sessions.sqlite");
    const stores = createSqliteAgentStores(path);
    await stores.dispose();
    const database = new DatabaseSync(path);
    const legacy = JSON.stringify({ ...binding("legacy", workspace), schemaVersion: 1 });
    database
      .prepare("INSERT INTO general_agent_host_bindings(thread_id, payload) VALUES (?, ?)")
      .run("legacy", legacy);
    database.close();
    await expect(listHostSessions(root, workspace)).rejects.toMatchObject({
      code: "HOST_BINDING_VERSION_UNSUPPORTED",
    });
    const reopened = new DatabaseSync(path);
    try {
      expect(
        reopened.prepare("SELECT payload FROM general_agent_host_bindings").get(),
      ).toMatchObject({ payload: legacy });
    } finally {
      reopened.close();
    }
    rmSync(path);
  });
});
