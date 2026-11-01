import type { ProtocolError, RunIdentity } from "@agent-harness/core/protocol-values";
import type { ToolSideEffects } from "@agent-harness/core/tools/tool-contract";

/** CLI 本地展示协议；不是 Core 事件、规范历史或可恢复快照。 */
interface TerminalRecordBase {
  readonly version: 1;
}

export interface TerminalModelItem {
  readonly id: string;
  readonly label: string;
  readonly vendor?: { readonly id: string; readonly label: string };
  readonly modelName?: string;
  /** 仅表示本地配置与凭据就绪，不代表已连接远程服务。 */
  readonly availability?: {
    readonly state: "ready" | "unavailable";
    readonly reason: string;
  };
}

export interface TerminalCapabilityItem {
  readonly id: string;
  readonly label: string;
}

export interface TerminalSessionRecord extends TerminalRecordBase {
  readonly type: "session";
  readonly threadId: string;
  readonly model?: TerminalModelItem;
  readonly capabilities?: readonly TerminalCapabilityItem[];
}

export type TerminalProgressRecord = TerminalRecordBase & {
  readonly type: "progress";
  readonly identity: RunIdentity;
} & (
    | { readonly phase: "run.started" | "run.completed" | "run.cancelled" | "run.interrupted" }
    | { readonly phase: "run.waiting"; readonly interactionId: string }
    | { readonly phase: "run.failed"; readonly error: ProtocolError }
    | { readonly phase: "step.started"; readonly step: number }
    | { readonly phase: "step.committed"; readonly step: number; readonly historyRevision: number }
  );

/** 恢复时观察 Run 与最初派发工具的 Run 可以不同，不能只按 callId 关联。 */
export interface TerminalToolReference {
  readonly invocationIdentity: RunIdentity;
  readonly callId: string;
  readonly name: string;
  readonly toolVersion: string | null;
}

export type TerminalToolRecord = TerminalRecordBase &
  TerminalToolReference & {
    readonly type: "tool";
    readonly identity: RunIdentity;
    readonly step: number;
  } & (
    | { readonly phase: "started" }
    | {
        readonly phase: "completed";
        readonly status: "succeeded";
        readonly effects: ToolSideEffects;
      }
    | {
        readonly phase: "completed";
        readonly status: "failed" | "unknown";
        readonly effects: ToolSideEffects;
        readonly error: ProtocolError;
      }
  );

export interface TerminalInteractionReference {
  readonly interactionId: string;
  readonly owner: string;
  readonly payloadType: string;
  readonly payloadVersion: number;
}

/** 文案和选项仅来自宿主认可的 owner/type/version 描述器，不包含原始 data。 */
export type TerminalInteractionDisplay =
  | { readonly support: "unsupported" }
  | {
      readonly support: "supported";
      readonly summary: string;
      readonly confirmation: "explicit-choice" | "interaction-id";
      readonly choices: readonly TerminalInteractionChoice[];
    };

export interface TerminalInteractionChoice {
  readonly id: string;
  readonly label: string;
  readonly responseType: "answer" | "reject";
}

export type TerminalInteractionRecord = TerminalRecordBase & {
  readonly type: "interaction";
  readonly identity: RunIdentity;
  readonly tool: TerminalToolReference;
} & (
    | (TerminalInteractionReference & {
        readonly phase: "requested";
        readonly display: TerminalInteractionDisplay;
      })
    | {
        /** resolved 事件不带原载荷描述，不从终端缓存猜 owner/type/version。 */
        readonly phase: "resolved";
        readonly interactionId: string;
        readonly responseType: "answer" | "reject" | "cancel";
      }
  );

export interface TerminalTextPart {
  /** 原助手 content 的位置；不能因过滤 reasoning/tool-call 而重新编号。 */
  readonly contentIndex: number;
  readonly text: string;
}

export interface TerminalAssistantMessageRecord extends TerminalRecordBase {
  readonly type: "assistant.message";
  readonly identity: RunIdentity;
  /** completed.output 内的位置；恢复时按 Query 与此位置结算，而非文本去重。 */
  readonly messageIndex: number;
  readonly content: readonly TerminalTextPart[];
}

export type TerminalQueryResultRecord = TerminalRecordBase & {
  readonly type: "query.result";
  readonly identity: RunIdentity;
} & (
    | { readonly status: "completed" | "cancelled" | "interrupted" }
    | {
        readonly status: "waiting";
        readonly interaction: TerminalInteractionReference;
        readonly display: TerminalInteractionDisplay;
      }
    | { readonly status: "failed"; readonly error: ProtocolError }
  );

export type TerminalFailureStage =
  | "configuration"
  | "activation"
  | "observation"
  | "completion"
  | "persistence"
  | "protocol"
  | "input"
  | "output"
  | "close";

export interface TerminalErrorRecord extends TerminalRecordBase {
  readonly type: "error";
  readonly identity?: RunIdentity;
  readonly stage: TerminalFailureStage;
  readonly error: ProtocolError;
  readonly outcomeUncertain: boolean;
}

export type TerminalQueryStatus = "completed" | "waiting" | "cancelled" | "interrupted" | "failed";

