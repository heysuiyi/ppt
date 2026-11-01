import type { RunIdentity } from "@agent-harness/core/protocol-values";
import type {
  TerminalComposerState,
  TerminalHistoryEntry,
  TerminalInteractionDisplay,
  TerminalInteractionReference,
  TerminalPhase,
  TerminalRecord,
  TerminalSelectionItem,
  TerminalTextPreview,
} from "./terminal-contract.js";

export type TerminalOutputMode = "tui" | "plain" | "print" | "jsonl";

export interface TerminalSelectorView {
  readonly title: string;
  readonly query: string;
  readonly items: readonly TerminalSelectionItem[];
  readonly selectedId: string | null;
  readonly navigation?: {
    readonly groups: readonly TerminalSelectionItem[];
    readonly selectedGroupId: string;
    readonly pane: "groups" | "models";
    readonly action?: TerminalSelectionItem;
  };
}

/** 当前输入归属与操作说明由控制器统一派生，呈现层不重建按键规则。 */
export interface TerminalInputView {
  readonly purpose:
    | "composer"
    | "completion"
    | "selector"
    | "model-selector"
    | "prompt"
    | "secret"
    | "interaction";
  readonly status: string;
  readonly hint: string;
}

export interface TerminalFeedback {
  readonly kind: "input" | "blocking" | "notice";
  readonly message: string;
}

export type TerminalScene = "startup" | "home" | "conversation";

/** 只保留公开文本及工具位置，不向呈现层传递参数或私有模型重放。 */
export type TerminalTimelinePart =
  | {
      readonly type: "text";
      readonly messageIndex: number;
      readonly contentIndex: number;
      readonly text: string;
    }
  | {
      readonly type: "reasoning";
      readonly messageIndex: number;
      readonly contentIndex: number;
      readonly text: string;
    }
  | { readonly type: "tool"; readonly callId: string };

export interface TerminalTurnSettlement {
  readonly records: readonly TerminalRecord[];
  readonly timeline: readonly TerminalTimelinePart[];
}

export interface TerminalView {
  readonly phase: TerminalPhase;
  readonly scene: TerminalScene;
  readonly input: TerminalInputView;
  readonly activity?: string;
  readonly composer: TerminalComposerState;
  readonly context?: {
    readonly workspace: string;
    readonly threadId: string;
    readonly model: string;
    readonly modelStatus?: string;
    readonly capabilities: string;
  };
  readonly selector?: TerminalSelectorView;
  /** 配置步骤借用当前模型面板，不把主草稿或秘密输入写入浏览器快照。 */
  readonly modelPanel?: { readonly browser: TerminalSelectorView };
  readonly completion?: TerminalSelectorView;
  readonly interaction?: {
    readonly reference: TerminalInteractionReference;
    readonly display: TerminalInteractionDisplay;
  };
  readonly prompt?: { readonly text: string; readonly secret: boolean };
  readonly feedback?: TerminalFeedback;
}

export interface TerminalRenderer {
  /** 绑定成功后一次交接上下文与目标历史；保留已有终端滚动历史。 */
  bindSession(view: TerminalView, history: readonly TerminalHistoryEntry[]): Promise<void>;
  beginRun(identity: RunIdentity): Promise<void>;
  settle(settlement: TerminalTurnSettlement): Promise<void>;
  record(record: TerminalRecord): Promise<void>;
  preview(previews: readonly TerminalTextPreview[]): Promise<void>;
  view(view: TerminalView): Promise<void>;
  user(text: string): Promise<void>;
  message(text: string): Promise<void>;
  toggleTool(): Promise<void>;
  toggleThinking(): Promise<void>;
  dismissDetail(): Promise<boolean>;
  tools(): readonly TerminalSelectionItem[];
  thoughts(): readonly TerminalSelectionItem[];
  selectThinking(id: string): Promise<void>;
  selectTool(id: string): Promise<void>;
  close(): Promise<void>;
}

export interface TerminalRendererOptions {
  readonly mode: TerminalOutputMode;
  readonly color: boolean;
  readonly columns: () => number;
  readonly rows: () => number;
  readonly writeOutput: (text: string) => Promise<void>;
  readonly writeError: (text: string) => Promise<void>;
  /** 定时合并预览的输出故障仍交由唯一控制器处理，不能在后台吞掉。 */
  readonly onOutputError: (error: unknown) => void;
}
