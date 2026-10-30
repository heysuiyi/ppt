import type { ModelMessage, ModelSelection } from "./model/model-contract";
import type {
  Disposable,
  InteractionRequest,
  InteractionResponse,
  ProtocolError,
  RunIdentity,
} from "./protocol-values";
import type { RuntimeEvent } from "./session/session-events";

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
  readonly input: readonly ModelMessage[];
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
  | {
      readonly status: "failed";
      readonly identity: RunIdentity;
      readonly error: ProtocolError;
    };

export interface AgentRunHandle {
  readonly identity: RunIdentity;
  /** 单一消费者；观察或放弃该流不会驱动或取消执行。 */
  readonly events: AsyncIterable<RuntimeEvent>;
  /** 在执行与清理完成后落定；持久化失败时可能以拒绝结束，而非宣称成功。 */
  readonly completed: Promise<AgentRunResult>;
  /** 停止新的调度并向活动任务发出中止信号；取消不会撤销外部影响。 */
  cancel(reason?: string): void;
}

export interface Agent extends Disposable {
  readonly id: string;
  readonly definition: AgentDefinition;
  readonly model: ModelSelection;
  /** 拒绝该 Agent 的并发激活，而不是共享可变的执行状态。 */
  run(input: AgentRunInput): Promise<AgentRunHandle>;
  resume(input: AgentResumeInput): Promise<AgentRunHandle>;
}
