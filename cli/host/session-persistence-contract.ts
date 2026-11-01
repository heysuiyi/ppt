import type { ModelSelection } from "@agent-harness/core/model/model-contract";
import type { TerminalToolsMode } from "./host-contract.js";

/** 仅供宿主展示的投影；不承载规范历史、恢复状态或数据库能力。 */
export interface HostSessionSummary {
  readonly threadId: string;
  readonly model: ModelSelection;
  readonly connectionFingerprint: string;
  readonly toolMode: TerminalToolsMode;
  readonly history: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
  readonly unfinished?: {
    readonly queryId: string;
    readonly status: "running" | "waiting" | "interrupted";
  };
}
