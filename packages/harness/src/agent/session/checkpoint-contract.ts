import type { AgentCheckpoint } from "./session-contract.js";

export interface CheckpointKey {
  readonly agentId: string;
  readonly threadId: string;
  readonly queryId: string;
}

export interface CheckpointLease {
  readonly key: CheckpointKey;
  /** 标识一次写入方激活，通常为其 runId；不是共享的进程标识。 */
  readonly ownerId: string;
  /** 每次获取该键时单调递增，且绝不重用。 */
  readonly generation: number;
}

export interface CheckpointAcquireOptions {
  /**
   * 在宿主确认该写入方已停止后的显式接管。
   * 存储在原子替换前比较整个观测到的租约。
   * 围栏无法撤回旧写入方已派发的外部影响。
   */
  readonly replace?: CheckpointLease;
}

export type CheckpointAcquireResult =
  | { readonly status: "busy"; readonly lease: CheckpointLease }
  | { readonly status: "stale" }
  | { readonly status: "thread-pending"; readonly queryId: string }
  | {
      readonly status: "acquired";
      readonly lease: CheckpointLease;
      /** 首次保存前为 0；释放或获取不会改变该修订号。 */
      readonly currentRevision: number;
      readonly checkpoint: AgentCheckpoint | null;
    };

export type CheckpointSaveResult =
  | { readonly status: "saved"; readonly revision: number }
  | { readonly status: "conflict"; readonly currentRevision: number }
  | { readonly status: "stale" };

/**
 * 存储在所有写入方之间（而非仅单个存储对象内）原子地强制独占写入方所有权、
 * 世代围栏与修订 CAS。没有租约 TTL，也没有自动接管。
 * I/O 失败以拒绝结束；它们不属于 busy/conflict/stale。
 */
export interface CheckpointStore {
  /** 发现线程内未结束的逻辑工作；观察结果不代替 acquire 的原子准入裁决。 */
  findUnfinished(agentId: string, threadId: string): Promise<AgentCheckpoint | null>;
  /**
   * 原子地获取无属主的键，或替换显式提供的确切租约。
   * 若属主存活且没有匹配的替换，则结果为 busy，即使 ownerId 匹配。
   * 过期的替换不得获取或释放该键，即使该键已被释放也不例外。
   * 在同一原子操作内检查同 agentId/threadId 的其他 Query：有活动属主，
   * 或状态为 running/waiting/interrupted，均返回 thread-pending 且不修改目标。
   * 首存前的无快照活动行、终态提交后尚未释放的行同样阻止另起 Query。
   * 判定顺序为 replace 的 stale、目标 busy、其他 Query 的 thread-pending。
   * 成功获取会读取快照并推进写入方世代。
   */
  acquire(
    key: CheckpointKey,
    ownerId: string,
    options?: CheckpointAcquireOptions,
  ): Promise<CheckpointAcquireResult>;
  /**
   * 先按当前 key/ownerId/generation 设围栏，再比较 expectedRevision。
   * 租约不匹配或已释放为 stale；租约当前但修订不匹配为 conflict。
   * 两种结果都不写入任何内容。检查点标识必须与 key 匹配。
   *
   * 成功会原子替换整个检查点并将修订号加一；快照与修订在该 promise 解析前
   * 均已持久提交，并能在存储/进程重启后保留。被拒绝的写入可能已经提交：
   * 调用方必须从存储进行对账，而不能假设失败意味着未写入。
   *
   * 这仅保护检查点所有权。它本身不会使工具副作用、交互消费或对另一存储的
   * 写入变成恰好一次。
   */
  save(
    lease: CheckpointLease,
    expectedRevision: number,
    checkpoint: AgentCheckpoint,
  ): Promise<CheckpointSaveResult>;
  /**
   * 幂等。仅当 key、ownerId 与 generation 仍标识当前属主时才释放；
   * 过期的释放绝不得释放更新的写入方或删除其检查点。
   */
  release(lease: CheckpointLease): Promise<void>;
}
