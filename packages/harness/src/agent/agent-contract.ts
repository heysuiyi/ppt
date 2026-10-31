import type { ModelMessage, ModelSelection, ModelUserMessage } from "./model/model-contract.js";
import type {
  Disposable,
  InteractionRequest,
  InteractionResponse,
  ProtocolError,
  RunIdentity,
} from "./protocol-values.js";
import type { CheckpointLease } from "./session/checkpoint-contract.js";
import type { RuntimeEvent } from "./session/session-events.js";

/** 稳定的执行定义标识；恢复执行时必须拒绝不兼容的定义。 */
export interface AgentDefinition {
  readonly id: string;
  readonly version: string;
  readonly instructions: string;
}

export interface AgentRunInput {
  readonly threadId: string;
  readonly queryId: string;
  readonly runId: string;
  readonly input: readonly ModelUserMessage[];
  readonly signal?: AbortSignal;
}

/** 运行时加载权威检查点；调用方无法替换其状态。 */
export interface AgentResumeInput {
  readonly threadId: string;
  readonly queryId: string;
  readonly runId: string;
  /** 仅对相应的已存储待处理交互有效；必须以原子方式消费它。 */
  readonly response?: InteractionResponse;
  readonly signal?: AbortSignal;
  /** 仅由确认旧写入方已停止的宿主提供，不接受前端提交的替换快照。 */
  readonly takeover?: CheckpointLease;
}

export type AgentRunResult =
  | {
      readonly status: "completed";
      readonly identity: RunIdentity;
      readonly output: readonly ModelMessage[];
    }
  | {
      readonly status: "waiting";
      readonly identity: RunIdentity;
      readonly interaction: InteractionRequest;
    }
  | { readonly status: "cancelled"; readonly identity: RunIdentity }
  | { readonly status: "interrupted"; readonly identity: RunIdentity }
  | {
      readonly status: "failed";
      readonly identity: RunIdentity;
      readonly error: ProtocolError;
    };

export interface AgentRunHandle {
  readonly identity: RunIdentity;
  /** 单一消费者；观察或放弃该流不会驱动或取消执行。 */
  readonly events: AsyncIterable<RuntimeEvent>;
  /**
   * 在执行与清理完成后落定；waiting 仅结束本次 Run，原 Query 仍可被新 Run 恢复。
   * 持久化失败时可能以拒绝结束，不能把“模型已返回”当作执行已提交。
   */
  readonly completed: Promise<AgentRunResult>;
  /** 停止新的调度并向活动任务发出中止信号；取消不会撤销外部影响。 */
  cancel(reason?: string): void;
}

/**
 * Agent 是绑定定义、模型与能力的长寿命实例，不是某一次业务 Task。
 * Thread 承载历史，Query 标识逻辑请求；Query/Step 的恢复事实由存储拥有，
 * Run 只负责一次激活，因此等待或重启后不需要保留原来的实例内调用栈。
 */
export interface Agent extends Disposable {
  readonly id: string;
  readonly definition: AgentDefinition;
  readonly model: ModelSelection;
  /** 拒绝该 Agent 的并发激活，而不是共享可变的执行状态。 */
  run(input: AgentRunInput): Promise<AgentRunHandle>;
  resume(input: AgentResumeInput): Promise<AgentRunHandle>;
}
