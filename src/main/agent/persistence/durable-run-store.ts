import { mkdir, open } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AgentExecutionStrategy, AgentModelSelection } from "@shared/agent";
import type { ConversationDatabase } from "../../conversation-database";
import type { PptTaskPlan } from "../../plugins/ppt/task/ppt-task-types";
import type {
  AgentModelMessage,
  AgentModelToolResultBlock,
  AgentModelToolUseBlock,
} from "../gateway";
import type { DurableBackgroundTask } from "../runtime/background/background-task-manager";
import type { QueryId, RunId, ThreadId } from "../runtime/query/query-types";
import { asRunId, asThreadId } from "../runtime/query/query-types";
import type { AgentRuntimeResult } from "../runtime/runtime-types";
import { readJsonFile, writeJsonFileAtomic } from "./atomic-json-file";

type LockRelease = () => Promise<void>;
type ProperLockfile = {
  lock(
    file: string,
    options?: {
      realpath?: boolean;
      stale?: number;
      retries?:
        | number
        | { retries?: number; minTimeout?: number; maxTimeout?: number; factor?: number };
    },
  ): Promise<LockRelease>;
};
const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile") as ProperLockfile;

export type DurableRunStatus = "running" | "waiting_user" | "completed" | "interrupted" | "failed";

export type DurableRunPhase =
  | "before_model"
  | "model_committed"
  | "tool_running"
  | "tool_committed"
  | "finished";

