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
}

function worker(database: string) {
  const child = fork(resolve("tests/fixtures/general-agent-reliability-entry.mjs"), [database], {
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
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
  const startupTimer = setTimeout(() => {
    fail(new Error(`Reliability worker startup timed out; ${stderr}`));
    child.kill();
  }, 10000);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (text: string) => {
    stderr += text;
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
  });
  child.on("message", (value) => {
    const message = value as WorkerReply;
    if (message.type === "ready") {
      clearTimeout(startupTimer);
      ready.resolve(message);
    }
    else if (message.type === "boundary") boundary.resolve(message);
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
            } catch {
              // 关闭/命令失败仍须等待 close；不能在进程仍持有 WAL 时删除目录。
              child.kill();
            } finally {
              if (!ended && child.connected) child.disconnect();
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

describe("real-process Thread admission", () => {
  it.each(["model", "initial-save", "terminal-release"])(
    "fences another Query across the %s boundary and reopens from a third process",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "harness-admission-process-"));
      const database = join(directory, "sessions.sqlite");
      const first = worker(database);
      let second: ReturnType<typeof worker> | undefined;
      let inspector: ReturnType<typeof worker> | undefined;
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
