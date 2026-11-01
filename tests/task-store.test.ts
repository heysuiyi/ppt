import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LEAD_TASK_PERMISSIONS,
  type PersistedTaskList,
  type TaskCommandPrincipal,
  type TaskListIdentity,
  TaskStore,
} from "../app/main/agent/task/task-store";
import { TaskSubscriptionService } from "../app/main/agent/task/task-subscription-service";
import { writeTextFileAtomic } from "@agent-harness/tools/atomic-files";

async function fixture(scope: TaskListIdentity["scope"] = "conversation") {
  const root = await mkdtemp(join(tmpdir(), "task-store-v1-"));
  const identity = {
    taskListId: scope === "team" ? "team-1" : "thread-1",
    scope,
    canonicalKey: `${scope}:${scope === "team" ? "team-1" : "thread-1"}`,
  } satisfies TaskListIdentity;
  const store = new TaskStore(root, identity);
  const lead = store.principal("lead", "lead", LEAD_TASK_PERMISSIONS);
  const teammate = (actorId: string, permissions = new Set(["task:update_own"] as const)) =>
    store.principal(actorId, "teammate", permissions);
  return { root, identity, store, lead, teammate };
}

async function createLeadTask(
  store: TaskStore,
  principal: TaskCommandPrincipal,
  subject = "Lead task",
) {
  return store.mutate(
    {
      type: "create",
      subject,
      description: "",
      executionTarget: "lead",
      completionPolicy: "direct",
    },
    principal,
  );
}

async function createTeammateTask(
  store: TaskStore,
  principal: TaskCommandPrincipal,
  subject = "Worker task",
) {
  return store.mutate(
    {
      type: "create",
      subject,
      description: "",
      executionTarget: "teammate",
      completionPolicy: "review_required",
    },
    principal,
  );
}

