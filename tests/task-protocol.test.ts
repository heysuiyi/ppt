import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPptToolRegistry } from "@main/plugins/ppt/tools";
import { describe, expect, it } from "vitest";
import {
  LEAD_TASK_PERMISSIONS,
  type TaskCommandPrincipal,
  TaskStore,
} from "../src/main/agent/task/task-store";
import {
  taskClaimSchema,
  taskCreateSchema,
  taskReviewApproveSchema,
} from "../src/main/agent/tools/core/task-tools";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "task-protocol-"));
}

const lead = (store: TaskStore): TaskCommandPrincipal =>
  store.principal("lead", "lead", LEAD_TASK_PERMISSIONS);
const teammate = (store: TaskStore, actorId: string): TaskCommandPrincipal =>
  store.principal(actorId, "teammate", new Set(["task:update_own"]));

describe("Task protocol v1", () => {
  it("registers only the responsibility-separated model tools", () => {
    const registry = createPptToolRegistry();
    const names = registry.getCoreTools().map((tool) => tool.name);
    expect(names).toContain("TaskCreate");
    expect(names).toContain("TaskReviewApprove");
    expect(names.filter((name) => name.startsWith("Task")).sort()).toEqual([
      "TaskArchiveList",
      "TaskAssign",
      "TaskClaim",
      "TaskCloseList",
      "TaskCreate",
      "TaskDelete",
      "TaskGet",
      "TaskList",
      "TaskRelease",
      "TaskReopen",
      "TaskReopenList",
      "TaskReviewApprove",
      "TaskReviewReject",
      "TaskReviewRequest",
      "TaskTransfer",
      "TaskUpdate",
    ]);
  });

  it("rejects model-supplied identity and protected fields in strict tool schemas", () => {
    expect(taskClaimSchema.safeParse({ taskId: "1", owner: "spoofed" }).success).toBe(false);
    expect(
      taskCreateSchema.safeParse({
        subject: "x",
        description: "",
        executionTarget: "lead",
        completionPolicy: "direct",
        actorId: "spoofed",
      }).success,
    ).toBe(false);
    expect(
      taskReviewApproveSchema.safeParse({
        taskId: "1",
        requestId: "r1",
        expectedRevision: 0,
        reviewedBy: "spoofed",
      }).success,
    ).toBe(false);
  });

  it("persists a canonical task list and claim changes only owner", async () => {
    const root = await workspace();
    const store = new TaskStore(root);
    const created = await store.mutate(
      {
        type: "create",
        subject: "Draft",
        description: "Write the draft",
        executionTarget: "teammate",
        completionPolicy: "review_required",
      },
      lead(store),
    );

    const claimed = await store.mutate(
      { type: "claim", taskId: created.task!.id, expectedRevision: 0 },
      teammate(store, "writer"),
    );
    expect(claimed.task).toMatchObject({ owner: "writer", status: "pending", revision: 1 });
    expect(claimed.listRevision).toBe(2);

    const files = await import("node:fs/promises").then((fs) =>
      fs.readdir(join(root, ".tasks"), { withFileTypes: true }),
    );
    const listDir = files.find((entry) => entry.isDirectory())!;
    const persisted = JSON.parse(
      await readFile(join(root, ".tasks", listDir.name, "tasks.json"), "utf8"),
    );
    expect(persisted).toMatchObject({ format: "task-list", version: 1, highWatermark: 1 });
  });

  it("keeps review orthogonal and completes atomically on approval", async () => {
    const store = new TaskStore(await workspace());
    let result = await store.mutate(
      {
        type: "create",
        subject: "Storyboard",
        description: "",
        executionTarget: "teammate",
        completionPolicy: "review_required",
      },
      lead(store),
    );
    result = await store.mutate({ type: "claim", taskId: "1" }, teammate(store, "writer"));
    result = await store.mutate(
      {
        type: "update",
        taskId: "1",
        expectedRevision: result.task!.revision,
        status: "in_progress",
      },
      teammate(store, "writer"),
    );
    result = await store.mutate(
      {
        type: "review_request",
        taskId: "1",
        requestId: "review-1",
        expectedRevision: result.task!.revision,
      },
      teammate(store, "writer"),
    );
    expect(result.task).toMatchObject({
      status: "in_progress",
      owner: "writer",
      review: { state: "requested", requestId: "review-1" },
    });

    const approved = await store.mutate(
      {
        type: "review_approve",
        taskId: "1",
        requestId: "review-1",
        expectedRevision: result.task!.revision,
      },
      lead(store),
    );
    expect(approved.task).toMatchObject({
      status: "completed",
      owner: "writer",
      review: { state: "approved", requestId: "review-1" },
    });

    const replay = await store.mutate(
      {
        type: "review_approve",
        taskId: "1",
        requestId: "review-1",
        expectedRevision: 0,
      },
      lead(store),
    );
    expect(replay.changed).toBe(false);
    expect(replay.listRevision).toBe(approved.listRevision);
  });

  it("maintains both dependency directions and rejects stale CAS", async () => {
    const store = new TaskStore(await workspace());
    const first = await store.mutate(
      {
        type: "create",
        subject: "A",
        description: "",
        executionTarget: "lead",
        completionPolicy: "direct",
      },
      lead(store),
    );
    const second = await store.mutate(
      {
        type: "create",
        subject: "B",
        description: "",
        executionTarget: "lead",
        completionPolicy: "direct",
      },
      lead(store),
    );
    const linked = await store.mutate(
      {
        type: "update",
        taskId: "2",
        expectedRevision: 0,
        expectedListRevision: second.listRevision,
        dependencyChanges: { addBlockedBy: ["1"] },
      },
      lead(store),
    );
    expect(linked.tasks.find((task) => task.id === "1")?.blocks).toEqual(["2"]);
    expect(linked.tasks.find((task) => task.id === "2")?.blockedBy).toEqual(["1"]);
    expect(linked.tasks.find((task) => task.id === "1")?.revision).toBe(1);
    expect(linked.tasks.find((task) => task.id === "2")?.revision).toBe(1);

    await expect(
      store.mutate(
        {
          type: "update",
          taskId: "2",
          expectedRevision: 0,
          subject: "stale",
        },
        lead(store),
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(first.task!.revision).toBe(0);
  });
});
