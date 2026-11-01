import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelMessage } from "@agent-harness/core/model/model-contract";
import type {
  CheckpointAcquireResult,
  CheckpointKey,
  CheckpointLease,
  CheckpointSaveResult,
} from "@agent-harness/core/session/checkpoint-contract";
import type {
  AgentCheckpoint,
  SessionHistory,
  SessionHistoryAppendResult,
} from "@agent-harness/core/session/session-contract";
import type { RuntimeEvent } from "@agent-harness/core/session/session-events";
import { describe, expect, it } from "vitest";
import type { HostSessionBinding } from "../cli/host/host-session-binding.js";

interface WorkerReply {
  readonly type: "ready" | "boundary" | "result";
  readonly requestId?: number;
  readonly pid?: number;
  readonly phase?: string;
  readonly status?: string;
  readonly error?: string;
  readonly modelCalls?: number;
  readonly history?: unknown;
  readonly checkpoint?: unknown;
  readonly generation?: number;
  readonly revision?: number;
  readonly acquisition?: CheckpointAcquireResult;
  readonly saved?: CheckpointSaveResult;
  readonly appended?: SessionHistoryAppendResult;
  readonly binding?: HostSessionBinding | null;
  readonly ensured?: boolean;
  readonly saves?: readonly AgentCheckpoint[];
  readonly events?: readonly RuntimeEvent[];
  readonly ledger?: readonly LedgerEntry[];
  readonly unfinished?: AgentCheckpoint | null;
}

interface ProcessWorker {
  readonly ready: Promise<WorkerReply>;
  readonly boundary: Promise<WorkerReply>;
  call(command: string, data?: Record<string, unknown>): Promise<WorkerReply>;
  close(): Promise<number | null>;
  kill(): Promise<number | null>;
}

