import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, type MockInstance, vi } from "vitest";
import {
  LEAD_TASK_PERMISSIONS,
  type PersistedTaskList,
  type TaskListIdentity,
  TaskStore,
} from "../../../app/main/agent/task/task-store";
import { writeTextFileAtomic } from "../dist/internal/files/atomic.js";

// 提交故障钩子仅在包内测试使用；任务消费者仍通过公共 atomic-files 读写。
it("waits for an atomic replacement before existing and initializing task readers load", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-task-atomic-"));
  const identity: TaskListIdentity = {
    taskListId: "thread-1",
    scope: "conversation",
    canonicalKey: "conversation:thread-1",
  };
  let continueCommit: (() => void) | undefined;
  const lockfile = createRequire(import.meta.url)("proper-lockfile") as {
    lock(file: string, options?: unknown): Promise<() => Promise<void>>;
  };
  let lockSpy: MockInstance | undefined;
  let writer: Promise<void> | undefined;
  try {
    const store = new TaskStore(root, identity);
    const lead = store.principal("lead", "lead", LEAD_TASK_PERMISSIONS);
    await store.mutate(
      {
        type: "create",
        subject: "Lead task",
        description: "",
        executionTarget: "lead",
        completionPolicy: "direct",
      },
      lead,
    );
    const { file } = await store.storageLocation();
    const replacement = JSON.parse(await readFile(file, "utf8")) as PersistedTaskList;
    replacement.tasks["1"].subject = "Committed replacement";
    replacement.tasks["1"].revision += 1;
    replacement.listRevision += 1;
    const displaced = Promise.withResolvers<void>();
    const readerEntered = Promise.withResolvers<void>();
    const acquire = lockfile.lock.bind(lockfile);
    let writerLockTarget: string | undefined;
    lockSpy = vi.spyOn(lockfile, "lock").mockImplementation((target, options) => {
      const pending = acquire(target, options);
      if (writerLockTarget === undefined) writerLockTarget = target;
      else if (target === writerLockTarget) readerEntered.resolve();
      return pending;
    });
    const release = Promise.withResolvers<void>();
    continueCommit = () => release.resolve();
    writer = writeTextFileAtomic(file, JSON.stringify(replacement), {
      commitGuard: {
        expectedTargetExists: true,
        async validatePath() {},
        async validateDisplaced() {
          displaced.resolve();
          await release.promise;
        },
      },
    });
    await displaced.promise;
    const existingReader = store.getSnapshot();
    const initializingReader = new TaskStore(root, identity).getSnapshot();
    await readerEntered.promise;
    continueCommit();
    await writer;
    await expect(existingReader).resolves.toMatchObject({ listRevision: replacement.listRevision });
    await expect(initializingReader).resolves.toMatchObject({
      listRevision: replacement.listRevision,
    });
  } finally {
    continueCommit?.();
    await writer?.catch(() => {});
    lockSpy?.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
