import type { AgentRunHandle } from "@agent-harness/core/agent-contract";
import type {
  InteractionRequest,
  InteractionResponse,
  ProtocolError,
  RunIdentity,
} from "@agent-harness/core/protocol-values";

export type HostToolsMode = "none" | "read-only" | "read-write";

export interface HostModel {
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

/** 宿主白名单投影的有界纯文本，不包含工具原始结果或可恢复载荷。 */
export interface HostToolDisplay {
  readonly title: string;
  readonly input: readonly string[];
  readonly output: readonly string[];
  readonly summary?: readonly string[];
}

export interface HostToolOutcome {
  readonly display?: HostToolDisplay;
  readonly status?: "completed" | "failed" | "unknown";
  readonly effects?: "none" | "applied" | "unknown";
  readonly error?: ProtocolError;
}

/** 宿主的只读安全时间线；不是规范历史或恢复载荷。 */
export type HostHistoryEntry =
  | { readonly role: "user" | "assistant" | "reasoning"; readonly text: string }
  | {
      readonly role: "tool";
      readonly tool: HostToolOutcome & {
        readonly callId: string;
        readonly name: string;
        readonly identity?: RunIdentity;
        readonly step?: number;
        readonly result: "recorded" | "error" | "missing";
      };
    };

export interface HostContext {
  readonly dataRoot: string;
  readonly workspaceRoot: string;
  readonly threadId: string;
  readonly model: HostModel;
  readonly toolsMode: HostToolsMode;
}

export interface HostSession {
  readonly id: string;
  readonly label: string;
  readonly modelId: string | undefined;
  readonly toolsMode: HostToolsMode;
  readonly history: readonly HostHistoryEntry[];
  readonly unfinished?: {
    readonly queryId: string;
    readonly status: "running" | "waiting" | "interrupted";
  };
}

/** 只包含认可的交互描述，不包含原始 payload.data。 */
export type HostInteractionDisplay =
  | { readonly support: "unsupported" }
  | {
      readonly support: "supported";
      readonly summary: string;
      readonly confirmation: "explicit-choice" | "interaction-id";
      readonly choices: readonly HostInteractionChoice[];
    };

export interface HostInteractionChoice {
  readonly id: string;
  readonly label: string;
  readonly responseType: "answer" | "reject";
}

export interface HostOpenOptions {
  readonly modelId?: string;
  readonly threadId?: string;
  readonly toolsMode?: HostToolsMode;
  readonly signal?: AbortSignal;
}

export interface NodeHost {
  readonly context: HostContext;
  open(options: HostOpenOptions): Promise<void>;
  models(): Promise<readonly HostModel[]>;
  sessions(): Promise<readonly HostSession[]>;
  newSession(options?: {
    readonly modelId?: string;
    readonly toolsMode?: HostToolsMode;
  }): Promise<void>;
  selectSession(threadId: string): Promise<HostSession>;
  selectModel(modelId: string): Promise<void>;
  run(text: string): Promise<AgentRunHandle>;
  resume(queryId: string, response?: InteractionResponse): Promise<AgentRunHandle>;
  describeInteraction(request: InteractionRequest): HostInteractionDisplay;
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
