import type {
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelSelection,
  ModelToolCallContent,
} from "../model/model-contract";
import type {
  InteractionRequest,
  ProtocolError,
  RunIdentity,
  VersionedData,
} from "../protocol-values";
import type { ToolCompletion, ToolSideEffects } from "../tools/tool-contract";

export interface SessionHistory {
  readonly threadId: string;
  /** 空线程从 0 开始，每次成功追加后递增。 */
  readonly revision: number;
  readonly messages: readonly ModelMessage[];
}

export type SessionHistoryAppendResult =
  | { readonly status: "appended"; readonly revision: number }
  | { readonly status: "conflict"; readonly currentRevision: number };

/** 规范的模型历史，包含有序的工具调用/结果与提供方重放状态。 */
export interface SessionHistoryStore {
  /** 不存在的线程读取为修订 0 的空历史。I/O 失败以拒绝结束。 */
  read(threadId: string): Promise<SessionHistory>;
  /**
   * 仅当 expectedRevision 匹配时，才原子地追加整个有序批次。
   * 成功会持久保留既有前缀并将修订号加一；冲突不改变任何内容。
   * I/O 失败以拒绝结束，而不转化为冲突。
   */
  append(
    threadId: string,
    expectedRevision: number,
    messages: readonly ModelMessage[],
  ): Promise<SessionHistoryAppendResult>;
}

/** 标识与固定实现版本可在另一次运行恢复该调用时保持不变。 */
export interface StoredToolInvocation {
  readonly identity: RunIdentity;
  readonly call: ModelToolCallContent;
  readonly toolVersion: string;
}

export interface StoredToolCompletion {
  readonly invocation: StoredToolInvocation;
  /** 包含已转换的模型内容；恢复时不得重新执行其转换。 */
  readonly completion: ToolCompletion;
}

export interface ModelRequestCheckpoint {
  readonly type: "model";
  readonly requestId: string;
  readonly request: ModelRequest;
}

export interface ToolBatchCheckpoint {
  readonly type: "tools";
  /** 权威响应保留调用顺序与提供方重放状态。 */
  readonly response: ModelResponse;
  /**
   * 尚无持久化完成记录的调用，排除等待检查点的待处理调用。
   * 缺少结果并不证明没有发生副作用。
   */
  readonly remaining: readonly StoredToolInvocation[];
  readonly completed: readonly StoredToolCompletion[];
}

export type InflightCheckpoint = ModelRequestCheckpoint | ToolBatchCheckpoint;

export interface PendingInteraction {
  readonly invocation: StoredToolInvocation;
  readonly interaction: InteractionRequest;
  readonly continuation: VersionedData;
  readonly effects: ToolSideEffects;
}

interface AgentCheckpointBase {
  readonly schemaVersion: 1;
  readonly agentId: string;
  readonly threadId: string;
  readonly queryId: string;
  readonly lastRunId: string;
  readonly definition: { readonly id: string; readonly version: string };
  /** 恢复扩展状态之前必须检查已安装的实现版本。 */
  readonly plugins: readonly { readonly id: string; readonly version: string }[];
  readonly model: ModelSelection;
  readonly committed: {
    /** messages 所代表的权威历史的修订号。 */
    readonly historyRevision: number;
    readonly messages: readonly ModelMessage[];
    /** 最后一个完全提交的步；第一步之前为 0。inflight 是下一步。 */
    readonly step: number;
  };
  /** type 中的生产者名称唯一；扩展载荷绝不替换内核字段。 */
  readonly extensions: readonly VersionedData[];
}

/**
 * 仅持久化可序列化的协议值，绝不持久化服务、凭据或中止信号。
 * 调用 ID 将工具响应划分为 remaining/completed，且在等待时恰好有一个待处理调用；
 * 恢复时保留原始 ID 与工具版本。该快照与 SessionHistoryStore 并非隐式的跨存储事务。
 */
export type AgentCheckpoint = AgentCheckpointBase &
  (
    | { readonly status: "running"; readonly inflight?: InflightCheckpoint }
    | {
        readonly status: "waiting";
        readonly inflight: ToolBatchCheckpoint;
        /**
         * 只有该已存储的交互可以接受匹配的响应。其消费与离开等待状态的迁移
         * 必须在检查点 CAS 下提交；拒绝重复或过期的响应，而不是执行续传两次。
         */
        readonly pending: PendingInteraction;
      }
    | { readonly status: "completed" }
    | {
        /** 取消停止后续工作；既不回滚历史，也不回滚外部影响。 */
        readonly status: "cancelled";
        readonly inflight?: InflightCheckpoint;
      }
    | {
        readonly status: "failed";
        readonly error: ProtocolError;
        readonly inflight?: InflightCheckpoint;
      }
  );
