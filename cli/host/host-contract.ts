import type { AgentRunHandle } from "@agent-harness/core/agent-contract";
import type { InteractionRequest, InteractionResponse } from "@agent-harness/core/protocol-values";
import type {
  TerminalInteractionDisplay,
  TerminalModelItem,
  TerminalSelectionItem,
} from "../terminal/terminal-contract.js";

export type TerminalToolsMode = "none" | "read-only" | "read-write";

export interface TerminalHostContext {
  readonly dataRoot: string;
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly model: TerminalModelItem;
  readonly toolsMode: TerminalToolsMode;
}

export interface TerminalHistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface TerminalHostSession extends TerminalSelectionItem {
  readonly modelId: string | undefined;
  readonly toolsMode: TerminalToolsMode;
  readonly history: readonly TerminalHistoryMessage[];
  readonly unfinished?: {
    readonly queryId: string;
    readonly status: "running" | "waiting" | "interrupted";
  };
}

/** 初始化交互借用终端唯一输入 owner；不向终端传递完整配置对象。 */
export interface TerminalSetupIO {
  select(title: string, items: readonly TerminalSelectionItem[]): Promise<string | undefined>;
  secret(prompt: string): Promise<string | undefined>;
  text(prompt: string): Promise<string | undefined>;
  notify(message: string): Promise<void>;
}

export interface TerminalHostOpenOptions {
  readonly modelId?: string;
  readonly threadId?: string;
  readonly toolsMode?: TerminalToolsMode;
  readonly setup?: TerminalSetupIO;
  readonly signal?: AbortSignal;
}

export interface TerminalHost {
  readonly context: TerminalHostContext;
  open(options: TerminalHostOpenOptions): Promise<void>;
  models(): Promise<readonly TerminalModelItem[]>;
  sessions(): Promise<readonly TerminalHostSession[]>;
  newSession(options?: {
    readonly modelId?: string;
    readonly toolsMode?: TerminalToolsMode;
  }): Promise<void>;
  selectSession(threadId: string): Promise<TerminalHostSession>;
  run(text: string): Promise<AgentRunHandle>;
  resume(queryId: string, response?: InteractionResponse): Promise<AgentRunHandle>;
  describeInteraction(request: InteractionRequest): TerminalInteractionDisplay;
  answerInteraction(
    request: InteractionRequest,
    choiceId: string,
    confirmationId?: string,
  ): InteractionResponse;
  close(): Promise<void>;
}

export interface NodeHostOptions {
  readonly dataRoot: string;
  readonly workspaceRoot: string;
}
