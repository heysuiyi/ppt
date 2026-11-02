/** 桌面展示协议：不包含 Core 检查点、工具原始结果或模型连接凭据。 */
export type HarnessToolsMode = "none" | "read-only" | "read-write";
export interface HarnessIdentity {
  readonly agentId: string;
  readonly threadId: string;
  readonly queryId: string;
  readonly runId: string;
}
export interface HarnessError {
  readonly code: string;
  readonly message: string;
}
export interface HarnessToolDisplay {
  readonly title: string;
  readonly input: readonly string[];
  readonly output: readonly string[];
  readonly summary?: readonly string[];
}
export type HarnessReply<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: HarnessError };
export interface HarnessModel {
  readonly id: string;
  readonly label: string;
  readonly vendor?: { readonly id: string; readonly label: string };
  readonly modelName?: string;
  readonly availability?: { readonly state: "ready" | "unavailable"; readonly reason: string };
}
export interface HarnessWorkspace {
  readonly id: string;
  readonly path: string;
  readonly label: string;
}
export type HarnessHistoryEntry =
  | { readonly role: "user" | "assistant" | "reasoning"; readonly text: string }
  | {
      readonly role: "tool";
      readonly tool: {
        readonly callId: string;
        readonly name: string;
        readonly identity?: HarnessIdentity;
        readonly step?: number;
        readonly result: "recorded" | "error" | "missing";
        readonly display?: HarnessToolDisplay;
        readonly status?: "completed" | "failed" | "unknown";
        readonly effects?: "none" | "applied" | "unknown";
        readonly error?: HarnessError;
      };
    };
export interface HarnessSession {
  readonly id: string;
  readonly label: string;
  readonly modelId?: string;
  readonly toolsMode: HarnessToolsMode;
  readonly history: readonly HarnessHistoryEntry[];
  readonly unfinished?: {
    readonly queryId: string;
    readonly status: "running" | "waiting" | "interrupted";
  };
}
export interface HarnessApproval {
  readonly queryId: string;
  readonly interactionId: string;
  readonly supported: boolean;
  readonly summary: string;
  readonly choices: readonly { readonly id: string; readonly label: string }[];
}
export interface HarnessSnapshot {
  /** 每个窗口独立的宿主身份；事件不可跨此身份归并。 */
  readonly scopeId: string;
  readonly revision: number;
  readonly workspace: HarnessWorkspace | null;
  readonly recentWorkspaces: readonly HarnessWorkspace[];
  readonly models: readonly HarnessModel[];
  readonly defaultModelId: string | null;
  readonly sessions: readonly HarnessSession[];
  readonly selectedSessionId: string | null;
  readonly selectedModelId: string | null;
  readonly toolsMode: HarnessToolsMode;
  readonly status:
    | "idle"
    | "running"
    | "waiting"
    | "completed"
    | "cancelled"
    | "interrupted"
    | "failed";
  readonly activeRun: HarnessIdentity | null;
  readonly pendingApproval: HarnessApproval | null;
  readonly error: HarnessError | null;
}
export type HarnessDesktopEvent =
  | { readonly type: "snapshot"; readonly snapshot: HarnessSnapshot }
  | {
      readonly type: "tool.status";
      readonly scopeId: string;
      readonly identity: HarnessIdentity;
      readonly callId: string;
      readonly invocationIdentity?: HarnessIdentity;
      readonly step?: number;
      readonly name: string;
      readonly status: "dispatched" | "completed" | "failed" | "unknown";
      readonly display?: HarnessToolDisplay;
      readonly effects?: "none" | "applied" | "unknown";
      readonly error?: HarnessError;
    }
  | {
      readonly type: "text.delta";
      readonly scopeId: string;
      readonly identity: HarnessIdentity;
      readonly text: string;
      readonly reasoning: boolean;
    }
  | {
      readonly type: "run.settled";
      readonly scopeId: string;
      readonly identity: HarnessIdentity;
      readonly status: HarnessSnapshot["status"];
    };
export interface HarnessDesktopApi {
  snapshot(): Promise<HarnessReply<HarnessSnapshot>>;
  models(): Promise<HarnessReply<readonly HarnessModel[]>>;
  sessions(): Promise<HarnessReply<readonly HarnessSession[]>>;
  /** 只接受系统目录选择结果或宿主记录过的最近目录。取消选择返回当前快照。 */
  chooseWorkspace(): Promise<HarnessReply<HarnessSnapshot>>;
  selectWorkspace(workspaceId: string): Promise<HarnessReply<HarnessSnapshot>>;
  setDefaultModel(modelId?: string): Promise<HarnessReply<HarnessSnapshot>>;
  newSession(options: {
    readonly modelId: string;
    readonly toolsMode: HarnessToolsMode;
  }): Promise<HarnessReply<HarnessSnapshot>>;
  selectSession(sessionId: string): Promise<HarnessReply<HarnessSnapshot>>;
  run(request: {
    readonly sessionId: string;
    readonly text: string;
  }): Promise<HarnessReply<HarnessIdentity>>;
  /** 回答由宿主根据持久化待决请求生成；renderer 不提供执行状态或 payload。 */
  resume(request: {
    readonly sessionId: string;
    readonly queryId: string;
    readonly interactionId?: string;
    readonly choiceId?: "allow" | "reject";
  }): Promise<HarnessReply<HarnessIdentity>>;
  cancel(request: {
    readonly sessionId: string;
    readonly queryId: string;
    readonly runId?: string;
  }): Promise<HarnessReply<HarnessSnapshot>>;
  subscribe(listener: (event: HarnessDesktopEvent) => void): () => void;
}
