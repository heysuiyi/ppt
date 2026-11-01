import type {
  TerminalComposerState,
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
    readonly action: TerminalSelectionItem;
  };
}

export interface TerminalView {
  readonly phase: TerminalPhase;
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
  readonly interaction?: {
    readonly reference: TerminalInteractionReference;
    readonly display: TerminalInteractionDisplay;
  };
  readonly prompt?: { readonly text: string; readonly secret: boolean };
  readonly notification?: string;
}

export interface TerminalRenderer {
  record(record: TerminalRecord): Promise<void>;
  preview(previews: readonly TerminalTextPreview[]): Promise<void>;
  view(view: TerminalView): Promise<void>;
  user(text: string): Promise<void>;
  history(
    messages: readonly { readonly role: "user" | "assistant"; readonly text: string }[],
  ): Promise<void>;
  message(text: string): Promise<void>;
  toggleTool(): Promise<void>;
  tools(): readonly TerminalSelectionItem[];
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
}