/** 高优先级故障先归并，不能由最后到达的事件覆盖；具体优先级见终端方案。 */
export type TerminalExitDecision =
  | { readonly exitCode: 0; readonly reason: "help" | "idle" | "completed" }
  | { readonly exitCode: 1; readonly reason: "failure"; readonly stage: TerminalFailureStage }
  | { readonly exitCode: 2; readonly reason: "arguments" }
  | { readonly exitCode: 3; readonly reason: "waiting" }
  | { readonly exitCode: 130; readonly reason: "user-cancelled" | "user-exit" }
  | { readonly exitCode: 143; readonly reason: "host-terminated" }
  | { readonly exitCode: 141; readonly reason: "broken-pipe" };

export type TerminalProcessFinishedRecord = TerminalRecordBase &
  TerminalExitDecision & {
    readonly type: "process.finished";
    readonly lastRun?: {
      readonly identity: RunIdentity;
      /** completed 拒绝时可以没有已知 status，不能伪造 failed。 */
      readonly status?: TerminalQueryStatus;
    };
  };

export type TerminalRecord =
  | TerminalSessionRecord
  | TerminalProgressRecord
  | TerminalToolRecord
  | TerminalInteractionRecord
  | TerminalAssistantMessageRecord
  | TerminalQueryResultRecord
  | TerminalErrorRecord
  | TerminalProcessFinishedRecord;

/** 仅供 mutable viewport；不属于 TerminalRecord，不进入 JSONL 或展示历史。 */
export type TerminalTextPreview = {
  readonly identity: RunIdentity;
  readonly step: number;
  readonly requestId: string;
  readonly text: string;
  readonly truncated: boolean;
} & (
  | { readonly contentIndex: number; readonly previewId?: never }
  | { readonly previewId: string; readonly contentIndex?: never }
);

export interface TerminalToolDetail extends TerminalToolReference {
  readonly owner: string;
  readonly payloadType: string;
  readonly payloadVersion: number;
  readonly summary: string;
  readonly lines: readonly string[];
}

export type TerminalPhase =
  | "starting"
  | "idle"
  | "running"
  | "settling"
  | "waiting"
  | "submitting"
  | "cancelling"
  | "closing";

export interface TerminalDraft {
  readonly text: string;
  /** 字素索引而非 UTF-16 offset；换行也占一个索引。 */
  readonly cursor: number;
}

export interface TerminalComposerState {
  readonly draft: TerminalDraft;
  readonly editable: boolean;
  readonly submission:
    | { readonly enabled: true }
    | {
        readonly enabled: false;
        readonly reason: "not-ready" | "busy" | "interaction" | "closing";
      };
}

export type TerminalSelectorPurpose = "command" | "model" | "session" | "tool-output";

export interface TerminalSelectionItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface TerminalInputToken {
  /** 单输入 owner 在焦点切换、关闭时递增；旧世代的事件一律无效。 */
  readonly generation: number;
}

export type TerminalInputRequest = TerminalInputToken &
  (
    | {
        readonly purpose: "composer";
        readonly state: TerminalComposerState;
      }
    | {
        readonly purpose: "selector";
        readonly selector: TerminalSelectorPurpose;
        readonly items: readonly TerminalSelectionItem[];
        readonly query: string;
        readonly selectedId: string | null;
        readonly restoreDraft: TerminalDraft;
      }
    | { readonly purpose: "secret"; readonly prompt: string }
    | {
        /** 只有完成结果为 waiting、槽位已释放后才发布该请求。 */
        readonly purpose: "interaction";
        readonly identity: RunIdentity;
        readonly interaction: TerminalInteractionReference;
        readonly display: TerminalInteractionDisplay;
        readonly restoreDraft: TerminalDraft;
      }
  );

export type TerminalEditorAction =
  | { readonly action: "insert"; readonly text: string; readonly source: "keyboard" | "paste" }
  | {
      readonly action:
        | "submit"
        | "newline"
        | "backspace"
        | "delete"
        | "left"
        | "right"
        | "up"
        | "down"
        | "home"
        | "end"
        | "tab"
        | "escape"
        | "interrupt"
        | "eof"
        | "toggle-tool"
        | "select-model";
    };

export type TerminalInputAction = TerminalInputToken &
  (
    | ({ readonly purpose: "composer" } & TerminalEditorAction)
    | {
        readonly purpose: "selector";
        readonly action: "search";
        readonly text: string;
      }
    | {
        readonly purpose: "selector";
        readonly action: "previous" | "next" | "accept" | "escape" | "interrupt" | "eof";
      }
    | { readonly purpose: "secret"; readonly action: "submit"; readonly secret: string }
    | { readonly purpose: "secret"; readonly action: "escape" | "interrupt" | "eof" }
    | ({
        readonly purpose: "interaction";
        readonly identity: RunIdentity;
        readonly interaction: TerminalInteractionReference;
      } & (
        | {
            /** choiceId 由当前宿主描述器解释为 InteractionResponse，不接受任意 JSON。 */
            readonly action: "choose";
            readonly choiceId: string;
            readonly confirmationId?: string;
          }
        | { readonly action: "cancel-query" | "keep-waiting" | "escape" }
      ))
  );

export type TerminalLocalCommand =
  | "help"
  | "hotkeys"
  | "status"
  | "paste"
  | "exit"
  | "tools-output";
export type TerminalHostCommand = "new" | "model" | "connect" | "resume" | "tools";

export type TerminalCommandDefinition =
  | { readonly name: TerminalLocalCommand; readonly availability: "local" }
  | {
      readonly name: TerminalHostCommand;
      readonly availability: "host";
    }
  | {
      readonly name: "model" | "resume";
      readonly availability: "scenario";
      readonly scenarioId: string;
    };
