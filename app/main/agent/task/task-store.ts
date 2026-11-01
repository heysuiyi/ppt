import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "@agent-harness/tools/atomic-files";
import {
  type AgentTaskNode,
  agentTaskNodeSchema,
  canStartTask,
  getIncompleteBlockedBy,
  hasDependencyCycle,
  type TaskCompletionPolicy,
} from "@shared/agent-task-list";

export type TaskPermission =
  | "task:create"
  | "task:update_own"
  | "task:update_any"
  | "task:manage_dependencies"
  | "task:manage_routing"
  | "task:assign"
  | "task:review"
  | "task:manage_list";

export type TaskCommandPrincipal = {
  actorId: string;
  role: "lead" | "teammate" | "system";
  taskListIdentity: TaskListIdentity;
  permissions: ReadonlySet<TaskPermission>;
};

export type TaskListIdentity = {
  taskListId: string;
  scope: "conversation" | "team";
  canonicalKey: string;
};

export type TaskErrorCode =
  | "TASK_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "OWNER_CONFLICT"
  | "TASK_BLOCKED"
  | "OWNER_BUSY"
  | "TASK_ALREADY_COMPLETED"
  | "INVALID_STATE_TRANSITION"
  | "NOT_AUTHORIZED"
  | "REVIEW_ALREADY_REQUESTED"
  | "REVIEW_REQUEST_MISMATCH"
  | "LIST_CLOSED"
  | "LIST_ARCHIVED"
  | "MIGRATION_FAILED";

export class TaskStoreError extends Error {
  constructor(
    readonly code: TaskErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskStoreError";
  }
}

export type PersistedTaskList = {
  format: "task-list";
  version: 1;
  identity: TaskListIdentity;
  state: "open" | "closed" | "archived";
  archive?: {
    outcome: "completed" | "abandoned";
    reason?: string;
    archivedBy: string;
    archivedAt: string;
  };
  listRevision: number;
  highWatermark: number;
  hasEverContainedTasks: boolean;
  tasks: Record<string, AgentTaskNode>;
};

type DependencyChanges = {
  addBlocks?: string[];
  addBlockedBy?: string[];
  removeBlocks?: string[];
  removeBlockedBy?: string[];
};

export type TaskCommand =
  | {
      type: "create";
      subject: string;
      description: string;
      activeForm?: string;
      executionTarget: "lead" | "teammate";
      completionPolicy: TaskCompletionPolicy;
      userMetadata?: Record<string, unknown>;
    }
  | {
      type: "update";
      taskId: string;
      expectedRevision: number;
      subject?: string;
      description?: string;
      activeForm?: string;
      status?: "pending" | "in_progress" | "completed";
      userMetadata?: Record<string, unknown>;
      dependencyChanges?: DependencyChanges;
      expectedListRevision?: number;
    }
  | { type: "delete"; taskId: string; expectedRevision: number; expectedListRevision: number }
  | { type: "claim"; taskId: string; expectedRevision?: number }
  | { type: "assign"; taskId: string; owner: string; expectedRevision: number }
  | { type: "release"; taskId: string; expectedRevision: number }
  | { type: "transfer"; taskId: string; newOwner: string; expectedRevision: number }
  | { type: "review_request"; taskId: string; requestId: string; expectedRevision: number }
  | { type: "review_approve"; taskId: string; requestId: string; expectedRevision: number }
  | {
      type: "review_reject";
      taskId: string;
      requestId: string;
      reason?: string;
      expectedRevision: number;
    }
  | { type: "reopen"; taskId: string; expectedRevision: number }
  | { type: "close_list"; expectedListRevision: number }
  | { type: "reopen_list"; expectedListRevision: number }
  | {
      type: "archive_list";
      expectedListRevision: number;
      outcome: "completed" | "abandoned";
      archiveReason?: string;
    };

export type TaskMutationResult = {
  taskListId: string;
  task?: AgentTaskNode;
  tasks: AgentTaskNode[];
  listRevision: number;
  state: PersistedTaskList["state"];
  archive?: PersistedTaskList["archive"];
  changed: boolean;
  warnings?: string[];
};

export type TaskStoreValidator = (input: {
  command: TaskCommand;
  currentSnapshot: Readonly<PersistedTaskList>;
  proposedSnapshot: Readonly<PersistedTaskList>;
}) => void;