function worker(database: string): ProcessWorker {
  const child = fork(resolve("tests/fixtures/general-agent-reliability-entry.mjs"), [database], {
    execArgv: [],
    // worker 只通过 IPC 回应；不用的 stdout 不建管道，避免退出后仍等待读端收口。
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const ready = Promise.withResolvers<WorkerReply>();
  const exited = Promise.withResolvers<number | null>();
  const boundary = Promise.withResolvers<WorkerReply>();
  const pending = new Map<
    number,
    { resolve(value: WorkerReply): void; reject(reason: unknown): void; timer: NodeJS.Timeout }
  >();
  let sequence = 0;
  let stderr = "";
  let ended = false;
  let closing: Promise<number | null> | undefined;
  // 原生子进程不使用假时钟；deadline 只负责失败回收，正确性由 IPC phase/close 驱动。
  const startupTimer = setTimeout(() => {
    fail(new Error(`Reliability worker startup timed out; ${stderr}`));
    child.kill();
  }, 10000);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (text: string) => {
    stderr = (stderr + text).slice(-8192);
  });
  // 启动/退出失败也会结束所有在途观察，测试失败时不留下悬空 Promise。
  void ready.promise.catch(() => {});
  void boundary.promise.catch(() => {});
  const fail = (error: Error) => {
    ready.reject(error);
    boundary.reject(error);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  child.on("error", (error) => {
    clearTimeout(startupTimer);
    fail(error);
  });
  // close 比 exit 更晚，确保 stdio/IPC 也已收口后才允许删除临时数据库。
  child.on("close", (code) => {
    clearTimeout(startupTimer);
    ended = true;
    exited.resolve(code);
    fail(new Error(`Reliability worker closed: ${code}; ${stderr}`));
  });
  child.on("message", (value) => {
    const message = value as WorkerReply;
    if (message.type === "ready") {
      clearTimeout(startupTimer);
      ready.resolve(message);
    } else if (message.type === "boundary") boundary.resolve(message);
    else if (message.requestId !== undefined) {
      const entry = pending.get(message.requestId);
      if (entry) {
        pending.delete(message.requestId);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    }
  });
  const call = (command: string, data: Record<string, unknown> = {}): Promise<WorkerReply> => {
    if (ended) return Promise.reject(new Error("Reliability worker is closed"));
    const requestId = ++sequence;
    const result = Promise.withResolvers<WorkerReply>();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      result.reject(new Error(`Reliability worker timed out: ${command}; ${stderr}`));
    }, 10000);
    pending.set(requestId, { ...result, timer });
    child.send({ command, requestId, ...data }, (error) => {
      if (!error) return;
      const entry = pending.get(requestId);
      if (entry) {
        pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.reject(error);
      }
    });
    return result.promise;
  };
  return {
    ready: ready.promise,
    boundary: boundary.promise,
    call,
    async kill() {
      // Do not disconnect or gracefully close: wait for forced death and stdio close.
      if (!ended && !child.kill("SIGKILL")) throw new Error("Reliability worker kill failed");
      return exited.promise;
    },
    close() {
      closing ??= (async () => {
        const deadline = setTimeout(() => {
          fail(new Error(`Reliability worker shutdown timed out; ${stderr}`));
          child.kill();
        }, 10000);
        try {
          if (!ended) {
            try {
              await call("close");
              // 应答后的 disconnect 归 worker；父端同步断开会与其竞争 IPC close。
            } catch {
              // 关闭/命令失败仍须等待 close；不能在进程仍持有 WAL 时删除目录。
              child.kill();
            }
          }
          return await exited.promise;
        } finally {
          clearTimeout(deadline);
        }
      })();
      return closing;
    },
  };
}

type Acquired = Extract<CheckpointAcquireResult, { status: "acquired" }>;
const storeKey: CheckpointKey = {
  agentId: "storage-agent",
  threadId: "storage-thread",
  queryId: "storage-query",
};
const textMessage = (text: string): ModelMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});
function storeBinding(label = "original"): HostSessionBinding {
  return {
    schemaVersion: 2,
    agentId: storeKey.agentId,
    threadId: storeKey.threadId,
    workspaceRoot: resolve("controlled-workspace"),
    toolMode: "none",
    model: { providerId: "controlled", modelId: "local" },
    connectionFingerprint: `connection:${label}`,
    definition: { id: "storage-definition", version: "1" },
    plugins: [],
    maxSteps: 3,
  };
}
function storeCheckpoint(label: string, messages: readonly ModelMessage[] = []): AgentCheckpoint {
  return {
    schemaVersion: 1,
    ...storeKey,
    lastRunId: label,
    definition: { id: "storage-definition", version: "1" },
    plugins: [],
    model: { providerId: "controlled", modelId: "local" },
    status: "running",
    committed: { historyRevision: messages.length ? 1 : 0, messages, step: 0 },
    startMessageCount: 0,
    maxSteps: 3,
    extensions: [{ type: "storage-fixture", version: 1, data: { label } }],
  };
}
function acquired(reply: WorkerReply): Acquired {
  expect(reply.error).toBeUndefined();
  expect(reply.acquisition?.status).toBe("acquired");
  if (reply.acquisition?.status !== "acquired") throw new Error("Expected acquired lease");
  return reply.acquisition;
}
async function store(
  target: ProcessWorker,
  operation: string,
  data: Record<string, unknown> = {},
): Promise<WorkerReply> {
  return target.call("store", { operation, ...data });
}
async function prepare(
  target: ProcessWorker,
  operation: string,
  data: Record<string, unknown>,
): Promise<void> {
  expect(await target.call("prepare", { operation, ...data })).toMatchObject({
    phase: "prepared",
  });
}
async function compete(
  first: ProcessWorker,
  second: ProcessWorker,
  operation: string,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Promise<[WorkerReply, WorkerReply]> {
  await Promise.all([prepare(first, operation, left), prepare(second, operation, right)]);
  // 两个真实连接所在的 PID 在 go 前均已准备好，不预定哪一侧提交。
  return Promise.all([first.call("go"), second.call("go")]);
}
async function processScenario(
  run: (scope: {
    first: ProcessWorker;
    second: ProcessWorker;
    reopen(): Promise<ProcessWorker>;
    connect(): Promise<ProcessWorker>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "harness-storage-process-"));
  const database = join(directory, "sessions.sqlite");
  const workers: ProcessWorker[] = [];
  const pids = new Set([process.pid]);
  const open = async () => {
    const instance = worker(database);
    workers.push(instance);
    const ready = await instance.ready;
    expect(ready.pid).toBeTypeOf("number");
    expect(pids.has(ready.pid as number)).toBe(false);
    pids.add(ready.pid as number);
    return instance;
  };
  try {
    // 初始化 schema/WAL 后才开第二个连接；本矩阵不把 DDL 竞争冒充存储竞争。
    const first = await open();
    const second = await open();
    await run({
      first,
      second,
      connect: open,
      async reopen() {
        for (const instance of workers) expect(await instance.close()).toBe(0);
        return open();
      },
    });
  } finally {
    await Promise.allSettled(workers.map((instance) => instance.close()));
    await rm(directory, { recursive: true, force: true });
  }
}
async function seedBindingAndHistory(target: ProcessWorker) {
  const binding = storeBinding();
  const messages = [textMessage("persisted input")];
  expect(await store(target, "ensure-binding", { binding })).toMatchObject({ ensured: true });
  expect(
    await store(target, "append-history", {
      threadId: storeKey.threadId,
      expectedRevision: 0,
      messages,
      batchId: "seed",
    }),
  ).toMatchObject({ appended: { status: "appended", revision: 1 } });
  return { binding, messages };
}
async function inspectStore(
  target: ProcessWorker,
  binding: HostSessionBinding | null,
  history: SessionHistory,
  checkpoint: AgentCheckpoint | null,
  revision: number,
  generation: number,
  replace?: CheckpointLease,
) {
  const reply = await store(target, "inspect-store", {
    key: storeKey,
    ownerId: "inspection",
    replace,
  });
  expect(reply.binding).toEqual(binding);
  expect(reply.history).toEqual(history);
  expect(acquired(reply)).toEqual({
    status: "acquired",
    lease: { key: storeKey, ownerId: "inspection", generation },
    currentRevision: revision,
    checkpoint,
  });
}

describe("real-process Thread admission", () => {
  it.each(["model", "initial-save", "terminal-release"])(
    "fences another Query across the %s boundary and reopens from a third process",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "harness-admission-process-"));
      const database = join(directory, "sessions.sqlite");
      const first = worker(database);
      let second: ProcessWorker | undefined;
      let inspector: ProcessWorker | undefined;
      let running: Promise<WorkerReply> | undefined;
      try {
        // 先完成空库 WAL/schema 初始化；本场景竞争执行准入，不竞争数据库配置 DDL。
        const a = await first.ready;
        second = worker(database);
        const b = await second.ready;
        expect(a.pid).not.toBe(b.pid);
        expect(a.pid).not.toBe(process.pid);
        expect(b.pid).not.toBe(process.pid);
        running = first.call("run", { mode, queryId: "first", runId: "first-run" });
        void running.catch(() => {});
        expect(await first.boundary).toMatchObject({ phase: mode, pid: a.pid });
        expect(
          await second.call("run", { mode: "plain", queryId: "second", runId: "blocked-run" }),
        ).toMatchObject({ error: "THREAD_PENDING", modelCalls: 0, pid: b.pid });
        await first.call("release");
        expect(await running).toMatchObject({ status: "completed", modelCalls: 1 });
        expect(
          await second.call("run", { mode: "plain", queryId: "second", runId: "allowed-run" }),
        ).toMatchObject({ status: "completed", modelCalls: 1 });
        expect(await first.close()).toBe(0);
        expect(await second.close()).toBe(0);
        inspector = worker(database);
        const c = await inspector.ready;
        expect(c.pid).not.toBe(a.pid);
        expect(c.pid).not.toBe(b.pid);
        expect(await inspector.call("inspect", { queryId: "first" })).toMatchObject({
          pid: c.pid,
          generation: 2,
          checkpoint: { queryId: "first", lastRunId: "first-run", status: "completed" },
          history: {
            threadId: "process-thread",
            revision: 4,
            messages: [
              { role: "user", content: [{ type: "text", text: "first" }] },
              { role: "assistant", content: [{ type: "text", text: "reply:first" }] },
              { role: "user", content: [{ type: "text", text: "second" }] },
              { role: "assistant", content: [{ type: "text", text: "reply:second" }] },
            ],
          },
        });
      } finally {
        await Promise.allSettled([first.close(), second?.close(), inspector?.close()]);
        if (running) await Promise.allSettled([running]);
        await rm(directory, { recursive: true, force: true });
      }
    },
    30000,
  );
});

