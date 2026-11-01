import type { ModelContentDelta, ModelTextContent } from "../model/model-contract.js";
import type {
  InteractionRequest,
  InteractionResponse,
  ProtocolError,
  RunIdentity,
} from "../protocol-values.js";
import type { ToolCompletion } from "../tools/tool-contract.js";
import type { StoredToolInvocation } from "./session-contract.js";

interface RuntimeEventIdentity {
  /** 发出该事件的运行标识，即使其恢复的是更早的工具调用。 */
  readonly identity: RunIdentity;
}

/**
 * 生命周期观察，而非 UI 指令或持久事件日志。单独一个 fact 并不承诺检查点已提交；
 * step.committed 明确标识持久历史。
 */
export type RuntimeFactEvent = RuntimeEventIdentity &
  (
    | {
        readonly kind: "fact";
        readonly type: "run.started" | "run.completed" | "run.cancelled" | "run.interrupted";
      }
    | {
        readonly kind: "fact";
        readonly type: "run.waiting";
        readonly interactionId: string;
      }
    | {
        readonly kind: "fact";
        readonly type: "run.failed";
        readonly error: ProtocolError;
      }
    | {
        readonly kind: "fact";
        readonly type: "step.started";
        readonly step: number;
      }
    | {
        readonly kind: "fact";
        readonly type: "step.committed";
        readonly step: number;
        readonly historyRevision: number;
      }
    | {
        readonly kind: "fact";
        readonly type: "tool.started";
        readonly step: number;
        readonly invocation: StoredToolInvocation;
      }
    | {
        readonly kind: "fact";
        readonly type: "tool.completed";
        readonly step: number;
        readonly invocation: StoredToolInvocation;
        /** completion 判别值区分成功、失败与未知结果。 */
        readonly completion: ToolCompletion;
      }
    | {
        readonly kind: "fact";
        readonly type: "interaction.requested";
        readonly invocation: StoredToolInvocation;
        readonly interaction: InteractionRequest;
      }
    | {
        readonly kind: "fact";
        readonly type: "interaction.resolved";
        readonly invocation: StoredToolInvocation;
        /** 针对已存储的等待交互被接受，而不仅仅是从客户端收到。 */
        readonly response: InteractionResponse;
      }
  );

/**
 * 临时模型输出，绝非规范历史或可恢复的执行快照。
 * 消费者可以丢弃增量；取消/失败可能留下不完整的流。
 */
export interface RuntimeStreamEvent extends RuntimeEventIdentity {
  readonly kind: "stream";
  readonly type: "model.delta";
  readonly step: number;
  readonly requestId: string;
  /** 在最终助手消息有序内容数组中的位置。 */
  readonly contentIndex: number;
  readonly delta: ModelContentDelta;
}

/** 不透明预览身份的临时正文；不猜测尚未确定的最终 contentIndex。 */
export interface RuntimeTextPreviewEvent extends RuntimeEventIdentity {
  readonly kind: "stream";
  readonly type: "model.preview";
  readonly step: number;
  readonly requestId: string;
  readonly previewId: string;
  readonly delta: ModelTextContent;
}

export type RuntimeEvent = RuntimeFactEvent | RuntimeStreamEvent | RuntimeTextPreviewEvent;