export type TaskNotificationHook = (input: {
  command: TaskCommand;
  principal: TaskCommandPrincipal;
  result: TaskMutationResult;
}) => void | Promise<void>;

export type TaskStoreOptions = {
  validators?: readonly TaskStoreValidator[];
  notificationHooks?: readonly TaskNotificationHook[];
};

export type TaskDispatchMode = "recover_in_progress" | "recover_changes" | "new_pending";
export type TaskDispatchCandidate = {
  task: AgentTaskNode;
  mode: TaskDispatchMode;
};

type LockRelease = () => Promise<void>;
type ProperLockfile = { lock(file: string, options?: object): Promise<LockRelease> };
const lockfile = createRequire(import.meta.url)("proper-lockfile") as ProperLockfile;
const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 40, factor: 1, minTimeout: 10, maxTimeout: 75 },
};

export const LEAD_TASK_PERMISSIONS: ReadonlySet<TaskPermission> = new Set([
  "task:create",
  "task:update_own",
  "task:update_any",
  "task:manage_dependencies",
  "task:manage_routing",
  "task:assign",
  "task:review",
  "task:manage_list",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deny(message: string): never {
  throw new TaskStoreError("NOT_AUTHORIZED", message);
}

/** Canonical, task-list locked persistence. Model-facing writes must use mutate(). */
export class TaskStore {
  readonly identity: TaskListIdentity;
  private readonly storeRoot: string;
  private readonly listDir: string;
  private readonly dataPath: string;
  private initialization?: Promise<void>;
  private validating = false;

  constructor(
    private readonly workspaceRoot: string,
    identity?: TaskListIdentity,
    private readonly options: TaskStoreOptions = {},
  ) {
    this.identity = identity ?? {
      taskListId: basename(workspaceRoot) || "conversation",
      scope: "conversation",
      canonicalKey: workspaceRoot,
    };
    this.storeRoot = join(workspaceRoot, ".tasks");
    const digest = createHash("sha256")
      .update(this.identity.canonicalKey)
      .digest("hex")
      .slice(0, 16);
    const prefix =
      this.identity.taskListId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "tasks";
    this.listDir = join(this.storeRoot, `${prefix}-${digest}`);
    this.dataPath = join(this.listDir, "tasks.json");
  }

  async getSnapshot(): Promise<TaskMutationResult> {
    await this.ensureStorage();
    const list = await this.readList();
    return this.result(list, undefined, false);
  }

  async listTasks(): Promise<AgentTaskNode[]> {
    return (await this.getSnapshot()).tasks;
  }

  async getTask(taskId: string): Promise<AgentTaskNode> {
    const task = (await this.readListAfterEnsure()).tasks[taskId];
    if (!task) throw new TaskStoreError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
    return clone(task);
  }

  async getDerived(taskId: string): Promise<{
    task: AgentTaskNode;
    derived: { isBlocked: boolean; incompleteBlockedBy: string[]; canClaim: boolean };
  }> {
    const tasks = await this.listTasks();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const task = byId.get(taskId);
    if (!task) throw new TaskStoreError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
    const incompleteBlockedBy = getIncompleteBlockedBy(task, byId);
    return {
      task,
      derived: {
        isBlocked: incompleteBlockedBy.length > 0,
        incompleteBlockedBy,
        canClaim: !task.owner && task.status !== "completed" && incompleteBlockedBy.length === 0,
      },
    };
  }

  async mutate(command: TaskCommand, principal: TaskCommandPrincipal): Promise<TaskMutationResult> {
    if (this.validating) {
      throw new TaskStoreError("INVALID_STATE_TRANSITION", "Task validator re-entry is forbidden");
    }
    this.validateIdentity(principal);
    await this.ensureStorage();
    const release = await lockfile.lock(this.listDir, LOCK_OPTIONS);
    let result: TaskMutationResult;
    try {
      const current = await this.readList();
      const next = clone(current);
      const task = this.apply(next, command, principal);
      if (JSON.stringify(next) === JSON.stringify(current)) {
        result = this.result(current, task, false);
        return result;
      }
      this.validateList(next);
      next.listRevision += 1;
      this.runValidators(command, current, next);
      await writeJsonFileAtomic(this.dataPath, next);
      result = this.result(next, task?.id ? next.tasks[task.id] : undefined, true);
    } finally {
      await release();
    }
    const warnings: string[] = [];
    for (const hook of this.options.notificationHooks ?? []) {
      try {
        await hook({ command, principal, result });
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    return warnings.length ? { ...result, warnings } : result;
  }

  private runValidators(
    command: TaskCommand,
    currentSnapshot: PersistedTaskList,
    proposedSnapshot: PersistedTaskList,
  ): void {
    if (this.validating) {
      throw new TaskStoreError("INVALID_STATE_TRANSITION", "Task validator re-entry is forbidden");
    }
    this.validating = true;
    try {
      for (const validator of this.options.validators ?? []) {
        validator({
          command,
          currentSnapshot: clone(currentSnapshot),
          proposedSnapshot: clone(proposedSnapshot),
        });
      }
    } finally {
      this.validating = false;
    }
  }

  private apply(
    list: PersistedTaskList,
    command: TaskCommand,
    principal: TaskCommandPrincipal,
  ): AgentTaskNode | undefined {
    if (command.type === "reopen_list") {
      this.requirePermission(principal, "task:manage_list");
      this.listRevision(list, command.expectedListRevision);
      if (list.state === "archived")
        throw new TaskStoreError("LIST_ARCHIVED", "Archived lists cannot be reopened");
      if (list.state === "open") return undefined;
      list.state = "open";
      return undefined;
    }
    if (command.type === "archive_list") {
      this.requirePermission(principal, "task:manage_list");
      this.listRevision(list, command.expectedListRevision);
      if (list.state === "archived")
        throw new TaskStoreError("LIST_ARCHIVED", "List is already archived");
      if (list.state !== "closed")
        throw new TaskStoreError("INVALID_STATE_TRANSITION", "Close the list before archiving");
      if (
        command.outcome === "completed" &&
        Object.values(list.tasks).some((task) => task.status !== "completed")
      ) {
        throw new TaskStoreError(
          "INVALID_STATE_TRANSITION",
          "Incomplete tasks cannot be archived as completed",
        );
      }
      if (command.outcome === "abandoned" && !command.archiveReason?.trim()) {
        throw new TaskStoreError("INVALID_STATE_TRANSITION", "Abandoned archive requires a reason");
      }
      list.state = "archived";
      list.archive = {
        outcome: command.outcome,
        ...(command.archiveReason?.trim() ? { reason: command.archiveReason.trim() } : {}),
        archivedBy: principal.actorId,
        archivedAt: new Date().toISOString(),
      };
      return undefined;
    }
    if (list.state === "archived")
      throw new TaskStoreError("LIST_ARCHIVED", "Task list is archived");
    if (command.type === "close_list") {
      this.requirePermission(principal, "task:manage_list");
      this.listRevision(list, command.expectedListRevision);
      if (list.state === "closed") return undefined;
      list.state = "closed";
      return undefined;
    }
    if (list.state === "closed") throw new TaskStoreError("LIST_CLOSED", "Task list is closed");

    if (command.type === "create") {
      this.requirePermission(principal, "task:create");
      if (
        command.executionTarget === "teammate" &&
        command.completionPolicy !== "review_required"
      ) {
        throw new TaskStoreError("INVALID_STATE_TRANSITION", "Teammate tasks require review");
      }
      if (command.executionTarget === "lead" && command.completionPolicy !== "direct") {
        throw new TaskStoreError("INVALID_STATE_TRANSITION", "Lead tasks use direct completion");
      }
      if (principal.role === "teammate" && command.executionTarget !== "teammate")
        deny("Teammates cannot create lead tasks");
      const id = String(++list.highWatermark);
      const now = new Date().toISOString();
      const task: AgentTaskNode = {
        id,
        revision: 0,
        subject: command.subject.trim(),
        description: command.description.trim(),
        ...(command.activeForm ? { activeForm: command.activeForm } : {}),
        status: "pending",
        blocks: [],
        blockedBy: [],
        routing: { executionTarget: command.executionTarget },
        completionPolicy: command.completionPolicy,
        review: { state: "none" },
        reviewReceipts: [],
        ...(command.userMetadata ? { userMetadata: clone(command.userMetadata) } : {}),
        systemMetadata: { createdAt: now, updatedAt: now, createdBy: principal.actorId },
      };
      list.tasks[id] = task;
      list.hasEverContainedTasks = true;
      return task;
    }

    const task = this.task(list, command.taskId);
    if (command.type === "review_request" && task.owner !== principal.actorId) {
      deny("Only the current owner can request or replay review");
    }
    if (command.type === "review_approve" || command.type === "review_reject") {
      this.requirePermission(principal, "task:review");
    }
    const reviewReplay = this.reviewReplay(task, command);
    if (reviewReplay) return reviewReplay;
    this.taskRevision(task, command.expectedRevision);

    if (command.type === "update") {
      this.requireTaskUpdate(principal, task);
      if (task.status === "completed" && principal.role !== "lead") {
        deny("Only lead can amend completed task content");
      }
      if (task.status === "completed" && command.dependencyChanges) {
        throw new TaskStoreError(
          "INVALID_STATE_TRANSITION",
          "Completed task dependencies are immutable",
        );
      }
      const beforeTasks = clone(list.tasks);
      const dependencies = command.dependencyChanges;
      if (dependencies) {
        this.requirePermission(principal, "task:manage_dependencies");
        if (command.expectedListRevision === undefined)
          throw new TaskStoreError("REVISION_CONFLICT", "expectedListRevision is required");
        this.listRevision(list, command.expectedListRevision);
        this.updateDependencies(list, task, dependencies);
      } else if (command.expectedListRevision !== undefined) {
        throw new TaskStoreError(
          "INVALID_STATE_TRANSITION",
          "List revision is only valid for dependency updates",
        );
      }
      if (command.subject !== undefined) task.subject = command.subject.trim();
      if (command.description !== undefined) task.description = command.description.trim();
      if (command.activeForm !== undefined) task.activeForm = command.activeForm || undefined;
      if (command.userMetadata) {
        task.userMetadata ??= {};
        for (const [key, value] of Object.entries(command.userMetadata)) {
          if (value === null) delete task.userMetadata[key];
          else task.userMetadata[key] = value;
        }
      }
      if (command.status !== undefined) this.updateStatus(list, task, command.status, principal);
      for (const changed of Object.values(list.tasks)) {
        const before = beforeTasks[changed.id];
        if (before && this.taskContent(before) !== this.taskContent(changed)) {
          changed.revision = before.revision;
          this.bump(changed, principal);
        }
      }
      return task;
    }
    if (command.type === "delete") {
      this.requirePermission(principal, "task:update_any");
      this.listRevision(list, command.expectedListRevision);
      if (task.review.state === "requested")
        throw new TaskStoreError("INVALID_STATE_TRANSITION", "Reject review before delete");
      for (const other of Object.values(list.tasks)) {
        if (other.id === task.id) continue;
        const before = `${other.blocks}|${other.blockedBy}`;
        other.blocks = other.blocks.filter((id) => id !== task.id);
        other.blockedBy = other.blockedBy.filter((id) => id !== task.id);
        if (`${other.blocks}|${other.blockedBy}` !== before) this.bump(other, principal);
      }
      delete list.tasks[task.id];
      return task;
    }
    if (command.type === "reopen") {
      this.requirePermission(principal, "task:update_any");
      if (task.status !== "completed")
        throw new TaskStoreError("INVALID_STATE_TRANSITION", "Only completed tasks can reopen");
      if (task.review.state === "approved") {
        const history = Array.isArray(task.systemMetadata?.reviewHistory)
          ? (task.systemMetadata.reviewHistory as unknown[])
          : [];
        task.systemMetadata = {
          ...task.systemMetadata,
          reviewHistory: [...history, clone(task.review)].slice(-20),
        };
      }
      task.status = "pending";
      task.review = { state: "none" };
      this.bump(task, principal);
      return task;
    }
    if (command.type === "claim") {
      if (principal.role === "system") deny("System principal cannot claim model work");
      if (principal.role === "teammate" && task.routing.executionTarget !== "teammate") {
        deny("Teammate cannot claim lead-routed work");
      }
      if (task.owner) throw new TaskStoreError("OWNER_CONFLICT", `Task is owned by ${task.owner}`);
      if (task.status === "completed")
        throw new TaskStoreError("TASK_ALREADY_COMPLETED", "Task is completed");
      if (task.review.state === "requested" || task.review.state === "approved") {
        throw new TaskStoreError("INVALID_STATE_TRANSITION", "Task under review cannot be claimed");
      }
      if (
        task.review.state === "changes_requested" &&
        principal.role !== "lead" &&
        task.review.requestedBy !== principal.actorId
      ) {
        deny("Only the original requester can recover changes-requested work");
      }
      this.assertUnblocked(list, task);
      if (this.ownerHasActiveWork(list, principal.actorId, task.id)) {
        throw new TaskStoreError("OWNER_BUSY", `${principal.actorId} already owns active work`);
      }
      task.owner = principal.actorId;
      this.bump(task, principal);
      return task;
    }
    if (command.type === "assign" || command.type === "transfer") {
      this.requirePermission(principal, "task:assign");
      if (task.status === "completed")
        throw new TaskStoreError("TASK_ALREADY_COMPLETED", "Task is completed");
      if (command.type === "assign" && task.owner)
        throw new TaskStoreError("OWNER_CONFLICT", "Assign cannot overwrite owner");
      if (command.type === "transfer" && !task.owner)
        throw new TaskStoreError("OWNER_CONFLICT", "Transfer requires current owner");
      const owner = command.type === "assign" ? command.owner : command.newOwner;
      if (this.ownerHasActiveWork(list, owner, task.id)) {
        throw new TaskStoreError("OWNER_BUSY", `${owner} already owns active work`);
      }
      task.owner = owner;
      this.bump(task, principal);
      return task;
    }
    if (command.type === "release") {
      if (!task.owner) return task;
      if (task.owner !== principal.actorId && !principal.permissions.has("task:assign"))
        deny("Cannot release another owner");
      if (task.status === "completed" && principal.role !== "lead")
        deny("Only lead can release a completed task");
      task.owner = undefined;
      this.bump(task, principal);
      return task;
    }
    if (command.type === "review_request") {
      if (task.completionPolicy !== "review_required") {
        throw new TaskStoreError("INVALID_STATE_TRANSITION", "Direct tasks do not use review");
      }
      if (
        task.status !== "in_progress" ||
        (task.review.state !== "none" && task.review.state !== "changes_requested")
      ) {
        throw new TaskStoreError(
          "INVALID_STATE_TRANSITION",
          "Review can only be requested for in-progress work",
        );
      }
      const review = {
        state: "requested" as const,
        requestId: command.requestId,
        requestedBy: principal.actorId,
        requestedAt: new Date().toISOString(),
      };
      task.review = review;
      task.reviewReceipts.push({
        command: "request",
        requestId: command.requestId,
        result: clone(review),
      });
      this.trimReceipts(task);
      this.bump(task, principal);
      return task;
    }
    if (command.type === "review_approve" || command.type === "review_reject") {
      if (task.review.state !== "requested" || task.review.requestId !== command.requestId) {
        throw new TaskStoreError("REVIEW_REQUEST_MISMATCH", "Review request does not match");
      }
      if (command.type === "review_approve") this.assertUnblocked(list, task);
      const now = new Date().toISOString();
      const review =
        command.type === "review_approve"
          ? {
              ...task.review,
              state: "approved" as const,
              reviewedBy: principal.actorId,
              reviewedAt: now,
            }
          : {
              ...task.review,
              state: "changes_requested" as const,
              reviewedBy: principal.actorId,
              reviewedAt: now,
              ...(command.reason ? { reason: command.reason } : {}),
            };
      task.review = review;
      if (command.type === "review_approve") task.status = "completed";
      task.reviewReceipts.push({
        command: command.type === "review_approve" ? "approve" : "reject",
        requestId: command.requestId,
        result: clone(review),
      });
      this.trimReceipts(task);
      this.bump(task, principal);
      return task;
    }
    return task;
  }

  private updateStatus(
    list: PersistedTaskList,
    task: AgentTaskNode,
    status: AgentTaskNode["status"],
    principal: TaskCommandPrincipal,
  ): void {
    if (status === task.status) return;
    if (task.status === "completed")
      throw new TaskStoreError("INVALID_STATE_TRANSITION", "Use TaskReopen");
    if (task.review.state === "requested")
      throw new TaskStoreError("INVALID_STATE_TRANSITION", "Resolve review first");
    if (status === "in_progress") this.assertUnblocked(list, task);
    if (status === "completed") {
      this.assertUnblocked(list, task);
      if (
        task.completionPolicy !== "direct" ||
        task.routing.executionTarget !== "lead" ||
        task.review.state !== "none"
      ) {
        throw new TaskStoreError("INVALID_STATE_TRANSITION", "Task requires review approval");
      }
      if (principal.role !== "lead") deny("Only lead can directly complete");
    }
    task.status = status;
  }

  private updateDependencies(
    list: PersistedTaskList,
    task: AgentTaskNode,
    changes: DependencyChanges,
  ): void {
    const add = (blockerId: string, blockedId: string): void => {
      if (blockerId === blockedId)
        throw new TaskStoreError("INVALID_STATE_TRANSITION", "Self dependency");
      const blocker = this.task(list, blockerId);
      const blocked = this.task(list, blockedId);
      if (!blocker.blocks.includes(blockedId)) blocker.blocks.push(blockedId);
      if (!blocked.blockedBy.includes(blockerId)) blocked.blockedBy.push(blockerId);
    };
    const remove = (blockerId: string, blockedId: string): void => {
      const blocker = this.task(list, blockerId);
      const blocked = this.task(list, blockedId);
      blocker.blocks = blocker.blocks.filter((id) => id !== blockedId);
      blocked.blockedBy = blocked.blockedBy.filter((id) => id !== blockerId);
    };
    for (const id of changes.addBlocks ?? []) add(task.id, id);
    for (const id of changes.addBlockedBy ?? []) add(id, task.id);
    for (const id of changes.removeBlocks ?? []) remove(task.id, id);
    for (const id of changes.removeBlockedBy ?? []) remove(id, task.id);
    if (hasDependencyCycle(Object.values(list.tasks))) {
      throw new TaskStoreError("INVALID_STATE_TRANSITION", "Dependency cycle");
    }
  }

  private reviewReplay(task: AgentTaskNode, command: TaskCommand): AgentTaskNode | undefined {
    if (
      command.type !== "review_request" &&
      command.type !== "review_approve" &&
      command.type !== "review_reject"
    )
      return undefined;
    const kind =
      command.type === "review_request"
        ? "request"
        : command.type === "review_approve"
          ? "approve"
          : "reject";
    if (kind === "request") {
      if (task.review.state === "requested" && task.review.requestId === command.requestId)
        return task;
      if (task.review.state === "requested") {
        throw new TaskStoreError("REVIEW_ALREADY_REQUESTED", "A review is already requested");
      }
      if (
        task.review.state === "changes_requested" &&
        task.review.requestId === command.requestId
      ) {
        throw new TaskStoreError(
          "REVIEW_REQUEST_MISMATCH",
          "A new review round requires a new requestId",
        );
      }
      if (task.review.state === "approved") {
        throw new TaskStoreError("TASK_ALREADY_COMPLETED", "Task review is approved");
      }
      return undefined;
    }
    const receipt = task.reviewReceipts.find(
      (item) => item.command === kind && item.requestId === command.requestId,
    );
    if (receipt) {
      const replay = clone(task);
      replay.review = clone(receipt.result);
      replay.status = receipt.result.state === "approved" ? "completed" : "in_progress";
      return replay;
    }
    if (
      task.review.state === "changes_requested" &&
      task.review.requestId === command.requestId &&
      kind === "approve"
    ) {
      throw new TaskStoreError("INVALID_STATE_TRANSITION", "Rejected review cannot be approved");
    }
    if (task.review.state === "approved")
      throw new TaskStoreError("TASK_ALREADY_COMPLETED", "Task review is approved");
    return undefined;
  }

  private trimReceipts(task: AgentTaskNode): void {
    const rounds = [...new Set(task.reviewReceipts.map((receipt) => receipt.requestId))];
    const keep = new Set(rounds.slice(-20));
    task.reviewReceipts = task.reviewReceipts.filter((receipt) => keep.has(receipt.requestId));
  }

  private requireTaskUpdate(principal: TaskCommandPrincipal, task: AgentTaskNode): void {
    if (principal.permissions.has("task:update_any")) return;
    if (principal.permissions.has("task:update_own") && task.owner === principal.actorId) return;
    deny("Task update is not authorized");
  }

  private requirePermission(principal: TaskCommandPrincipal, permission: TaskPermission): void {
    if (!principal.permissions.has(permission)) deny(`Missing permission: ${permission}`);
  }

  private validateIdentity(principal: TaskCommandPrincipal): void {
    const supplied = principal.taskListIdentity;
    if (
      !supplied ||
      supplied.taskListId !== this.identity.taskListId ||
      supplied.scope !== this.identity.scope ||
      supplied.canonicalKey !== this.identity.canonicalKey
    ) {
      deny("Principal and task list identity do not match");
    }
  }

  principal(
    actorId: string,
    role: TaskCommandPrincipal["role"],
    permissions: ReadonlySet<TaskPermission>,
  ): TaskCommandPrincipal {
    return {
      actorId,
      role,
      taskListIdentity: clone(this.identity),
      permissions,
    };
  }

  private task(list: PersistedTaskList, id: string): AgentTaskNode {
    const task = list.tasks[id];
    if (!task) throw new TaskStoreError("TASK_NOT_FOUND", `Task not found: ${id}`);
    return task;
  }

  private taskRevision(task: AgentTaskNode, expected: number | undefined): void {
    if (expected !== undefined && task.revision !== expected) {
      throw new TaskStoreError(
        "REVISION_CONFLICT",
        `Expected task revision ${expected}, got ${task.revision}`,
      );
    }
  }

  private listRevision(list: PersistedTaskList, expected: number): void {
    if (list.listRevision !== expected) {
      throw new TaskStoreError(
        "REVISION_CONFLICT",
        `Expected list revision ${expected}, got ${list.listRevision}`,
      );
    }
  }

  private assertUnblocked(list: PersistedTaskList, task: AgentTaskNode): void {
    const byId = new Map(Object.values(list.tasks).map((item) => [item.id, item]));
    if (!canStartTask(task, byId)) {
      throw new TaskStoreError(
        "TASK_BLOCKED",
        `Blocked by: ${getIncompleteBlockedBy(task, byId).join(", ")}`,
      );
    }
  }

  /**
   * An owner has one execution slot. A task awaiting lead review keeps its
   * owner for review continuity, but no longer occupies that execution slot.
   */
  private ownerHasActiveWork(
    list: PersistedTaskList,
    owner: string,
    exceptTaskId: string,
  ): boolean {
    return Object.values(list.tasks).some(
      (task) =>
        task.owner === owner &&
        task.id !== exceptTaskId &&
        task.status !== "completed" &&
        task.review.state !== "requested",
    );
  }

  private touch(task: AgentTaskNode, principal: TaskCommandPrincipal): void {
    task.systemMetadata = {
      ...task.systemMetadata,
      updatedAt: new Date().toISOString(),
      updatedBy: principal.actorId,
    };
    task.revision += 1;
  }

  private taskContent(task: AgentTaskNode): string {
    const copy = clone(task);
    copy.revision = 0;
    if (copy.systemMetadata) {
      delete copy.systemMetadata.updatedAt;
      delete copy.systemMetadata.updatedBy;
    }
    return JSON.stringify(copy);
  }

  private bump(task: AgentTaskNode, principal: TaskCommandPrincipal): void {
    this.touch(task, principal);
  }

  private validateList(list: PersistedTaskList): void {
    const tasks = Object.values(list.tasks).map((task) => agentTaskNodeSchema.parse(task));
    for (const task of tasks) {
      for (const id of task.blocks) {
        if (!list.tasks[id]?.blockedBy.includes(task.id))
          throw new Error(`Broken dependency ${task.id} -> ${id}`);
      }
      for (const id of task.blockedBy) {
        if (!list.tasks[id]?.blocks.includes(task.id))
          throw new Error(`Broken dependency ${id} -> ${task.id}`);
      }
    }
    if (hasDependencyCycle(tasks)) throw new Error("Dependency cycle");
  }

  private result(
    list: PersistedTaskList,
    task: AgentTaskNode | undefined,
    changed: boolean,
  ): TaskMutationResult {
    return {
      taskListId: list.identity.taskListId,
      ...(task ? { task: clone(task) } : {}),
      tasks: Object.values(list.tasks)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map(clone),
      listRevision: list.listRevision,
      state: list.state,
      ...(list.archive ? { archive: clone(list.archive) } : {}),
      changed,
    };
  }

  async storageLocation(): Promise<{ directory: string; file: string }> {
    await this.ensureStorage();
    return { directory: this.listDir, file: this.dataPath };
  }

  private async readListAfterEnsure(): Promise<PersistedTaskList> {
    await this.ensureStorage();
    return this.readList();
  }

  private async readList(): Promise<PersistedTaskList> {
    const parsed = await readJsonFile<PersistedTaskList>(this.dataPath);
    if (!parsed) {
      throw new TaskStoreError(
        "MIGRATION_FAILED",
        `Task-list directory ${basename(this.listDir)} is missing tasks.json`,
      );
    }
    if (
      parsed.format !== "task-list" ||
      parsed.version !== 1 ||
      parsed.identity.canonicalKey !== this.identity.canonicalKey ||
      parsed.identity.taskListId !== this.identity.taskListId ||
      parsed.identity.scope !== this.identity.scope
    ) {
      throw new TaskStoreError("MIGRATION_FAILED", "Task list identity or format mismatch");
    }
    this.validateList(parsed);
    return parsed;
  }

  private async ensureStorage(): Promise<void> {
    this.initialization ??= this.initializeStorage();
    await this.initialization;
  }

  private async initializeStorage(): Promise<void> {
    await mkdir(this.workspaceRoot, { recursive: true });
    const migrationTarget = join(this.workspaceRoot, ".task-storage-migration");
    const releaseMigration = await lockfile.lock(migrationTarget, LOCK_OPTIONS);
    try {
      await this.migrateLegacy();
      await mkdir(this.storeRoot, { recursive: true });
      const marker = join(this.storeRoot, "schema.json");
      try {
        const schema = JSON.parse(await readFile(marker, "utf8")) as {
          format?: string;
          version?: number;
        };
        if (schema.format !== "task-store" || schema.version !== 1) {
          throw new TaskStoreError("MIGRATION_FAILED", "Invalid task-store schema marker");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await writeJsonFileAtomic(marker, { format: "task-store", version: 1 });
      }
      const listDirectoryName = basename(this.listDir);
      const rootEntries = await readdir(this.storeRoot, { withFileTypes: true });
      const existingListDirectory = rootEntries.some(
        (entry) => entry.isDirectory() && entry.name === listDirectoryName,
      );
      if (existingListDirectory) {
        await this.readList();
      } else {
        await mkdir(this.listDir, { recursive: false });
        const initial: PersistedTaskList = {
          format: "task-list",
          version: 1,
          identity: this.identity,
          state: "open",
          listRevision: 0,
          highWatermark: 0,
          hasEverContainedTasks: false,
          tasks: {},
        };
        await writeFile(this.dataPath, `${JSON.stringify(initial, null, 2)}\n`, { flag: "wx" });
      }
    } finally {
      await releaseMigration();
    }
  }

  private async migrateLegacy(): Promise<void> {
    try {
      const entries = await readdir(this.storeRoot);
      if (entries.includes("schema.json")) return;
      if (entries.length === 0) return;
      if (entries.some((name) => name.endsWith(".json"))) {
        await rename(this.storeRoot, join(this.workspaceRoot, `.tasks-legacy-${randomUUID()}`));
        return;
      }
      throw new TaskStoreError(
        "MIGRATION_FAILED",
        "Task storage has content but no schema marker; refusing partial migration",
      );
    } catch (error) {
      if (error instanceof TaskStoreError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT")
        throw new TaskStoreError("MIGRATION_FAILED", `Legacy migration failed: ${String(error)}`);
    }
  }

  async listDispatchCandidates(actorId: string): Promise<TaskDispatchCandidate[]> {
    const tasks = await this.listTasks();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const eligible = (task: AgentTaskNode): boolean =>
      !task.owner && task.routing.executionTarget === "teammate" && canStartTask(task, byId);
    const recoverInProgress = tasks
      .filter(
        (task) => eligible(task) && task.status === "in_progress" && task.review.state === "none",
      )
      .map((task) => ({ task, mode: "recover_in_progress" as const }));
    const recoverChanges = tasks
      .filter(
        (task) =>
          eligible(task) &&
          task.status === "in_progress" &&
          task.review.state === "changes_requested" &&
          task.review.requestedBy === actorId,
      )
      .map((task) => ({ task, mode: "recover_changes" as const }));
    const pending = tasks
      .filter((task) => eligible(task) && task.status === "pending" && task.review.state === "none")
      .map((task) => ({ task, mode: "new_pending" as const }));
    return [...recoverInProgress, ...recoverChanges, ...pending];
  }
}

export function createTaskStore(
  workspaceRoot: string | undefined,
  identity?: TaskListIdentity,
): TaskStore | undefined {
  return workspaceRoot?.trim() ? new TaskStore(workspaceRoot, identity) : undefined;
}