describe("TaskStore v1 contract", () => {
  it("rejects a mismatched principal before initializing or reading storage", async () => {
    const { root, store } = await fixture();
    const foreign: TaskCommandPrincipal = {
      actorId: "lead",
      role: "lead",
      taskListIdentity: {
        taskListId: "other",
        scope: "conversation",
        canonicalKey: "conversation:other",
      },
      permissions: LEAD_TASK_PERMISSIONS,
    };
    await expect(createLeadTask(store, foreign)).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await expect(readFile(join(root, ".tasks", "schema.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires teammate routing to use review_required", async () => {
    const { store, lead } = await fixture();
    await expect(
      store.mutate(
        {
          type: "create",
          subject: "bad",
          description: "",
          executionTarget: "teammate",
          completionPolicy: "direct",
        },
        lead,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  it("updates both dependency directions and increments each changed revision once", async () => {
    const { store, lead } = await fixture();
    await createLeadTask(store, lead, "A");
    const second = await createLeadTask(store, lead, "B");
    const linked = await store.mutate(
      {
        type: "update",
        taskId: "2",
        expectedRevision: 0,
        expectedListRevision: second.listRevision,
        dependencyChanges: { addBlockedBy: ["1"] },
      },
      lead,
    );
    expect(linked.tasks.find((task) => task.id === "1")).toMatchObject({
      blocks: ["2"],
      revision: 1,
    });
    expect(linked.tasks.find((task) => task.id === "2")).toMatchObject({
      blockedBy: ["1"],
      revision: 1,
    });
  });

  it("rejects cycles, self edges, stale task revisions, and stale list revisions", async () => {
    const { store, lead } = await fixture();
    await createLeadTask(store, lead, "A");
    const second = await createLeadTask(store, lead, "B");
    const linked = await store.mutate(
      {
        type: "update",
        taskId: "2",
        expectedRevision: 0,
        expectedListRevision: second.listRevision,
        dependencyChanges: { addBlockedBy: ["1"] },
      },
      lead,
    );
    await expect(
      store.mutate(
        {
          type: "update",
          taskId: "1",
          expectedRevision: 1,
          expectedListRevision: linked.listRevision,
          dependencyChanges: { addBlockedBy: ["2"] },
        },
        lead,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(
      store.mutate(
        {
          type: "update",
          taskId: "2",
          expectedRevision: 0,
          subject: "stale",
        },
        lead,
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("allows only one concurrent blind claim and claim leaves status pending", async () => {
    const { root, identity, store, lead } = await fixture("team");
    await createTeammateTask(store, lead);
    const aliceStore = new TaskStore(root, identity);
    const bobStore = new TaskStore(root, identity);
    const outcomes = await Promise.allSettled([
      aliceStore.mutate(
        { type: "claim", taskId: "1" },
        aliceStore.principal("alice", "teammate", new Set(["task:update_own"])),
      ),
      bobStore.mutate(
        { type: "claim", taskId: "1" },
        bobStore.principal("bob", "teammate", new Set(["task:update_own"])),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await store.getTask("1")).toMatchObject({ status: "pending", revision: 1 });
  });

  it("waits for an atomic replacement before existing and initializing readers load tasks", async () => {
    const { root, identity, store, lead } = await fixture();
    await createLeadTask(store, lead);
    const { file } = await store.storageLocation();
    const replacement = JSON.parse(await readFile(file, "utf8")) as PersistedTaskList;
    replacement.tasks["1"].subject = "Committed replacement";
    replacement.tasks["1"].revision += 1;
    replacement.listRevision += 1;

    let markDisplaced!: () => void;
    const displaced = new Promise<void>((resolve) => {
      markDisplaced = resolve;
    });
    let continueCommit!: () => void;
    const commitRelease = new Promise<void>((resolve) => {
      continueCommit = resolve;
    });
    let displacedPath: string | undefined;
    const writer = writeTextFileAtomic(file, JSON.stringify(replacement), {
      commitGuard: {
        expectedTargetExists: true,
        async validatePath() {},
        async validateDisplaced(path) {
          displacedPath = path;
          markDisplaced();
          await commitRelease;
        },
      },
    });
    await displaced;
    expect(displacedPath).toBeDefined();

    const observe = async (reader: Promise<unknown>) => {
      try {
        return { status: "fulfilled" as const, value: await reader };
      } catch (reason) {
        return { status: "rejected" as const, reason };
      }
    };
    const existingReader = observe(store.getSnapshot());
    const initializingReader = observe(new TaskStore(root, identity).getSnapshot());
    await new Promise((resolve) => setTimeout(resolve, 50));
    continueCommit();

    await expect(writer).resolves.toBeUndefined();
    await expect(existingReader).resolves.toMatchObject({
      status: "fulfilled",
      value: { listRevision: replacement.listRevision },
    });
    await expect(initializingReader).resolves.toMatchObject({
      status: "fulfilled",
      value: { listRevision: replacement.listRevision },
    });
  });

  it("fails closed when an initialized task-list file is genuinely missing", async () => {
    const { root, identity, store } = await fixture();
    const { file } = await store.storageLocation();
    await unlink(file);

    await expect(store.getSnapshot()).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
    await expect(new TaskStore(root, identity).getSnapshot()).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
    });
  });

  it("keeps an owner busy while their current task is still executing", async () => {
    const { store, lead, teammate } = await fixture();
    let first = await createTeammateTask(store, lead, "First");
    const second = await createTeammateTask(store, lead, "Second");
    first = await store.mutate(
      {
        type: "claim",
        taskId: first.task!.id,
        expectedRevision: first.task!.revision,
      },
      teammate("alice"),
    );
    await store.mutate(
      {
        type: "update",
        taskId: first.task!.id,
        expectedRevision: first.task!.revision,
        status: "in_progress",
      },
      teammate("alice"),
    );

    await expect(
      store.mutate(
        {
          type: "claim",
          taskId: second.task!.id,
          expectedRevision: second.task!.revision,
        },
        teammate("alice"),
      ),
    ).rejects.toMatchObject({ code: "OWNER_BUSY" });
  });

  it("lets an owner claim new work while a retained task awaits review", async () => {
    const { store, lead, teammate } = await fixture();
    let first = await createTeammateTask(store, lead, "First");
    const second = await createTeammateTask(store, lead, "Second");
    first = await store.mutate(
      {
        type: "claim",
        taskId: first.task!.id,
        expectedRevision: first.task!.revision,
      },
      teammate("alice"),
    );
    first = await store.mutate(
      {
        type: "update",
        taskId: first.task!.id,
        expectedRevision: first.task!.revision,
        status: "in_progress",
      },
      teammate("alice"),
    );
    first = await store.mutate(
      {
        type: "review_request",
        taskId: first.task!.id,
        requestId: "review-first",
        expectedRevision: first.task!.revision,
      },
      teammate("alice"),
    );

    const claimed = await store.mutate(
      {
        type: "claim",
        taskId: second.task!.id,
        expectedRevision: second.task!.revision,
      },
      teammate("alice"),
    );
    expect(first.task).toMatchObject({
      owner: "alice",
      review: { state: "requested" },
    });
    expect(claimed.task).toMatchObject({
      id: second.task!.id,
      owner: "alice",
      status: "pending",
    });
  });

  it("blocks start, direct completion, and review approval until dependencies complete", async () => {
    const { store, lead, teammate } = await fixture();
    await createLeadTask(store, lead, "blocker");
    let worker = await createTeammateTask(store, lead, "worker");
    worker = await store.mutate(
      {
        type: "update",
        taskId: "2",
        expectedRevision: 0,
        expectedListRevision: worker.listRevision,
        dependencyChanges: { addBlockedBy: ["1"] },
      },
      lead,
    );
    await expect(
      store.mutate(
        {
          type: "claim",
          taskId: "2",
          expectedRevision: worker.task!.revision,
        },
        teammate("worker"),
      ),
    ).rejects.toMatchObject({ code: "TASK_BLOCKED" });
  });

  it("keeps owner, status, and review independent through approval", async () => {
    const { store, lead, teammate } = await fixture();
    let result = await createTeammateTask(store, lead);
    result = await store.mutate({ type: "claim", taskId: "1" }, teammate("alice"));
    expect(result.task).toMatchObject({
      owner: "alice",
      status: "pending",
      review: { state: "none" },
    });
    result = await store.mutate(
      {
        type: "update",
        taskId: "1",
        expectedRevision: result.task!.revision,
        status: "in_progress",
      },
      teammate("alice"),
    );
    result = await store.mutate(
      {
        type: "review_request",
        taskId: "1",
        requestId: "r1",
        expectedRevision: result.task!.revision,
      },
      teammate("alice"),
    );
    expect(result.task).toMatchObject({
      owner: "alice",
      status: "in_progress",
      review: { state: "requested" },
    });
    result = await store.mutate(
      {
        type: "review_approve",
        taskId: "1",
        requestId: "r1",
        expectedRevision: result.task!.revision,
      },
      lead,
    );
    expect(result.task).toMatchObject({
      owner: "alice",
      status: "completed",
      review: { state: "approved" },
    });
  });

  it("implements review idempotency across rounds without overwriting current review", async () => {
    const { store, lead, teammate } = await fixture();
    let result = await createTeammateTask(store, lead);
    result = await store.mutate({ type: "claim", taskId: "1" }, teammate("alice"));
    result = await store.mutate(
      {
        type: "update",
        taskId: "1",
        expectedRevision: result.task!.revision,
        status: "in_progress",
      },
      teammate("alice"),
    );
    result = await store.mutate(
      {
        type: "review_request",
        taskId: "1",
        requestId: "A",
        expectedRevision: result.task!.revision,
      },
      teammate("alice"),
    );
    const rejected = await store.mutate(
      {
        type: "review_reject",
        taskId: "1",
        requestId: "A",
        expectedRevision: result.task!.revision,
      },
      lead,
    );
    const requestedB = await store.mutate(
      {
        type: "review_request",
        taskId: "1",
        requestId: "B",
        expectedRevision: rejected.task!.revision,
      },
      teammate("alice"),
    );
    const replay = await store.mutate(
      {
        type: "review_reject",
        taskId: "1",
        requestId: "A",
        expectedRevision: 0,
      },
      lead,
    );
    expect(replay.changed).toBe(false);
    expect(replay.task?.review).toMatchObject({ state: "changes_requested", requestId: "A" });
    expect((await store.getTask("1")).review).toMatchObject({ state: "requested", requestId: "B" });
    expect(replay.listRevision).toBe(requestedB.listRevision);
  });

  it("does not let an untrusted principal replay another actor's review receipt", async () => {
    const { store, lead, teammate } = await fixture();
    let result = await createTeammateTask(store, lead);
    result = await store.mutate({ type: "claim", taskId: "1" }, teammate("alice"));
    result = await store.mutate(
      {
        type: "update",
        taskId: "1",
        expectedRevision: result.task!.revision,
        status: "in_progress",
      },
      teammate("alice"),
    );
    result = await store.mutate(
      {
        type: "review_request",
        taskId: "1",
        requestId: "A",
        expectedRevision: result.task!.revision,
      },
      teammate("alice"),
    );
    await store.mutate(
      {
        type: "review_reject",
        taskId: "1",
        requestId: "A",
        expectedRevision: result.task!.revision,
      },
      lead,
    );
    await expect(
      store.mutate(
        {
          type: "review_request",
          taskId: "1",
          requestId: "A",
          expectedRevision: 0,
        },
        teammate("mallory"),
      ),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    await expect(
      store.mutate(
        {
          type: "review_reject",
          taskId: "1",
          requestId: "A",
          expectedRevision: 0,
        },
        teammate("alice"),
      ),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  it("serializes competing approve and reject commands so only one commits", async () => {
    const { root, identity, store, lead, teammate } = await fixture("team");
    let result = await createTeammateTask(store, lead);
    result = await store.mutate({ type: "claim", taskId: "1" }, teammate("alice"));
    result = await store.mutate(
      {
        type: "update",
        taskId: "1",
        expectedRevision: result.task!.revision,
        status: "in_progress",
      },
      teammate("alice"),
    );
    result = await store.mutate(
      {
        type: "review_request",
        taskId: "1",
        requestId: "race",
        expectedRevision: result.task!.revision,
      },
      teammate("alice"),
    );
    const expectedRevision = result.task!.revision;
    const first = new TaskStore(root, identity);
    const second = new TaskStore(root, identity);
    const outcomes = await Promise.allSettled([
      first.mutate(
        {
          type: "review_approve",
          taskId: "1",
          requestId: "race",
          expectedRevision,
        },
        first.principal("lead-a", "lead", LEAD_TASK_PERMISSIONS),
      ),
      second.mutate(
        {
          type: "review_reject",
          taskId: "1",
          requestId: "race",
          expectedRevision,
        },
        second.principal("lead-b", "lead", LEAD_TASK_PERMISSIONS),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  });

  it("keeps only the latest twenty complete review rounds", async () => {
    const { store, lead, teammate } = await fixture();
    let result = await createTeammateTask(store, lead);
    result = await store.mutate({ type: "claim", taskId: "1" }, teammate("alice"));
    result = await store.mutate(
      {
        type: "update",
        taskId: "1",
        expectedRevision: result.task!.revision,
        status: "in_progress",
      },
      teammate("alice"),
    );
    for (let round = 1; round <= 21; round += 1) {
      result = await store.mutate(
        {
          type: "review_request",
          taskId: "1",
          requestId: `r${round}`,
          expectedRevision: result.task!.revision,
        },
        teammate("alice"),
      );
      result = await store.mutate(
        {
          type: "review_reject",
          taskId: "1",
          requestId: `r${round}`,
          expectedRevision: result.task!.revision,
        },
        lead,
      );
    }
    const task = await store.getTask("1");
    expect(new Set(task.reviewReceipts.map((receipt) => receipt.requestId)).size).toBe(20);
    expect(task.reviewReceipts.some((receipt) => receipt.requestId === "r1")).toBe(false);
    expect(task.reviewReceipts.filter((receipt) => receipt.requestId === "r2")).toHaveLength(2);
  });

  it("orders recovery before new work and restricts changes_requested recovery", async () => {
    const { store, lead, teammate } = await fixture();
    let recovering = await createTeammateTask(store, lead, "recover running");
    recovering = await store.mutate({ type: "claim", taskId: "1" }, teammate("alice"));
    recovering = await store.mutate(
      {
        type: "update",
        taskId: "1",
        expectedRevision: recovering.task!.revision,
        status: "in_progress",
      },
      teammate("alice"),
    );
    await store.mutate(
      {
        type: "release",
        taskId: "1",
        expectedRevision: recovering.task!.revision,
      },
      teammate("alice"),
    );

    let changes = await createTeammateTask(store, lead, "recover changes");
    changes = await store.mutate({ type: "claim", taskId: "2" }, teammate("alice"));
    changes = await store.mutate(
      {
        type: "update",
        taskId: "2",
        expectedRevision: changes.task!.revision,
        status: "in_progress",
      },
      teammate("alice"),
    );
    changes = await store.mutate(
      {
        type: "review_request",
        taskId: "2",
        requestId: "changes-A",
        expectedRevision: changes.task!.revision,
      },
      teammate("alice"),
    );
    changes = await store.mutate(
      {
        type: "review_reject",
        taskId: "2",
        requestId: "changes-A",
        expectedRevision: changes.task!.revision,
      },
      lead,
    );
    await store.mutate(
      {
        type: "release",
        taskId: "2",
        expectedRevision: changes.task!.revision,
      },
      lead,
    );
    await createTeammateTask(store, lead, "new pending");

    expect(
      (await store.listDispatchCandidates("alice")).map(({ task, mode }) => [task.id, mode]),
    ).toEqual([
      ["1", "recover_in_progress"],
      ["2", "recover_changes"],
      ["3", "new_pending"],
    ]);
    expect(
      (await store.listDispatchCandidates("bob")).map(({ task, mode }) => [task.id, mode]),
    ).toEqual([
      ["1", "recover_in_progress"],
      ["3", "new_pending"],
    ]);
  });

  it("never dispatches an unowned requested review", async () => {
    const { store, lead, teammate } = await fixture();
    let result = await createTeammateTask(store, lead);
    result = await store.mutate({ type: "claim", taskId: "1" }, teammate("alice"));
    result = await store.mutate(
      {
        type: "update",
        taskId: "1",
        expectedRevision: result.task!.revision,
        status: "in_progress",
      },
      teammate("alice"),
    );
    result = await store.mutate(
      {
        type: "review_request",
        taskId: "1",
        requestId: "review-A",
        expectedRevision: result.task!.revision,
      },
      teammate("alice"),
    );
    await store.mutate(
      {
        type: "release",
        taskId: "1",
        expectedRevision: result.task!.revision,
      },
      lead,
    );
    expect(await store.listDispatchCandidates("alice")).toEqual([]);
  });

  it("enforces open, closed, reopened, and archived list lifecycle", async () => {
    const { store, lead } = await fixture();
    await createLeadTask(store, lead);
    let snapshot = await store.getSnapshot();
    snapshot = await store.mutate(
      { type: "close_list", expectedListRevision: snapshot.listRevision },
      lead,
    );
    await expect(createLeadTask(store, lead)).rejects.toMatchObject({ code: "LIST_CLOSED" });
    snapshot = await store.mutate(
      { type: "reopen_list", expectedListRevision: snapshot.listRevision },
      lead,
    );
    const task = await store.getTask("1");
    snapshot = await store.mutate(
      {
        type: "update",
        taskId: "1",
        expectedRevision: task.revision,
        status: "completed",
      },
      lead,
    );
    snapshot = await store.mutate(
      { type: "close_list", expectedListRevision: snapshot.listRevision },
      lead,
    );
    snapshot = await store.mutate(
      {
        type: "archive_list",
        expectedListRevision: snapshot.listRevision,
        outcome: "completed",
      },
      lead,
    );
    expect(snapshot).toMatchObject({ state: "archived", archive: { outcome: "completed" } });
    await expect(
      store.mutate(
        {
          type: "reopen_list",
          expectedListRevision: snapshot.listRevision,
        },
        lead,
      ),
    ).rejects.toMatchObject({ code: "LIST_ARCHIVED" });
  });

  it("fails closed for a partial migration", async () => {
    const { root, identity } = await fixture();
    await mkdir(join(root, ".tasks", "partial"), { recursive: true });
    const store = new TaskStore(root, identity);
    await expect(store.getSnapshot()).rejects.toMatchObject({ code: "MIGRATION_FAILED" });
  });

  it("moves legacy root JSON aside and creates an explicit schema marker", async () => {
    const { root, identity } = await fixture();
    await mkdir(join(root, ".tasks"), { recursive: true });
    await writeFile(join(root, ".tasks", "task_old.json"), "{}");
    const store = new TaskStore(root, identity);
    await store.getSnapshot();
    expect(JSON.parse(await readFile(join(root, ".tasks", "schema.json"), "utf8"))).toEqual({
      format: "task-store",
      version: 1,
    });
  });

  it("validator blocks before persistence and notification hook failures become warnings", async () => {
    const { root, identity } = await fixture();
    const hook = vi.fn(async () => {
      throw new Error("mailbox unavailable");
    });
    const store = new TaskStore(root, identity, {
      validators: [
        ({ command }) => {
          if (command.type === "create" && command.subject === "blocked")
            throw new Error("validator blocked");
        },
      ],
      notificationHooks: [hook],
    });
    const lead = store.principal("lead", "lead", LEAD_TASK_PERMISSIONS);
    await expect(createLeadTask(store, lead, "blocked")).rejects.toThrow("validator blocked");
    expect((await store.getSnapshot()).tasks).toHaveLength(0);
    const committed = await createLeadTask(store, lead, "allowed");
    expect(committed.warnings).toEqual(["mailbox unavailable"]);
    expect(await store.getTask("1")).toMatchObject({ subject: "allowed" });
  });

  it("subscription deduplicates same-process and watch/poll refresh by listRevision", async () => {
    const { store, lead } = await fixture();
    const service = new TaskSubscriptionService(store, 20);
    const listener = vi.fn();
    const unsubscribe = await service.subscribe(listener);
    const created = await createLeadTask(store, lead);
    service.notifyTasksUpdated(store.identity.taskListId);
    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({ listRevision: created.listRevision }),
      ),
    );
    const count = listener.mock.calls.length;
    service.notifyTasksUpdated(store.identity.taskListId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listener).toHaveBeenCalledTimes(count);
    unsubscribe();
    service.dispose();
  });
});
