import type { Readable, Writable } from "node:stream";
import type {
  TerminalDraft,
  TerminalEditorAction,
  TerminalSelectionItem,
} from "./terminal-contract.js";

export interface TerminalKeyEvent {
  readonly generation: number;
  readonly key: TerminalEditorAction;
}

export interface NodeTerminalOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly error: Writable;
  readonly enabled: boolean;
  readonly noColor: boolean;
  readonly onKey: (event: TerminalKeyEvent) => void;
  readonly onResize: () => void;
  readonly onEnd: () => void;
  readonly onError: (error: unknown) => void;
}

export interface NodeTerminal {
  readonly mode: "tui" | "plain" | "headless";
  readonly color: boolean;
  readonly secretAvailable: boolean;
  readonly columns: number;
  readonly rows: number;
  setGeneration(generation: number): void;
  start(): void;
  close(): Promise<void>;
}

export interface Composer {
  readonly draft: TerminalDraft;
  edit(action: TerminalEditorAction): void;
  setDraft(draft: TerminalDraft): void;
  clear(remember?: boolean): void;
  remember(): void;
}

export interface Selector {
  readonly query: string;
  readonly items: readonly TerminalSelectionItem[];
  readonly selectedId: string | null;
  search(text: string): void;
  move(direction: -1 | 1): void;
  accept(): string | undefined;
}
