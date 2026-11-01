import type { ToolDefinition } from "../../tools/tool-definition";

export interface BackgroundTaskNotification {
  bgId: string;
  toolName: string;
  label: string;
  status: "completed" | "failed";
  content: string;
  isError: boolean;
}

export interface DurableBackgroundTask {
  bgId: string;
  runId: string;
  toolUseId?: string;
  toolName: string;
  label: string;
  status: "scheduled" | "running" | "completed" | "failed" | "consumed";
  startedAt: number;
  content?: string;
  isError?: boolean;
}

export class BackgroundTaskManager {
  private counter = 0;
  private readonly tasks = new Map<string, DurableBackgroundTask>();
  private onStateChange?: () => void | Promise<void>;

  constructor(input?: {
    runId?: string;
    recovered?: DurableBackgroundTask[];
  }) {
    this.runId = input?.runId ?? crypto.randomUUID();
    for (const recovered of input?.recovered ?? []) {
      const task = structuredClone(recovered);
      if (task.status === "scheduled") {
        task.status = "failed";
        task.isError = true;
        task.content =
          "The application restarted before this background task started. It is safe to schedule it again.";
      } else if (task.status === "running") {
        // 进程重启后无法恢复内存 Promise；直接持久化终态“不确定”通知，
        // 不再通过扫描 Transcript 推断任务状态。
        task.status = "failed";
        task.isError = true;
        task.content =
          "The application restarted before this background task committed its result. Inspect durable artifacts before retrying.";
      }
      this.tasks.set(task.bgId, task);
    }
  }

  private readonly runId: string;

  setOnStateChange(callback?: () => void | Promise<void>): void {
    this.onStateChange = callback;
  }

  snapshot(): DurableBackgroundTask[] {
    return [...this.tasks.values()].map((task) => structuredClone(task));
  }

  start(input: {
    toolName: string;
    label: string;
    toolUseId?: string;
    run: () => Promise<unknown>;
  }): string {
    const scheduled = this.prepare(input);
    scheduled.launch();
    return scheduled.bgId;
  }

  prepare(input: {
    toolName: string;
    label: string;
    toolUseId?: string;
    run: () => Promise<unknown>;
  }): { bgId: string; launch: () => void } {
    this.counter += 1;
    const bgId = `${this.runId}:bg_${String(this.counter).padStart(4, "0")}`;
    this.tasks.set(bgId, {
      bgId,
      runId: this.runId,
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      label: input.label,
      status: "scheduled",
      startedAt: Date.now(),
    });
    void this.onStateChange?.();

    let launched = false;
    return {
      bgId,
      launch: () => {
        if (launched) return;
        launched = true;
        const task = this.tasks.get(bgId);
        if (task?.status !== "scheduled") return;
        task.status = "running";
        task.startedAt = Date.now();
        void this.onStateChange?.();
        void input.run().then(
          (result) => this.settle(bgId, stringifyBackgroundResult(result), false),
          (error) =>
            this.settle(bgId, error instanceof Error ? error.message : String(error), true),
        );
      },
    };
  }

  hasRunning(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === "scheduled" || task.status === "running") return true;
    }
    return false;
  }

  hasPendingNotifications(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === "completed" || task.status === "failed") return true;
    }
    return false;
  }

  collect(): BackgroundTaskNotification[] {
    const ready: BackgroundTaskNotification[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== "completed" && task.status !== "failed") continue;
      ready.push({
        bgId: task.bgId,
        toolName: task.toolName,
        label: task.label,
        status: task.status,
        content: task.content ?? "",
        isError: task.isError === true,
      });
      // 在 checkpoint 中保留终态记录，使恢复逻辑能够区分
      // 已投递通知与仍需重放的任务。
      task.status = "consumed";
    }
    if (ready.length > 0) void this.onStateChange?.();
    return ready;
  }

  async drain(signal?: AbortSignal): Promise<BackgroundTaskNotification[]> {
    while (this.hasRunning()) {
      if (signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.collect();
  }

  private settle(bgId: string, content: string, isError: boolean): void {
    const task = this.tasks.get(bgId);
    if (!task) return;
    task.status = isError ? "failed" : "completed";
    task.content = content;
    task.isError = isError;
    // 后台完成状态独立于下一次模型回合持久化，避免崩溃后把
    // 已成功结束的任务重新解释为 running。
    void this.onStateChange?.();
  }
}

export function shouldRunBackground(tool: ToolDefinition<any, any>, args: unknown): boolean {
  return tool.behavior?.background?.isRequested(args) === true;
}

export function describeBackgroundTask(tool: ToolDefinition<any, any>, args: unknown): string {
  return tool.behavior?.background?.describe(args) ?? tool.name;
}

export function formatBackgroundNotifications(notifications: BackgroundTaskNotification[]): string {
  return notifications
    .map((notification) => {
      const tagName = notification.isError ? "error" : "summary";
      return [
        "<task_notification>",
        `  <task_id>${escapeXml(notification.bgId)}</task_id>`,
        `  <status>${notification.status}</status>`,
        `  <tool>${escapeXml(notification.toolName)}</tool>`,
        `  <label>${escapeXml(notification.label)}</label>`,
        `  <${tagName}>${escapeXml(truncateForNotification(notification.content, 1_000))}</${tagName}>`,
        "</task_notification>",
      ].join("\n");
    })
    .join("\n\n");
}

function stringifyBackgroundResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result ?? null);
  } catch {
    return String(result);
  }
}

function truncateForNotification(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