describe("real-process SQLite persistence competition", () => {
  it.each(["different", "same"])(
    "C1-1 admits exactly one same-Query writer with %s owner IDs",
    async (owners) => {
      await processScenario(async ({ first, second, reopen }) => {
        const { binding, messages } = await seedBindingAndHistory(first);
        const results = await compete(
          first,
          second,
          "acquire",
          { key: storeKey, ownerId: "writer-a" },
          { key: storeKey, ownerId: owners === "same" ? "writer-a" : "writer-b" },
        );
        expect(results.map((reply) => reply.acquisition?.status).sort()).toEqual([
          "acquired",
          "busy",
        ]);
        const winnerIndex = results.findIndex((reply) => reply.acquisition?.status === "acquired");
        const winner = acquired(results[winnerIndex]);
        expect(winner).toEqual({
          status: "acquired",
          lease: {
            key: storeKey,
            ownerId: winnerIndex === 0 || owners === "same" ? "writer-a" : "writer-b",
            generation: 1,
          },
          currentRevision: 0,
          checkpoint: null,
        });
        expect(results[1 - winnerIndex].acquisition).toEqual({
          status: "busy",
          lease: winner.lease,
        });
        const checkpoint = storeCheckpoint(`winner-${winnerIndex}`, messages);
        expect(
          await store(winnerIndex === 0 ? first : second, "save", {
            lease: winner.lease,
            expectedRevision: 0,
            checkpoint,
          }),
        ).toMatchObject({ saved: { status: "saved", revision: 1 } });
        // 不 release 就退出；重开不能根据 owner 名称相同或进程死亡自动收养。
        const inspector = await reopen();
        const history = { threadId: storeKey.threadId, revision: 1, messages };
        const busy = await store(inspector, "inspect-store", {
          key: storeKey,
          ownerId: "ordinary-reopen",
        });
        expect(busy.binding).toEqual(binding);
        expect(busy.history).toEqual(history);
        expect(busy.acquisition).toEqual({ status: "busy", lease: winner.lease });
        await inspectStore(inspector, binding, history, checkpoint, 1, 2, winner.lease);
        // inspect 的精确接管与 finally release 也是真实持久写，下一次代际继续增长。
        await inspectStore(inspector, binding, history, checkpoint, 1, 3);
      });
    },
    30000,
  );

  it("C1-2 commits only one different payload for a shared legal lease/revision", async () => {
    await processScenario(async ({ first, second, reopen }) => {
      const { binding, messages } = await seedBindingAndHistory(first);
      const activation = acquired(
        await store(first, "acquire", { key: storeKey, ownerId: "shared-CAS-fixture" }),
      );
      const payloads = [
        storeCheckpoint("payload-a", messages),
        storeCheckpoint("payload-b", messages),
      ];
      const replies = await compete(
        first,
        second,
        "save",
        { lease: activation.lease, expectedRevision: 0, checkpoint: payloads[0] },
        { lease: activation.lease, expectedRevision: 0, checkpoint: payloads[1] },
      );
      expect(replies.map((reply) => reply.saved?.status).sort()).toEqual(["conflict", "saved"]);
      const winner = replies.findIndex((reply) => reply.saved?.status === "saved");
      expect(replies[winner].saved).toEqual({ status: "saved", revision: 1 });
      expect(replies[1 - winner].saved).toEqual({ status: "conflict", currentRevision: 1 });
      await store(first, "release-lease", { lease: activation.lease });
      await inspectStore(
        await reopen(),
        binding,
        { threadId: storeKey.threadId, revision: 1, messages },
        payloads[winner],
        1,
        2,
      );
    });
  }, 30000);

  it("C1-3 preserves the first different binding and accepts concurrent identical ensures", async () => {
    await processScenario(async ({ first, second, reopen }) => {
      const bindings = [storeBinding("a"), storeBinding("b")];
      const replies = await compete(
        first,
        second,
        "ensure-binding",
        { binding: bindings[0] },
        { binding: bindings[1] },
      );
      expect(replies.filter((reply) => reply.ensured === true)).toHaveLength(1);
      expect(replies.filter((reply) => reply.error === "HOST_BINDING_CHANGED")).toHaveLength(1);
      const winner = bindings[replies.findIndex((reply) => reply.ensured)];
      const identical = await compete(
        first,
        second,
        "ensure-binding",
        { binding: winner },
        { binding: winner },
      );
      for (const reply of identical) expect(reply).toMatchObject({ ensured: true });
      const messages = [textMessage("binding winner history")];
      expect(
        await store(first, "append-history", {
          threadId: storeKey.threadId,
          expectedRevision: 0,
          messages,
          batchId: "binding-history",
        }),
      ).toMatchObject({ appended: { status: "appended", revision: 1 } });
      const activation = acquired(
        await store(first, "acquire", { key: storeKey, ownerId: "binding-writer" }),
      );
      const checkpoint = storeCheckpoint("bound", messages);
      expect(
        await store(first, "save", { lease: activation.lease, expectedRevision: 0, checkpoint }),
      ).toMatchObject({ saved: { status: "saved", revision: 1 } });
      await store(first, "release-lease", { lease: activation.lease });
      await inspectStore(
        await reopen(),
        winner,
        { threadId: storeKey.threadId, revision: 1, messages },
        checkpoint,
        1,
        2,
      );
    });
  }, 30000);

  it.each(["different-batches", "same-receipt", "changed-content"])(
    "C1-4 arbitrates history %s and reopens the exact receipt",
    async (mode) => {
      await processScenario(async ({ first, second, reopen }) => {
        const binding = storeBinding();
        expect(await store(first, "ensure-binding", { binding })).toMatchObject({ ensured: true });
        const payloads = [
          [textMessage("batch-a:first"), textMessage("batch-a:second")],
          mode === "same-receipt"
            ? [textMessage("batch-a:first"), textMessage("batch-a:second")]
            : [textMessage("batch-b:first"), textMessage("batch-b:second")],
        ];
        const batchIds = ["batch-a", mode === "different-batches" ? "batch-b" : "batch-a"];
        const inputs = payloads.map((messages, index) => ({
          threadId: storeKey.threadId,
          expectedRevision: 0,
          messages,
          batchId: batchIds[index],
        }));
        const replies = await compete(first, second, "append-history", inputs[0], inputs[1]);
        const winner = replies.findIndex((reply) => reply.appended?.status === "appended");
        expect(winner).not.toBe(-1);
        expect(replies[winner].appended).toEqual({ status: "appended", revision: 1 });
        if (mode === "same-receipt") {
          for (const reply of replies)
            expect(reply.appended).toEqual({ status: "appended", revision: 1 });
        } else if (mode === "different-batches") {
          expect(replies[1 - winner].appended).toEqual({ status: "conflict", currentRevision: 1 });
        } else {
          expect(replies[1 - winner].error).toBe("history-batch-conflict");
        }
        // 推进 head 后仍以 expectedRevision=0 并发重放，收据必须优先于 CAS。
        const tail = [textMessage("later batch")];
        expect(
          await store(first, "append-history", {
            threadId: storeKey.threadId,
            expectedRevision: 1,
            messages: tail,
            batchId: "tail",
          }),
        ).toMatchObject({ appended: { status: "appended", revision: 2 } });
        const replay = inputs[winner];
        for (const reply of await compete(first, second, "append-history", replay, replay)) {
          expect(reply.appended).toEqual({ status: "appended", revision: 1 });
        }
        const changed = { ...replay, messages: [textMessage("not the original payload")] };
        expect(await store(second, "append-history", changed)).toMatchObject({
          error: "history-batch-conflict",
        });
        const messages = [...payloads[winner], ...tail];
        const checkpoint: AgentCheckpoint = {
          ...storeCheckpoint(`history-${mode}`, messages),
          committed: { historyRevision: 2, messages, step: 1 },
        };
        const activation = acquired(
          await store(first, "acquire", { key: storeKey, ownerId: "history-writer" }),
        );
        expect(
          await store(first, "save", { lease: activation.lease, expectedRevision: 0, checkpoint }),
        ).toMatchObject({ saved: { status: "saved", revision: 1 } });
        await store(first, "release-lease", { lease: activation.lease });
        const inspector = await reopen();
        await inspectStore(
          inspector,
          binding,
          { threadId: storeKey.threadId, revision: 2, messages },
          checkpoint,
          1,
          2,
        );
        expect(await store(inspector, "append-history", replay)).toMatchObject({
          appended: { status: "appended", revision: 1 },
        });
        expect(await store(inspector, "append-history", changed)).toMatchObject({
          error: "history-batch-conflict",
        });
        await inspectStore(
          inspector,
          binding,
          { threadId: storeKey.threadId, revision: 2, messages },
          checkpoint,
          1,
          3,
        );
      });
    },
    30000,
  );

  it("C1-5 takes over only after the old writer closes and fences its save/release/replace", async () => {
    await processScenario(async ({ first, second, reopen, connect }) => {
      const { binding, messages } = await seedBindingAndHistory(first);
      const old = acquired(await store(first, "acquire", { key: storeKey, ownerId: "old-writer" }));
      const original = storeCheckpoint("old-committed", messages);
      expect(
        await store(first, "save", {
          lease: old.lease,
          expectedRevision: 0,
          checkpoint: original,
        }),
      ).toMatchObject({ saved: { status: "saved", revision: 1 } });
      // 观察到 close（不只是提交应答）之后，宿主才有资格显式接管。
      expect(await first.close()).toBe(0);
      expect(
        await store(second, "acquire", { key: storeKey, ownerId: "new-writer" }),
      ).toMatchObject({ acquisition: { status: "busy", lease: old.lease } });
      const next = acquired(
        await store(second, "acquire", {
          key: storeKey,
          ownerId: "new-writer",
          replace: old.lease,
        }),
      );
      expect(next).toEqual({
        status: "acquired",
        lease: { key: storeKey, ownerId: "new-writer", generation: 2 },
        currentRevision: 1,
        checkpoint: original,
      });
      const checkpoint = storeCheckpoint("new-committed", messages);
      expect(
        await store(second, "save", { lease: next.lease, expectedRevision: 1, checkpoint }),
      ).toMatchObject({ saved: { status: "saved", revision: 2 } });
      // first 已关闭；独立 inspector PID 重开后模拟遗留 lease，而非复活旧 writer。
      const fence = await connect();
      expect(
        await store(fence, "save", {
          lease: old.lease,
          expectedRevision: 2,
          checkpoint: storeCheckpoint("forbidden-old-save"),
        }),
      ).toMatchObject({ saved: { status: "stale" } });
      await store(fence, "release-lease", { lease: old.lease });
      expect(
        await store(fence, "acquire", {
          key: storeKey,
          ownerId: "forbidden-old-replace",
          replace: old.lease,
        }),
      ).toMatchObject({ acquisition: { status: "stale" } });
      const busy = await store(fence, "inspect-store", { key: storeKey, ownerId: "probe" });
      expect(busy.binding).toEqual(binding);
      expect(busy.history).toEqual({ threadId: storeKey.threadId, revision: 1, messages });
      expect(busy.acquisition).toEqual({ status: "busy", lease: next.lease });
      const inspector = await reopen();
      await inspectStore(
        inspector,
        binding,
        { threadId: storeKey.threadId, revision: 1, messages },
        checkpoint,
        2,
        3,
        next.lease,
      );
    });
  }, 30000);

  it.each([
    ["history-head", "execution-first"],
    ["history-head", "binding-first"],
    ["empty-checkpoint", "execution-first"],
    ["empty-checkpoint", "binding-first"],
  ])(
    "C1-7 serializes binding with %s when %s commits",
    async (state, order) => {
      await processScenario(async ({ first, second, reopen }) => {
        const binding = storeBinding();
        await prepare(first, "ensure-binding", { binding });
        await prepare(
          second,
          state === "history-head" ? "append-history" : "acquire",
          state === "history-head"
            ? {
                threadId: storeKey.threadId,
                expectedRevision: 0,
                messages: [],
                batchId: "empty-head",
              }
            : { key: storeKey, ownerId: "empty-writer" },
        );
        let execution: WorkerReply;
        let ensured: WorkerReply;
        if (order === "execution-first") {
          execution = await second.call("go");
          ensured = await first.call("go");
          expect(ensured.error).toBe("HOST_BINDING_MISSING");
        } else {
          ensured = await first.call("go");
          expect(ensured).toMatchObject({ ensured: true });
          execution = await second.call("go");
        }
        if (state === "history-head") {
          expect(execution.appended).toEqual({ status: "appended", revision: 1 });
        } else {
          const lease = acquired(execution);
          expect(lease).toEqual({
            status: "acquired",
            lease: { key: storeKey, ownerId: "empty-writer", generation: 1 },
            currentRevision: 0,
            checkpoint: null,
          });
          await store(second, "release-lease", { lease: lease.lease });
        }
        const same = await store(first, "ensure-binding", { binding });
        const changed = await store(second, "ensure-binding", { binding: storeBinding("changed") });
        if (order === "execution-first") {
          expect(same.error).toBe("HOST_BINDING_MISSING");
          expect(changed.error).toBe("HOST_BINDING_MISSING");
        } else {
          expect(same.ensured).toBe(true);
          expect(changed.error).toBe("HOST_BINDING_CHANGED");
        }
        await inspectStore(
          await reopen(),
          order === "binding-first" ? binding : null,
          { threadId: storeKey.threadId, revision: state === "history-head" ? 1 : 0, messages: [] },
          null,
          0,
          state === "history-head" ? 1 : 2,
        );
      });
    },
    30000,
  );
});

