import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelMessage } from "@agent-harness/core/model/model-contract";
import type { AgentCheckpoint } from "@agent-harness/core/session/session-contract";
import type { ToolCompletion } from "@agent-harness/core/tools/tool-contract";
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
  projection: {
    readonly startMessageCount?: number;
    readonly committed?: AgentCheckpoint["committed"];
  } = {},
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
    ...projection,
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
  it("lists workspace-bound sessions in checkpoint order with only public history fields", async () => {
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
          { type: "reasoning", text: "public reasoning" },
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
          { role: "reasoning", text: "public reasoning" },
          { role: "tool", tool: { callId: "call", name: "read", result: "recorded" } },
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

  it("hides all unfinished Query output, including an appended batch awaiting acknowledgement", async () => {
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
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "unfinished private reasoning" },
            { type: "tool-call", callId: "unconfirmed", name: "read", input: { secret: "input" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              callId: "unconfirmed",
              content: [{ type: "text", text: "unfinished private result" }],
            },
          ],
        },
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
    const checkpoint = await stores.checkpoints.findUnfinished("development-agent", "thread");
    if (!checkpoint) throw new Error("Expected unfinished checkpoint.");
    const acknowledged = await stores.history.read("thread");
    expect(
      await stores.checkpoints.save(lease, 1, {
        ...checkpoint,
        committed: {
          historyRevision: acknowledged.revision,
          messages: acknowledged.messages,
          step: 1,
        },
      }),
    ).toMatchObject({ status: "saved" });
    // 即使中间步已确认，未结束 Query 的正文、公开思考和工具项仍统一隐藏。
    expect((await listHostSessions(root, workspace))[0]?.history).toEqual(sessions[0]?.history);
  });

  it("preserves assistant content order and associates results at their original call positions", async () => {
    const { root, workspace } = fixture();
    const stores = createSqliteAgentStores(join(root, "sessions.sqlite"));
    cleanup.push(() => stores.dispose());
    await stores.bindings.ensure(binding("thread", workspace));
    await stores.history.append(
      "thread",
      0,
      [
        { role: "user", content: [{ type: "text", text: "inspect" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "public thought" },
            { type: "text", text: "be" },
            { type: "text", text: "fore" },
            { type: "tool-call", callId: "read", name: "read", input: { secret: "private input" } },
            { type: "text", text: "between" },
            { type: "tool-call", callId: "failed", name: "edit", input: {} },
            { type: "reasoning", text: "after calls" },
            { type: "tool-call", callId: "missing", name: "write", input: {} },
          ],
          replayState: {
            providerId: "provider",
            modelId: "model",
            format: "private",
            version: 1,
            data: { secret: "private replay" },
          },
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              callId: "failed",
              isError: true,
              content: [{ type: "text", text: "private error" }],
            },
            {
              type: "tool-result",
              callId: "read",
              content: [{ type: "text", text: "private result" }],
            },
            { type: "tool-result", callId: "orphan", content: [] },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "after" }] },
      ],
      "ordered",
    );
    const lease = await saveCheckpoint(stores, "thread", "query", "completed", {
      startMessageCount: 0,
    });
    await stores.checkpoints.release(lease);

    const sessions = await listHostSessions(root, workspace);
    expect(sessions[0]?.history).toEqual([
      { role: "user", text: "inspect" },
      { role: "reasoning", text: "public thought" },
      { role: "assistant", text: "before" },
      { role: "tool", tool: { callId: "read", name: "read", result: "recorded" } },
      { role: "assistant", text: "between" },
      { role: "tool", tool: { callId: "failed", name: "edit", result: "error" } },
      { role: "reasoning", text: "after calls" },
      { role: "tool", tool: { callId: "missing", name: "write", result: "missing" } },
      { role: "assistant", text: "after" },
    ]);
    expect(JSON.stringify(sessions)).not.toContain("private");
    expect(JSON.stringify(sessions)).not.toContain("orphan");
  });

  it("does not associate reused call IDs or orphan results across authoritative Query boundaries", async () => {
    const { root, workspace } = fixture();
    const stores = createSqliteAgentStores(join(root, "sessions.sqlite"));
    cleanup.push(() => stores.dispose());
    await stores.bindings.ensure(binding("thread", workspace));
    await stores.history.append(
      "thread",
      0,
      [
        { role: "user", content: [{ type: "text", text: "first" }] },
        {
          role: "assistant",
          content: [{ type: "tool-call", callId: "shared", name: "read", input: {} }],
        },
      ],
      "first",
    );
    const first = await saveCheckpoint(stores, "thread", "first", "completed", {
      startMessageCount: 0,
    });
    await stores.checkpoints.release(first);
    // 第二 Query 无 user 文本，仍必须按检查点起点隔离关联，而非全线程 callId map。
    await stores.history.append(
      "thread",
      1,
      [
        {
          role: "tool",
          content: [{ type: "tool-result", callId: "shared", content: [] }],
        },
        {
          role: "assistant",
          content: [{ type: "tool-call", callId: "shared", name: "edit", input: {} }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", callId: "shared", isError: true, content: [] }],
        },
      ],
      "second",
    );
    const second = await saveCheckpoint(stores, "thread", "second", "completed", {
      startMessageCount: 2,
    });
    await stores.checkpoints.release(second);
    expect((await listHostSessions(root, workspace))[0]?.history).toEqual([
      { role: "user", text: "first" },
      { role: "tool", tool: { callId: "shared", name: "read", result: "missing" } },
      { role: "tool", tool: { callId: "shared", name: "edit", result: "error" } },
    ]);
  });

  it.each(["revision", "length", "prefix"] as const)(
    "rejects a committed %s mismatch without losing an older acknowledged prefix",
    async (mismatch) => {
      const { root, workspace } = fixture();
      const stores = createSqliteAgentStores(join(root, "sessions.sqlite"));
      cleanup.push(() => stores.dispose());
      await stores.bindings.ensure(binding("thread", workspace));
      await stores.history.append(
        "thread",
        0,
        [
          { role: "user", content: [{ type: "text", text: "first" }] },
          { role: "assistant", content: [{ type: "text", text: "confirmed" }] },
        ],
        "first",
      );
      const first = await saveCheckpoint(stores, "thread", "first", "completed", {
        startMessageCount: 0,
      });
      await stores.checkpoints.release(first);
      await stores.history.append(
        "thread",
        1,
        [
          { role: "user", content: [{ type: "text", text: "second" }] },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "unconfirmed reasoning" },
              { type: "text", text: "unconfirmed answer" },
              { type: "tool-call", callId: "call", name: "read", input: {} },
            ],
          },
          {
            role: "tool",
            content: [{ type: "tool-result", callId: "call", content: [] }],
          },
        ],
        "second",
      );
      const history = await stores.history.read("thread");
      const committed = {
        historyRevision: mismatch === "revision" ? history.revision + 1 : history.revision,
        messages:
          mismatch === "length"
            ? history.messages.slice(0, -1)
            : mismatch === "prefix"
              ? [
                  {
                    role: "user" as const,
                    content: [{ type: "text" as const, text: "different" }],
                  },
                  ...history.messages.slice(1),
                ]
              : history.messages,
        step: 1,
      };
      const second = await saveCheckpoint(stores, "thread", "second", "completed", {
        startMessageCount: 2,
        committed,
      });
      await stores.checkpoints.release(second);
      expect((await listHostSessions(root, workspace))[0]?.history).toEqual([
        { role: "user", text: "first" },
        { role: "assistant", text: "confirmed" },
        { role: "user", text: "second" },
      ]);
    },
  );

  it("keeps an unacknowledged result missing even when its Query is already cancelled", async () => {
    const { root, workspace } = fixture();
    const stores = createSqliteAgentStores(join(root, "sessions.sqlite"));
    cleanup.push(() => stores.dispose());
    await stores.bindings.ensure(binding("thread", workspace));
    await stores.history.append(
      "thread",
      0,
      [
        { role: "user", content: [{ type: "text", text: "read" }] },
        {
          role: "assistant",
          content: [{ type: "tool-call", callId: "call", name: "read", input: {} }],
        },
      ],
      "call",
    );
    const lease = await saveCheckpoint(stores, "thread", "query", "cancelled", {
      startMessageCount: 0,
    });
    await stores.checkpoints.release(lease);
    await stores.history.append(
      "thread",
      1,
      [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              callId: "call",
              content: [{ type: "text", text: "private result" }],
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "unconfirmed answer" }] },
      ],
      "unacknowledged",
    );
    const session = (await listHostSessions(root, workspace))[0];
    expect(session?.unfinished).toBeUndefined();
    expect(session?.history).toEqual([
      { role: "user", text: "read" },
      { role: "tool", tool: { callId: "call", name: "read", result: "missing" } },
    ]);
  });

  it("retains safe completion facts by Query and step, including applied effects after cancellation, without exposing unfinished assistant content", async () => {
    const { root, workspace } = fixture();
    const path = join(root, "sessions.sqlite");
    const stores = createSqliteAgentStores(path);
    cleanup.push(() => stores.dispose());
    await stores.bindings.ensure(binding("thread", workspace));
    let historyRevision = 0;
    let messages: readonly ModelMessage[] = [];
    async function query(queryId: string, outcomes: readonly ToolCompletion[], cancel = false) {
      const startMessageCount = messages.length;
      const input: ModelMessage = { role: "user", content: [{ type: "text", text: queryId }] };
      const appended = await stores.history.append(
        "thread",
        historyRevision,
        [input],
        `${queryId}-input`,
      );
      if (appended.status !== "appended") throw new Error("Expected append");
      historyRevision = appended.revision;
      messages = [...messages, input];
      const lease = await stores.checkpoints.acquire(
        { agentId: "development-agent", threadId: "thread", queryId },
        `writer-${queryId}`,
      );
      if (lease.status !== "acquired") throw new Error("Expected lease");
      let revision = 0;
      const base = {
        schemaVersion: 1 as const,
        ...lease.lease.key,
        lastRunId: `run-${queryId}`,
        definition: { id: "general", version: "1" },
        plugins: [{ id: "tools", version: "1" }],
        model: publicIdentity.model,
        maxSteps: 12,
        startMessageCount,
        extensions: [],
      };
      for (const [index, completion] of outcomes.entries()) {
        const step = index + 1;
        const call = {
          type: "tool-call" as const,
          callId: "reused",
          name: "read",
          input: { path: `${queryId}-${step}.txt` },
        };
        const assistant: ModelMessage & { role: "assistant" } = {
          role: "assistant",
          content: [
            { type: "text", text: `${queryId}-${step}-PRIVATE_UNCOMMITTED_ASSISTANT` },
            call,
          ],
        };
        const checkpoint: AgentCheckpoint = {
          ...base,
          status: "running",
          committed: { historyRevision, messages, step: index },
          inflight: {
            type: "tools",
            response: { message: assistant, finishReason: "tool-calls" },
            remaining: [],
            completed: [
              {
                invocation: {
                  identity: { ...lease.lease.key, runId: `run-${queryId}` },
                  call,
                  toolVersion: "1",
                  state: "dispatched",
                },
                completion,
              },
            ],
          },
        };
        expect(await stores.checkpoints.save(lease.lease, revision++, checkpoint)).toMatchObject({
          status: "saved",
        });
        const running = (await listHostSessions(root, workspace))[0]!.history;
        expect(JSON.stringify(running)).not.toContain(
          `${queryId}-${step}-PRIVATE_UNCOMMITTED_ASSISTANT`,
        );
        expect(JSON.stringify(running)).not.toContain("PRIVATE_RAW");
        if (cancel) {
          expect(
            await stores.checkpoints.save(lease.lease, revision++, {
              ...base,
              status: "cancelled",
              committed: checkpoint.committed,
            }),
          ).toMatchObject({ status: "saved" });
          break;
        }
        const tool: ModelMessage = {
          role: "tool",
          content: [
            {
              type: "tool-result",
              callId: "reused",
              content: [{ type: "text", text: "PRIVATE_RAW" }],
              ...(completion.status !== "succeeded" ? { isError: true } : {}),
            },
          ],
        };
        const appended = await stores.history.append(
          "thread",
          historyRevision,
          [assistant, tool],
          `${queryId}-${step}`,
        );
        if (appended.status !== "appended") throw new Error("Expected append");
        historyRevision = appended.revision;
        messages = [...messages, assistant, tool];
      }
      if (!cancel)
        expect(
          await stores.checkpoints.save(lease.lease, revision, {
            ...base,
            status: "completed",
            committed: { historyRevision, messages, step: outcomes.length },
          }),
        ).toMatchObject({ status: "saved" });
      await stores.checkpoints.release(lease.lease);
    }
    const success = (queryId: string, step: number): ToolCompletion => ({
      status: "succeeded",
      effects: "none",
      output: "PRIVATE_RAW",
      modelContent: [],
      presentation: {
        type: "tools.read",
        version: 1,
        data: {
          path: `${queryId}-${step}.txt`,
          size: 10,
          startOffset: 0,
          endOffset: 10,
          totalCharacters: 10,
          hasMore: false,
          previewTruncated: false,
          preview: [`${queryId}-${step}`],
        },
      },
    });
    await query("first", [success("first", 1), success("first", 2)]);
    await query("second", [success("second", 1)]);
    const error = {
      code: "UNKNOWN\u001b",
      message: "public failure",
      details: { private: "PRIVATE_DETAILS" },
    };
    await query(
      "cancelled",
      [{ status: "unknown", effects: "applied", error, modelContent: [] }],
      true,
    );
    // 下一轮用户消息与已取消的未提交助手位置重合，不能覆盖其已确认影响。
    await query("after-cancel", [success("after-cancel", 1)]);
    await stores.dispose();
    const history = (await listHostSessions(root, workspace))[0]!.history;
    const tools = history.filter((entry) => entry.role === "tool").map((entry) => entry.tool);
    expect(tools.map((tool) => [tool.identity?.queryId, tool.step, tool.display?.output])).toEqual([
      ["first", 1, ["first-1"]],
      ["first", 2, ["first-2"]],
      ["second", 1, ["second-1"]],
      ["cancelled", 1, []],
      ["after-cancel", 1, ["after-cancel-1"]],
    ]);
    expect(tools[3]).toMatchObject({
      status: "unknown",
      effects: "applied",
      result: "missing",
      error: { code: "UNKNOWN\\x1b", message: "public failure" },
    });
    expect(tools[0]).toMatchObject({ status: "completed", effects: "none", result: "recorded" });
    expect(JSON.stringify(history)).not.toContain("PRIVATE_DETAILS");
    expect(JSON.stringify(history)).not.toContain("PRIVATE_RAW");
  });

  it("persists only recognized bounded presentation data, keeps safe failures and does not guess dispatched outcomes", async () => {
    const { root, workspace } = fixture();
    const path = join(root, "sessions.sqlite");
    const stores = createSqliteAgentStores(path);
    cleanup.push(() => stores.dispose());
    await stores.bindings.ensure(binding("thread", workspace));
    await stores.history.append(
      "thread",
      0,
      [{ role: "user", content: [{ type: "text", text: "inspect" }] }],
      "input",
    );
    const lease = await saveCheckpoint(stores, "thread", "query", "running", {
      startMessageCount: 0,
    });
    const checkpoint = await stores.checkpoints.findUnfinished("development-agent", "thread");
    if (!checkpoint) throw new Error("Expected checkpoint");
    const identity = { ...lease.key, runId: "original-run" };
    const readData = {
      path: "allowed.txt",
      size: 100,
      startOffset: 0,
      endOffset: 100,
      totalCharacters: 100,
      hasMore: false,
      previewTruncated: false,
      preview: Array.from({ length: 300 }, () => "x".repeat(3000)),
      raw: "PRIVATE_PRESENTATION_RAW",
    };
    const cases = [
      {
        id: "bounded",
        name: "read",
        toolVersion: "1",
        presentation: { type: "tools.read", version: 1, data: readData },
      },
      {
        id: "malformed",
        name: "read",
        toolVersion: "1",
        presentation: { type: "tools.read", version: 1, data: { preview: ["PRIVATE_MALFORMED"] } },
      },
      {
        id: "presentation-version",
        name: "read",
        toolVersion: "1",
        presentation: { type: "tools.read", version: 2, data: readData },
      },
      {
        id: "tool-version",
        name: "read",
        toolVersion: "2",
        presentation: { type: "tools.read", version: 1, data: readData },
      },
      {
        id: "unrecognized",
        name: "private-tool",
        toolVersion: "1",
        presentation: { type: "tools.read", version: 1, data: readData },
      },
    ];
    const completed = cases.map((item) => ({
      invocation: {
        identity,
        call: {
          type: "tool-call" as const,
          callId: item.id,
          name: item.name,
          input: { path: "allowed.txt", secret: "PRIVATE_INPUT" },
        },
        toolVersion: item.toolVersion,
        state: "dispatched" as const,
      },
      completion: {
        status: "succeeded" as const,
        effects: "none" as const,
        output: "PRIVATE_RAW",
        modelContent: [{ type: "text" as const, text: "PRIVATE_MODEL_CONTENT" }],
        presentation: item.presentation,
      },
    }));
    const failed = {
      invocation: {
        identity,
        call: {
          type: "tool-call" as const,
          callId: "failed",
          name: "read",
          input: { path: "allowed.txt" },
        },
        toolVersion: "1",
        state: "dispatched" as const,
      },
      completion: {
        status: "failed" as const,
        effects: "none" as const,
        error: { code: "READ_FAILED", message: "Public failure", details: "PRIVATE_ERROR" },
        modelContent: [],
      },
    };
    const remaining = (["dispatched", "pending"] as const).map((state) => ({
      identity,
      call: {
        type: "tool-call" as const,
        callId: state,
        name: "read",
        input: { path: "allowed.txt" },
      },
      toolVersion: "1",
      state,
    }));
    const calls = [
      ...completed.map((entry) => entry.invocation.call),
      failed.invocation.call,
      ...remaining.map((entry) => entry.call),
    ];
    const next: AgentCheckpoint = {
      ...checkpoint,
      status: "running",
      inflight: {
        type: "tools",
        response: {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "PRIVATE_ASSISTANT" }, ...calls],
          },
          finishReason: "tool-calls",
        },
        remaining,
        completed: [...completed, failed],
      },
    };
    expect(await stores.checkpoints.save(lease, 1, next)).toMatchObject({ status: "saved" });
    // 拒绝的 CAS 不得更改展示副本。
    expect(
      await stores.checkpoints.save(lease, 1, {
        ...next,
        committed: { historyRevision: 0, messages: [], step: 0 },
      }),
    ).toMatchObject({ status: "conflict" });
    const takeover = await stores.checkpoints.acquire(lease.key, "replacement", { replace: lease });
    expect(takeover.status).toBe("acquired");
    expect(
      await stores.checkpoints.save(lease, 2, {
        ...next,
        committed: { historyRevision: 0, messages: [], step: 0 },
      }),
    ).toMatchObject({ status: "stale" });
    const history = (await listHostSessions(root, workspace))[0]!.history;
    const tools = history.filter((entry) => entry.role === "tool").map((entry) => entry.tool);
    expect(tools).toHaveLength(6);
    expect(tools.find((tool) => tool.callId === "failed")).toMatchObject({
      status: "failed",
      effects: "none",
      error: { code: "READ_FAILED", message: "Public failure" },
    });
    expect(tools.find((tool) => tool.callId === "dispatched")).toBeUndefined();
    expect(tools.find((tool) => tool.callId === "pending")).toBeUndefined();
    expect(tools.find((tool) => tool.callId === "tool-version")?.display).toBeUndefined();
    expect(tools.find((tool) => tool.callId === "unrecognized")?.display).toBeUndefined();
    expect(tools.find((tool) => tool.callId === "malformed")?.display?.output).toEqual([]);
    expect(tools.find((tool) => tool.callId === "presentation-version")?.display?.output).toEqual(
      [],
    );
    const bounded = tools.find((tool) => tool.callId === "bounded")!.display!;
    expect(bounded.output.length).toBeLessThanOrEqual(200);
    expect(bounded.output).toContain("… preview truncated");
    const lines = [bounded.title, ...bounded.input, ...(bounded.summary ?? []), ...bounded.output];
    expect(lines.every((line) => line.length <= 2000)).toBe(true);
    expect(Buffer.byteLength(lines.join("\n"), "utf8")).toBeLessThanOrEqual(128 * 1024);
    expect(JSON.stringify(history)).not.toContain("PRIVATE_");
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        JSON.stringify(
          database.prepare("SELECT payload FROM general_agent_host_tool_displays").all(),
        ),
      ).not.toContain("PRIVATE_");
    } finally {
      database.close();
    }
    if (takeover.status !== "acquired" || next.inflight?.type !== "tools")
      throw new Error("Expected tools and lease");
    expect(
      await stores.checkpoints.save(takeover.lease, 2, { ...next, status: "interrupted" }),
    ).toMatchObject({ status: "saved" });
    const stopped = (await listHostSessions(root, workspace))[0]!.history;
    expect(stopped).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool: expect.objectContaining({
          callId: "dispatched",
          status: "unknown",
          effects: "unknown",
          result: "missing",
        }),
      }),
    );
    expect(stopped.some((entry) => entry.role === "tool" && entry.tool.callId === "pending")).toBe(
      false,
    );
    const pending = remaining[1]!;
    const waiting: AgentCheckpoint = {
      ...next,
      status: "waiting",
      inflight: { ...next.inflight, remaining: [remaining[0]!] },
      pending: {
        invocation: pending,
        interaction: {
          id: "partial",
          owner: "read",
          payload: { type: "approval", version: 1, data: {} },
        },
        continuation: { type: "approval", version: 1, data: {} },
        effects: "applied",
      },
    };
    expect(await stores.checkpoints.save(takeover.lease, 3, waiting)).toMatchObject({
      status: "saved",
    });
    const partial = (await listHostSessions(root, workspace))[0]!.history.find(
      (entry) => entry.role === "tool" && entry.tool.callId === "pending",
    );
    expect(partial).toMatchObject({ tool: { effects: "applied", result: "missing" } });
    if (partial?.role !== "tool") throw new Error("Expected applied fact");
    expect(partial.tool.status).toBeUndefined();
    expect(partial.tool.error).toBeUndefined();
    const unknown: AgentCheckpoint = {
      ...next,
      status: "running",
      inflight: {
        ...next.inflight,
        remaining: [remaining[0]!],
        completed: [
          ...next.inflight.completed,
          {
            invocation: pending,
            completion: {
              status: "unknown",
              effects: "unknown",
              error: { code: "OUTCOME_UNKNOWN", message: "Public unknown outcome" },
              modelContent: [],
            },
          },
        ],
      },
    };
    expect(await stores.checkpoints.save(takeover.lease, 4, unknown)).toMatchObject({
      status: "saved",
    });
    expect((await listHostSessions(root, workspace))[0]!.history).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool: expect.objectContaining({
          callId: "pending",
          status: "unknown",
          effects: "applied",
          error: { code: "OUTCOME_UNKNOWN", message: "Public unknown outcome" },
        }),
      }),
    );
  });

  it("reads an old database without creating preview schema or pretending recorded results succeeded", async () => {
    const { root, workspace } = fixture();
    const path = join(root, "sessions.sqlite");
    const stores = createSqliteAgentStores(path);
    await stores.bindings.ensure(binding("thread", workspace));
    await stores.history.append(
      "thread",
      0,
      [
        { role: "user", content: [{ type: "text", text: "read" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              callId: "old",
              name: "read",
              input: { path: "must-not-be-read.txt" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              callId: "old",
              content: [{ type: "text", text: "PRIVATE_OLD_RAW" }],
            },
          ],
        },
      ],
      "old",
    );
    const lease = await saveCheckpoint(stores, "thread", "old", "completed", {
      startMessageCount: 0,
    });
    await stores.checkpoints.release(lease);
    await stores.dispose();
    const database = new DatabaseSync(path);
    database.exec("DROP TABLE general_agent_host_tool_displays");
    database.close();
    const before = new DatabaseSync(path, { readOnly: true });
    const version = before.prepare("PRAGMA schema_version").get();
    before.close();
    expect((await listHostSessions(root, workspace))[0]?.history).toEqual([
      { role: "user", text: "read" },
      { role: "tool", tool: { callId: "old", name: "read", result: "recorded" } },
    ]);
    const reopened = new DatabaseSync(path, { readOnly: true });
    try {
      expect(reopened.prepare("PRAGMA schema_version").get()).toEqual(version);
      expect(
        reopened
          .prepare("SELECT name FROM sqlite_master WHERE name = 'general_agent_host_tool_displays'")
          .get(),
      ).toBeUndefined();
    } finally {
      reopened.close();
    }
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