export interface LegacyDurableRunCheckpoint {
  version: 1;
  threadId: string;
  runId?: string;
  status: DurableRunStatus;
  phase: DurableRunPhase;
  request: string;
  model?: AgentModelSelection;
  executionStrategy?: AgentExecutionStrategy;
  baseRevision: number;
  modelStep: number;
  modelMessages: AgentModelMessage[];
  transcript: Array<Record<string, unknown>>;
  queuedToolUses: AgentModelToolUseBlock[];
  pendingToolResults: AgentModelToolResultBlock[];
  pendingUserContent: string[];
  discoveredToolNames: string[];
  loadedSkillNames: string[];
  activeToolUse?: AgentModelToolUseBlock;
  /** 每次运行的后台任务终态与通知消费状态。 */
  backgroundTasks?: DurableBackgroundTask[];
  /** 在确认可恢复 Inbox claim 前已提交的消息 ID。 */
  processedInboxMessageIds?: string[];
  queryLifecycle?: DurableQueryLifecycleSnapshot;
  result?: AgentRuntimeResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DurableRunCheckpointV2Payload {
  version: 2;
  threadId: ThreadId;
  queryId: QueryId;
  lastRunId: RunId;
  status: DurableRunStatus;
  phase: DurableRunPhase;
  request: string;
  model?: AgentModelSelection;
  executionStrategy?: AgentExecutionStrategy;
  baseRevision?: number;
  transcript: Array<Record<string, unknown>>;
  pendingUserContent: string[];
  discoveredToolNames: string[];
  loadedSkillNames: string[];
  /** Advisory query-level task plan; not PptJob business state. */
  pptTaskPlan?: PptTaskPlan;
  backgroundTasks?: DurableBackgroundTask[];
  processedInboxMessageIds?: string[];
  committedState: DurableQueryStateSnapshot;
  inflight?: DurableQueryInflightSnapshot;
  /**
   * Complete canonical history staged for a successful terminal. This is a
   * recovery fallback for the crash window between terminal checkpointing and
   * the independent ConversationHistoryStore write.
   */
  terminalHistory?: AgentModelMessage[];
  result?: AgentRuntimeResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type DurableRunCheckpoint = LegacyDurableRunCheckpoint | DurableRunCheckpointV2Payload;

export interface DurableQueryStateSnapshot {
  messages: AgentModelMessage[];
  turnCount: number;
  transition?: { reason: string };
  maxOutputTokensOverride?: number;
  maxOutputTokensRecoveryCount: number;
  hasAttemptedReactiveCompact: boolean;
  validationFailuresByTool: Array<[string, number]>;
}

export interface DurableIterationWorkspaceSnapshot {
  messagesForQuery: AgentModelMessage[];
  assistantMessages: AgentModelMessage[];
  toolUseBlocks: AgentModelToolUseBlock[];
  toolResults: AgentModelToolResultBlock[];
  userContent?: string[];
  followUpMessages: AgentModelMessage[];
  needsFollowUp: boolean;
  maxOutputTokensOverride?: number;
  maxOutputTokensRecoveryCount?: number;
  hasAttemptedReactiveCompact?: boolean;
  validationFailuresByTool?: Array<[string, number]>;
}

export interface DurableQueryLifecycleSnapshot {
  queryId: string;
  committedState: DurableQueryStateSnapshot;
  inflight?: DurableQueryInflightSnapshot;
}

export interface DurableQueryInflightSnapshot {
  phase: "model_streaming" | "model_received" | "tool_running" | "waiting_user";
  workspace: DurableIterationWorkspaceSnapshot;
  /** Canonical v2 representation for one serial call or a concurrent wave. */
  activeToolUses?: AgentModelToolUseBlock[];
  /** Backward-compatible reader for checkpoints written before concurrent waves. */
  activeToolUse?: AgentModelToolUseBlock;
}

export interface CheckpointLease {
  threadId: ThreadId;
  runId: RunId;
  generation: number;
}

export interface DurableRunCheckpointEnvelope {
  version: 2;
  writer: {
    runId: RunId;
    generation: number;
    revision: number;
    active: boolean;
  };
  payload?: DurableRunCheckpoint;
}

export type OpenCheckpointLeaseResult =
  | {
      type: "opened";
      lease: CheckpointLease;
      currentRevision: number;
      checkpoint?: DurableRunCheckpoint;
    }
  | {
      type: "lease_busy";
      activeRunId: string;
      generation: number;
    };

export type CheckpointSaveResult =
  | "saved"
  | "already_applied"
  | "stale_generation"
  | "revision_conflict";

export type CheckpointLeaseInspection =
  | { type: "active"; revision: number; checkpoint?: DurableRunCheckpoint }
  | { type: "stale" };

function safeThreadId(threadId: string): string {
  return threadId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || "thread";
}

export class DurableRunStore {
  constructor(private readonly storage: string | ConversationDatabase) {}

  pathFor(threadId: string): string {
    if (typeof this.storage !== "string") {
      throw new Error("SQLite-backed run checkpoints do not have workspace paths.");
    }
    return join(this.storage, ".agent", "runs", `${safeThreadId(threadId)}.json`);
  }

  async load(threadId: string): Promise<DurableRunCheckpoint | undefined> {
    if (typeof this.storage !== "string") {
      const stored = this.storage.loadRunCheckpoint<
        DurableRunCheckpoint | DurableRunCheckpointEnvelope
      >(threadId);
      return checkpointPayload(stored, threadId);
    }
    const stored = await readJsonFile<DurableRunCheckpoint | DurableRunCheckpointEnvelope>(
      this.pathFor(threadId),
    );
    return checkpointPayload(stored, threadId);
  }

  async save(checkpoint: DurableRunCheckpoint): Promise<void> {
    if (typeof this.storage !== "string") {
      this.storage.saveRunCheckpoint(
        checkpoint.threadId,
        checkpoint,
        checkpoint.version === 1 ? checkpoint.runId : checkpoint.lastRunId,
      );
      return;
    }
    await writeJsonFileAtomic(this.pathFor(checkpoint.threadId), checkpoint);
  }

  async openLease(input: {
    threadId: string;
    runId: string;
    resume: boolean;
    allowTakeover?: boolean;
  }): Promise<OpenCheckpointLeaseResult> {
    if (typeof this.storage !== "string") {
      const result = this.storage.openRunCheckpointLease(input);
      if (result.type === "lease_busy") return result;
      return {
        type: "opened",
        lease: {
          threadId: asThreadId(input.threadId),
          runId: asRunId(input.runId),
          generation: result.generation,
        },
        currentRevision: result.revision,
        checkpoint: checkpointPayload(
          result.checkpoint as DurableRunCheckpoint | DurableRunCheckpointEnvelope | undefined,
          input.threadId,
        ),
      };
    }

    return this.withFileLeaseLock(input.threadId, async () => {
      const path = this.pathFor(input.threadId);
      const stored = await readJsonFile<DurableRunCheckpoint | DurableRunCheckpointEnvelope>(path);
      const existingWriter = isCheckpointEnvelope(stored) ? stored.writer : undefined;
      if (existingWriter?.active && existingWriter.runId !== input.runId && !input.allowTakeover) {
        return {
          type: "lease_busy" as const,
          activeRunId: existingWriter.runId,
          generation: existingWriter.generation,
        };
      }
      if (existingWriter?.active && existingWriter.runId === input.runId) {
        return {
          type: "opened" as const,
          lease: {
            threadId: asThreadId(input.threadId),
            runId: asRunId(input.runId),
            generation: existingWriter.generation,
          },
          currentRevision: existingWriter.revision,
          checkpoint: checkpointPayload(stored, input.threadId),
        };
      }

      const generation = (existingWriter?.generation ?? 0) + 1;
      const envelope: DurableRunCheckpointEnvelope = {
        version: 2,
        writer: { runId: asRunId(input.runId), generation, revision: 0, active: true },
        payload: checkpointPayload(stored, input.threadId),
      };
      await writeJsonFileAtomic(path, envelope);
      return {
        type: "opened" as const,
        lease: {
          threadId: asThreadId(input.threadId),
          runId: asRunId(input.runId),
          generation,
        },
        currentRevision: 0,
        checkpoint: envelope.payload,
      };
    });
  }

  async saveCas(input: {
    lease: CheckpointLease;
    expectedRevision: number;
    nextRevision: number;
    checkpoint: DurableRunCheckpoint;
  }): Promise<CheckpointSaveResult> {
    if (typeof this.storage !== "string") {
      return this.storage.saveRunCheckpointCas({
        threadId: input.lease.threadId,
        runId: input.lease.runId,
        generation: input.lease.generation,
        expectedRevision: input.expectedRevision,
        nextRevision: input.nextRevision,
        checkpoint: input.checkpoint,
      });
    }
    return this.withFileLeaseLock(input.lease.threadId, async () => {
      const path = this.pathFor(input.lease.threadId);
      const stored = await readJsonFile<DurableRunCheckpointEnvelope>(path);
      if (
        stored?.version !== 2 ||
        !stored.writer.active ||
        stored.writer.runId !== input.lease.runId ||
        stored.writer.generation !== input.lease.generation
      )
        return "stale_generation";

      if (stored.writer.revision === input.nextRevision) {
        return JSON.stringify(stored.payload) === JSON.stringify(input.checkpoint)
          ? "already_applied"
          : "revision_conflict";
      }
      if (
        stored.writer.revision !== input.expectedRevision ||
        input.nextRevision !== input.expectedRevision + 1
      )
        return "revision_conflict";

      await writeJsonFileAtomic(path, {
        version: 2,
        writer: { ...stored.writer, revision: input.nextRevision },
        payload: structuredClone(input.checkpoint),
      } satisfies DurableRunCheckpointEnvelope);
      return "saved";
    });
  }

  async closeLease(lease: CheckpointLease): Promise<boolean> {
    if (typeof this.storage !== "string") {
      return this.storage.closeRunCheckpointLease(lease);
    }
    return this.withFileLeaseLock(lease.threadId, async () => {
      const path = this.pathFor(lease.threadId);
      const stored = await readJsonFile<DurableRunCheckpointEnvelope>(path);
      if (
        stored?.version !== 2 ||
        stored.writer.runId !== lease.runId ||
        stored.writer.generation !== lease.generation
      )
        return false;
      await writeJsonFileAtomic(path, {
        ...stored,
        writer: { ...stored.writer, active: false },
      } satisfies DurableRunCheckpointEnvelope);
      return true;
    });
  }

  async inspectLease(lease: CheckpointLease): Promise<CheckpointLeaseInspection> {
    if (typeof this.storage !== "string") {
      const inspected = this.storage.inspectRunCheckpointLease(lease);
      if (inspected.type === "stale") return inspected;
      return {
        type: "active",
        revision: inspected.revision,
        checkpoint: checkpointPayload(
          inspected.checkpoint as DurableRunCheckpoint | DurableRunCheckpointEnvelope | undefined,
          lease.threadId,
        ),
      };
    }
    return this.withFileLeaseLock(lease.threadId, async () => {
      const stored = await readJsonFile<DurableRunCheckpointEnvelope>(this.pathFor(lease.threadId));
      if (
        stored?.version !== 2 ||
        !stored.writer.active ||
        stored.writer.runId !== lease.runId ||
        stored.writer.generation !== lease.generation
      )
        return { type: "stale" as const };
      return {
        type: "active" as const,
        revision: stored.writer.revision,
        checkpoint: checkpointPayload(stored, lease.threadId),
      };
    });
  }

  private async withFileLeaseLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const lockTarget = `${this.pathFor(threadId)}.writer`;
    await mkdir(dirname(lockTarget), { recursive: true });
    await (await open(lockTarget, "a")).close();
    const release = await lockfile.lock(lockTarget, {
      realpath: false,
      stale: 30_000,
      retries: { retries: 20, factor: 1, minTimeout: 10, maxTimeout: 75 },
    });
    try {
      return await task();
    } finally {
      await release();
    }
  }
}

function checkpointPayload(
  stored: DurableRunCheckpoint | DurableRunCheckpointEnvelope | undefined,
  threadId: string,
): DurableRunCheckpoint | undefined {
  const checkpoint = isCheckpointEnvelope(stored) ? stored.payload : stored;
  if (!checkpoint || checkpoint.threadId !== threadId) return undefined;
  return checkpoint;
}

function isCheckpointEnvelope(
  stored: DurableRunCheckpoint | DurableRunCheckpointEnvelope | undefined,
): stored is DurableRunCheckpointEnvelope {
  return stored?.version === 2 && "writer" in stored;
}
