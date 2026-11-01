import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type DurableRunCheckpoint,
  DurableRunStore,
} from "../app/main/agent/persistence/durable-run-store";
import { CheckpointCoordinator } from "../app/main/agent/runtime/lifecycle/checkpoint-coordinator";
import { ConversationDatabase } from "../app/main/conversation-database";

function checkpoint(
  threadId: string,
  status: DurableRunCheckpoint["status"],
): DurableRunCheckpoint {
  const now = new Date().toISOString();
  return {
    version: 1,
    threadId,
    runId: "run-a",
    status,
    phase: status === "running" ? "before_model" : "finished",
    request: "request",
    baseRevision: 0,
    modelStep: 1,
    modelMessages: [],
    transcript: [],
    queuedToolUses: [],
    pendingToolResults: [],
    pendingUserContent: [],
    discoveredToolNames: [],
    loadedSkillNames: [],
    createdAt: now,
    updatedAt: now,
  };
}

describe("DurableRunStore lease CAS", () => {
  it("serializes two revisions under one file-backed lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "durable-run-lease-"));
    const store = new DurableRunStore(root);
    const opened = await store.openLease({ threadId: "thread", runId: "run-a", resume: false });
    expect(opened.type).toBe("opened");
    if (opened.type !== "opened") return;

    await expect(
      store.saveCas({
        lease: opened.lease,
        expectedRevision: 0,
        nextRevision: 1,
        checkpoint: checkpoint("thread", "running"),
      }),
    ).resolves.toBe("saved");
    await expect(
      store.saveCas({
        lease: opened.lease,
        expectedRevision: 1,
        nextRevision: 2,
        checkpoint: checkpoint("thread", "completed"),
      }),
    ).resolves.toBe("saved");
  });

  it("does not let an older file-backed lease close a newer generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "durable-run-lease-close-"));
    const store = new DurableRunStore(root);
    const first = await store.openLease({ threadId: "thread", runId: "run-a", resume: false });
    expect(first.type).toBe("opened");
    if (first.type !== "opened") return;
    const second = await store.openLease({
      threadId: "thread",
      runId: "run-b",
      resume: true,
      allowTakeover: true,
    });
    expect(second.type).toBe("opened");
    await expect(store.closeLease(first.lease)).resolves.toBe(false);
  });

  it("lets the coordinator advance from a normal snapshot to terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "durable-run-coordinator-"));
    const store = new DurableRunStore(root);
    const opened = await store.openLease({ threadId: "thread", runId: "run-a", resume: false });
    expect(opened.type).toBe("opened");
    if (opened.type !== "opened") return;
    const coordinator = new CheckpointCoordinator(store, opened.lease, opened.currentRevision);
    await coordinator.commit(checkpoint("thread", "running"));
    await coordinator.commitTerminal(checkpoint("thread", "completed"));
    await coordinator.close();
    await expect(store.load("thread")).resolves.toMatchObject({ status: "completed" });
    const next = await store.openLease({
      threadId: "thread",
      runId: "run-b",
      resume: false,
    });
    expect(next).toMatchObject({
      type: "opened",
      checkpoint: { status: "completed" },
    });
    if (next.type === "opened") await store.closeLease(next.lease);
  });

  it("enforces busy and exact CAS semantics in the SQLite store", async () => {
    const root = await mkdtemp(join(tmpdir(), "durable-run-sqlite-"));
    const database = new ConversationDatabase(join(root, "conversation.sqlite"));
    try {
      const store = new DurableRunStore(database);
      const first = await store.openLease({ threadId: "thread", runId: "run-a", resume: false });
      expect(first.type).toBe("opened");
      if (first.type !== "opened") return;
      await expect(
        store.openLease({
          threadId: "thread",
          runId: "run-b",
          resume: false,
        }),
      ).resolves.toMatchObject({ type: "lease_busy", activeRunId: "run-a" });
      const firstCheckpoint = checkpoint("thread", "running");
      await expect(
        store.saveCas({
          lease: first.lease,
          expectedRevision: 0,
          nextRevision: 1,
          checkpoint: firstCheckpoint,
        }),
      ).resolves.toBe("saved");
      await expect(
        store.saveCas({
          lease: first.lease,
          expectedRevision: 0,
          nextRevision: 1,
          checkpoint: firstCheckpoint,
        }),
      ).resolves.toBe("already_applied");
      await expect(store.closeLease(first.lease)).resolves.toBe(true);
      const second = await store.openLease({
        threadId: "thread",
        runId: "run-b",
        resume: false,
      });
      expect(second).toMatchObject({
        type: "opened",
        checkpoint: firstCheckpoint,
      });
      if (second.type === "opened") {
        await expect(store.closeLease(second.lease)).resolves.toBe(true);
      }
    } finally {
      database.close();
    }
  });
});