interface LedgerEntry {
  readonly scenarioId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queryId: string;
  readonly runId: string;
  readonly callId: string;
  readonly phase: "execute" | "resume";
  readonly interactionId?: string;
  readonly pid: number;
  readonly nonce: string;
  readonly applied: boolean;
}
interface CrashCase {
  readonly id: string;
  readonly target:
    | "dispatch"
    | "consume"
    | "completion"
    | "effect"
    | "append"
    | "ack"
    | "terminal"
    | "acquire";
  readonly kind: "K0" | "K1" | "effect-before-save";
  readonly phase?: "execute" | "resume";
  readonly effects?: "none" | "applied";
  readonly batch?: "input" | "step:1" | "step:2";
  readonly terminal?: "completed" | "failed" | "cancelled";
  readonly acquireState?: "placeholder" | "waiting" | "running";
}
const crashCases: CrashCase[] = [];
for (const kind of ["K0", "K1"] as const) {
  crashCases.push({ id: "D1-1 dispatched", target: "dispatch", kind, phase: "execute" });
  for (const phase of ["execute", "resume"] as const) {
    for (const effects of phase === "resume" ? (["none", "applied"] as const) : (["none"] as const))
      crashCases.push({
        id: phase === "execute" ? "D1-2 completion" : "D1-4 completion",
        target: "completion",
        kind,
        phase,
        effects,
      });
  }
  for (const effects of ["none", "applied"] as const)
    crashCases.push({
      id: "D1-3 consumed answer",
      target: "consume",
      kind,
      phase: "resume",
      effects,
    });
  for (const batch of ["input", "step:1", "step:2"] as const) {
    for (const target of ["append", "ack"] as const)
      crashCases.push({
        id: target === "append" ? "D2-2 history append" : "D2-3 history acknowledgement",
        target,
        kind,
        batch,
      });
  }
  for (const terminal of ["completed", "failed", "cancelled"] as const)
    crashCases.push({ id: "D2-4 terminal", target: "terminal", kind, terminal });
  for (const acquireState of ["placeholder", "waiting", "running"] as const)
    crashCases.push({ id: "D2-1 acquire", target: "acquire", kind, acquireState });
}
for (const phase of ["execute", "resume"] as const) {
  for (const effects of phase === "resume" ? (["none", "applied"] as const) : (["none"] as const))
    crashCases.push({
      id: phase === "execute" ? "D1-2 effect" : "D1-4 effect",
      target: "effect",
      kind: "effect-before-save",
      phase,
      effects,
    });
}
const recoveryKey = (queryId: string): CheckpointKey => ({
  agentId: "recovery-agent",
  threadId: "recovery-thread",
  queryId,
});
const recoveryAnswer = { interactionId: "ledger-1:confirm", type: "answer", value: true };
function completionOf(state: AgentCheckpoint) {
  return "inflight" in state && state.inflight?.type === "tools"
    ? state.inflight.completed.find((item) => item.invocation.call.callId === "ledger-1")
        ?.completion
    : undefined;
}
function expectHistoryPairs(history: SessionHistory, terminal: string) {
  if (terminal !== "completed") {
    expect(history.revision).toBe(1);
    expect(history.messages.map((message) => message.role)).toEqual(["user"]);
    return;
  }
  expect(history.revision).toBe(3);
  expect(history.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
  const calls = history.messages.flatMap((message) =>
    message.content.filter((part) => part.type === "tool-call"),
  );
  const results = history.messages.flatMap((message) =>
    message.content.filter((part) => part.type === "tool-result"),
  );
  expect(calls).toHaveLength(1);
  expect(results).toHaveLength(1);
  expect(calls[0]).toMatchObject({ callId: "ledger-1" });
  expect(results[0]).toMatchObject({ callId: "ledger-1" });
}

describe("real-process recovery after forced writer death", () => {
  it.each(crashCases)(
    "$id $kind $phase $effects $batch $terminal $acquireState",
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "harness-recovery-crash-"));
      const database = join(directory, "sessions.sqlite");
      const ledgerPath = join(directory, "effects.jsonl");
      const queryId = "crash-query";
      const key = recoveryKey(queryId);
      const scenarioId = [
        scenario.id,
        scenario.kind,
        scenario.phase,
        scenario.effects,
        scenario.batch,
        scenario.terminal,
        scenario.acquireState,
      ]
        .filter(Boolean)
        .join(":");
      const processes: ProcessWorker[] = [];
      const killed = new Set<ProcessWorker>();
      const pids = new Set<number>([process.pid]);
      const open = async () => {
        const instance = worker(database);
        processes.push(instance);
        const ready = await instance.ready;
        expect(ready.pid).toBeTypeOf("number");
        expect(pids.has(ready.pid as number)).toBe(false);
        pids.add(ready.pid as number);
        return instance;
      };
      const common = {
        queryId,
        scenarioId,
        ledgerPath,
        wait: scenario.phase === "resume" || scenario.acquireState === "waiting",
        waitEffects: scenario.effects ?? "none",
      };
      const crash = async (
        instance: ProcessWorker,
        data: Record<string, unknown>,
        phase: string,
      ) => {
        const running = instance.call("recovery", { ...common, ...data });
        void running.catch(() => {});
        const boundary = await Promise.race([
          instance.boundary,
          running.then((reply) => {
            throw new Error(
              `Worker completed before crash boundary: ${reply.error ?? reply.status}`,
            );
          }),
        ]);
        expect(boundary).toMatchObject({ phase });
        await instance.kill();
        killed.add(instance);
        await expect(running).rejects.toThrow("Reliability worker closed");
      };
      try {
        let doomed = await open();
        let takeover: CheckpointLease | undefined;
        if (scenario.acquireState === "running") {
          await crash(
            doomed,
            {
              runId: "seed-running",
              fault: { target: "ack", kind: "K1", batchId: `${queryId}:input` },
            },
            "ack:K1",
          );
          doomed = await open();
          const busy = await store(doomed, "acquire", { key, ownerId: "seed-probe" });
          expect(busy.acquisition?.status).toBe("busy");
          if (busy.acquisition?.status !== "busy") throw new Error("Expected seed owner");
          takeover = busy.acquisition.lease;
        } else if (common.wait) {
          expect(await doomed.call("recovery", { ...common, runId: "seed-waiting" })).toMatchObject(
            { status: "waiting" },
          );
        }
        const batchId = scenario.batch ? `${queryId}:${scenario.batch}` : undefined;
        await crash(
          doomed,
          {
            runId: "doomed-run",
            takeover,
            resume:
              scenario.phase === "resume" ||
              scenario.acquireState === "waiting" ||
              scenario.acquireState === "running",
            response:
              scenario.phase === "resume" || scenario.acquireState === "waiting"
                ? recoveryAnswer
                : undefined,
            terminal: scenario.terminal,
            fault: {
              target: scenario.target,
              kind: scenario.kind,
              batchId,
              status: scenario.target === "terminal" ? scenario.terminal : undefined,
            },
          },
          `${scenario.target}:${scenario.kind}`,
        );

        // The replacement PID is created only after kill has reached close.
        const next = await open();
        const busy = await store(next, "inspect-store", {
          key,
          ownerId: "ordinary-reopen",
          ledgerPath,
        });
        expect(busy.acquisition?.status).toBe("busy");
        if (busy.acquisition?.status !== "busy")
          throw new Error("Crash must retain the exact owner");
        const old = busy.acquisition.lease;
        expect(old).toMatchObject({ key, ownerId: "doomed-run" });
        expect(
          await next.call("recovery", {
            ...common,
            queryId: "forbidden-query",
            runId: "blocked-new-query",
          }),
        ).toMatchObject({ error: "THREAD_PENDING", modelCalls: 0 });
        expect(
          await next.call("recovery", { ...common, resume: true, runId: "blocked-same-query" }),
        ).toMatchObject({ error: "WRITER_BUSY", modelCalls: 0 });
        const oldLedger = busy.ledger ?? [];
        const observed = acquired(
          await store(next, "acquire", { key, ownerId: "trusted-inspection", replace: old }),
        );
        expect(observed.lease.generation).toBe(old.generation + 1);
        const saved = observed.checkpoint;
        if (scenario.acquireState === "placeholder") {
          expect(saved).toBeNull();
          expect(observed.currentRevision).toBe(0);
          expect(busy.unfinished).toBeNull();
          expect(busy.history).toEqual({ threadId: key.threadId, revision: 0, messages: [] });
          expect(oldLedger).toEqual([]);
          // No input was saved: precise maintenance releases, never fabricates resume input.
          await store(next, "release-lease", { lease: observed.lease });
          const inspector = await open();
          const final = await store(inspector, "inspect-store", {
            key,
            ownerId: "third-pid",
            ledgerPath,
          });
          expect(acquired(final)).toMatchObject({
            currentRevision: 0,
            checkpoint: null,
            lease: { generation: old.generation + 2 },
          });
          expect(final.history).toEqual(busy.history);
          expect(final.ledger).toEqual([]);
          return;
        }
        if (!saved) throw new Error("Expected authoritative checkpoint");
        if (scenario.target === "dispatch") {
          expect(saved).toMatchObject({
            status: "running",
            inflight: { type: "tools", remaining: [{ state: "dispatched" }] },
          });
          expect(oldLedger).toHaveLength(0);
        }
        const consumed =
          scenario.target === "consume" ||
          (scenario.target === "effect" && scenario.phase === "resume");
        if (consumed)
          expect(saved).toMatchObject({
            status: "running",
            inflight: { type: "resume", pending: { effects: common.waitEffects } },
          });
        if (scenario.target === "completion")
          expect(completionOf(saved)).toMatchObject({ status: "succeeded", effects: "applied" });
        if (scenario.target === "effect" && scenario.phase === "execute")
          expect(saved).toMatchObject({
            inflight: { type: "tools", remaining: [{ state: "dispatched" }] },
          });
        if (scenario.target === "append") {
          expect(saved).toMatchObject({
            status: "running",
            inflight: { type: "history", batchId },
          });
          expect((busy.history as SessionHistory).revision).toBe(
            saved.committed.historyRevision + 1,
          );
        }
        if (scenario.target === "ack") {
          expect(saved.committed.historyRevision).toBe(
            scenario.batch === "input" ? 1 : scenario.batch === "step:1" ? 2 : 3,
          );
          if (scenario.kind === "K0" || scenario.batch === "step:2")
            expect("inflight" in saved ? saved.inflight : undefined).toBeUndefined();
          else expect(saved).toMatchObject({ inflight: { type: "model" } });
        }
        if (scenario.acquireState === "waiting") expect(saved.status).toBe("waiting");
        if (scenario.acquireState === "running") expect(saved.status).toBe("running");
        if (scenario.target === "terminal") expect(saved.status).toBe(scenario.terminal);
        const terminal = ["completed", "failed", "cancelled"].includes(saved.status);
        // Persist the exact authoritative payload under the replacement generation.
        // No client-created checkpoint or altered recovery state is introduced.
        expect(
          await store(next, "save", {
            lease: observed.lease,
            expectedRevision: observed.currentRevision,
            checkpoint: saved,
          }),
        ).toMatchObject({ saved: { status: "saved", revision: observed.currentRevision + 1 } });
        // Stale precedence wins over revision conflict; old release cannot clear new owner.
        expect(
          await store(next, "save", { lease: old, expectedRevision: 0, checkpoint: saved }),
        ).toMatchObject({ saved: { status: "stale" } });
        await store(next, "release-lease", { lease: old });
        expect(
          await store(next, "acquire", { key, ownerId: "old-replace", replace: old }),
        ).toMatchObject({ acquisition: { status: "stale" } });
        expect(await store(next, "acquire", { key, ownerId: "still-owned" })).toMatchObject({
          acquisition: { status: "busy", lease: observed.lease },
        });
        await store(next, "release-lease", { lease: observed.lease });
        if (consumed)
          expect(
            await next.call("recovery", {
              ...common,
              resume: true,
              response: recoveryAnswer,
              runId: "stale-answer",
            }),
          ).toMatchObject({ error: "STALE_INTERACTION", modelCalls: 0 });
        const recovered = await next.call("recovery", {
          ...common,
          resume: true,
          runId: "recovered-run",
          response: saved.status === "waiting" ? recoveryAnswer : undefined,
        });
        if (terminal) expect(recovered).toMatchObject({ error: "QUERY_TERMINAL", modelCalls: 0 });
        else {
          expect(recovered).toMatchObject({ status: "completed" });
          expect(recovered.acquisition).toMatchObject({ status: "acquired", checkpoint: saved });
          if (
            scenario.target === "dispatch" ||
            scenario.target === "consume" ||
            scenario.target === "effect"
          ) {
            const effects =
              scenario.phase === "resume" && scenario.effects === "applied" ? "applied" : "unknown";
            expect(recovered.events).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: "tool.completed",
                  identity: expect.objectContaining({ queryId, runId: "recovered-run" }),
                  completion: expect.objectContaining({ status: "unknown", effects }),
                }),
              ]),
            );
            expect(
              recovered.saves?.some(
                (state) =>
                  completionOf(state)?.status === "unknown" &&
                  completionOf(state)?.effects === effects,
              ),
            ).toBe(true);
          }
        }
        if (!terminal) {
          // D2-6: the new Run has now actually saved, not merely acquired its generation.
          expect(
            await store(next, "save", { lease: old, expectedRevision: 0, checkpoint: saved }),
          ).toMatchObject({ saved: { status: "stale" } });
          await store(next, "release-lease", { lease: old });
          expect(
            await store(next, "acquire", { key, ownerId: "late-old-replace", replace: old }),
          ).toMatchObject({ acquisition: { status: "stale" } });
        }
        expect(await next.call("recovery", { ...common, runId: "duplicate-run" })).toMatchObject({
          error: "QUERY_EXISTS",
          modelCalls: recovered.modelCalls,
        });
        expect(
          await next.call("recovery", { ...common, resume: true, runId: "terminal-resume" }),
        ).toMatchObject({ error: "QUERY_TERMINAL", modelCalls: recovered.modelCalls });
        expect(await next.close()).toBe(0);
        const inspector = await open();
        const final = await store(inspector, "inspect-store", {
          key,
          ownerId: "third-pid",
          ledgerPath,
        });
        const authoritative = acquired(final);
        expect(authoritative.checkpoint).toMatchObject({
          queryId,
          status: terminal ? saved.status : "completed",
        });
        expect(authoritative.lease.generation).toBe(old.generation + 5 + (consumed ? 1 : 0));
        expect(final.unfinished).toBeNull();
        expectHistoryPairs(final.history as SessionHistory, terminal ? saved.status : "completed");
        const entries = final.ledger ?? [];
        const executeCount =
          scenario.target === "dispatch" ||
          scenario.terminal === "failed" ||
          scenario.terminal === "cancelled"
            ? 0
            : 1;
        const resumeCount =
          scenario.phase === "resume"
            ? scenario.target === "consume"
              ? 0
              : 1
            : scenario.acquireState === "waiting"
              ? 1
              : 0;
        expect(entries.filter((entry) => entry.phase === "execute")).toHaveLength(executeCount);
        expect(entries.filter((entry) => entry.phase === "resume")).toHaveLength(resumeCount);
        expect(new Set(entries.map((entry) => entry.nonce)).size).toBe(entries.length);
        for (const entry of entries) {
          expect(entry).toMatchObject({
            scenarioId,
            ...key,
            callId: "ledger-1",
            pid: expect.any(Number),
            runId: expect.any(String),
            nonce: expect.any(String),
          });
          if (entry.phase === "resume")
            expect(entry.interactionId).toBe(recoveryAnswer.interactionId);
        }
        // Third-PID receipt replay proves exact stable batch/payload and no revision growth.
        const history = final.history as SessionHistory;
        if (history.revision === 3) {
          const batches = [
            { batchId: `${queryId}:input`, messages: history.messages.slice(0, 1) },
            { batchId: `${queryId}:step:1`, messages: history.messages.slice(1, 3) },
            { batchId: `${queryId}:step:2`, messages: history.messages.slice(3) },
          ];
          for (const [index, batch] of batches.entries())
            expect(
              await store(inspector, "append-history", {
                threadId: key.threadId,
                expectedRevision: index,
                ...batch,
              }),
            ).toMatchObject({ appended: { status: "appended", revision: index + 1 } });
          const again = await store(inspector, "inspect-store", {
            key,
            ownerId: "receipt-inspection",
            ledgerPath,
          });
          expect(again.history).toEqual(history);
          expect(again.ledger).toEqual(entries);
          expect(acquired(again).checkpoint).toEqual(authoritative.checkpoint);
        }
      } finally {
        await Promise.allSettled(
          processes.map((instance) =>
            killed.has(instance) ? Promise.resolve() : instance.close(),
          ),
        );
        await rm(directory, { recursive: true, force: true });
      }
    },
    30000,
  );
});
