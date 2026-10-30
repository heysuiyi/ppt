import { AgentError, sameValue, snapshot } from "../../protocol-utils";
import type { CheckpointLease, CheckpointStore } from "../../session/checkpoint-contract";
import type {
  AgentCheckpoint,
  InflightCheckpoint,
  SessionHistoryStore,
} from "../../session/session-contract";

export function checkpointData(state: AgentCheckpoint) {
  return {
    schemaVersion: state.schemaVersion,
    agentId: state.agentId,
    threadId: state.threadId,
    queryId: state.queryId,
    lastRunId: state.lastRunId,
    definition: state.definition,
    plugins: state.plugins,
    model: state.model,
    maxSteps: state.maxSteps,
    committed: state.committed,
    startMessageCount: state.startMessageCount,
    extensions: state.extensions,
  };
}

export function running(state: AgentCheckpoint, inflight?: InflightCheckpoint): AgentCheckpoint {
  return { ...checkpointData(state), status: "running", ...(inflight ? { inflight } : {}) };
}

/** 检查点与历史不假设共用事务；先保存意图，再用幂等批次提交历史。 */
export class CheckpointSession {
  constructor(
    readonly lease: CheckpointLease,
    private revision: number,
    public state: AgentCheckpoint,
    private readonly checkpoints: CheckpointStore,
    private readonly history: SessionHistoryStore,
  ) {}

  async save(next: AgentCheckpoint): Promise<void> {
    const detached = snapshot(next);
    let result;
    try {
      result = await this.checkpoints.save(this.lease, this.revision, detached);
    } catch {
      throw new AgentError("PERSISTENCE_FAILED", "Checkpoint write could not be confirmed");
    }
    if (result.status !== "saved") {
      throw new AgentError(
        "CHECKPOINT_CONFLICT",
        "Checkpoint writer or revision is no longer current",
      );
    }
    // 只有存储确认 CAS 成功，内存快照与修订号才一起向前推进。
    this.state = detached;
    this.revision = result.revision;
  }

  async reconcileHistory(): Promise<boolean> {
    const state = this.state;
    if (state.status !== "running" || state.inflight?.type !== "history") return false;
    const intent = state.inflight;
    // 批次 ID 属于持久意图而非本次 Run；上次已提交但丢失确认时，重试取回同一收据。
    let appended;
    try {
      appended = await this.history.append(
        state.threadId,
        state.committed.historyRevision,
        intent.messages,
        intent.batchId,
      );
    } catch {
      throw new AgentError("PERSISTENCE_FAILED", "History append could not be confirmed");
    }
    if (appended.status !== "appended") {
      throw new AgentError(
        "HISTORY_CONFLICT",
        "Conversation history was changed by another execution",
      );
    }
    const base = {
      ...checkpointData(state),
      committed: {
        messages: [...state.committed.messages, ...intent.messages],
        historyRevision: appended.revision,
        step: intent.step,
      },
    };
    // 历史先提交、检查点后确认；若检查点未更新，恢复仍可用原追加意图对账。
    await this.save(
      intent.terminal ? { ...base, status: "completed" } : { ...base, status: "running" },
    );
    return true;
  }

  async verifyHistory(): Promise<void> {
    let history;
    try {
      history = await this.history.read(this.state.threadId);
    } catch {
      throw new AgentError("PERSISTENCE_FAILED", "Conversation history could not be read");
    }
    if (
      history.revision !== this.state.committed.historyRevision ||
      !sameValue(history.messages, this.state.committed.messages)
    ) {
      throw new AgentError("HISTORY_CONFLICT", "Checkpoint and conversation history disagree");
    }
  }
}
