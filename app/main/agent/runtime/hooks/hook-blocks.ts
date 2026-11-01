import type { AgentRuntimeResult } from "../runtime-types";
import type { ToolApprovalHandler } from "../tools/permission-check";

export interface UserPromptSubmitBlock {
  event: "UserPromptSubmit";
  threadId: string;
  request: string;
  messageHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface PostToolUseBlock {
  event: "PostToolUse";
  toolName: string;
  args: unknown;
  scope: "main" | "subagent";
  /**
   * `returned` 仅表示 execute() 已正常返回，不代表结果校验或后续 Runtime
   * 处理成功。工具抛错前仍可能产生部分副作用，消费者不能根据 `threw`
   * 推断副作用已经回滚。
   */
  executionStatus?: "returned" | "threw";
  sideEffects?: "none" | "committed_or_unknown" | "uncertain";
  result?: unknown;
  error?: string;
  errorCode?: string;
  threadId?: string;
}

export interface StopBlock {
  event: "Stop";
  threadId?: string;
  scope: "main" | "subagent";
  result: AgentRuntimeResult | string;
  reason: "completed" | "waiting_user" | "step_limit" | "aborted" | "failed";
}

export type RuntimeHookContext = {
  threadId?: string;
  requestToolApproval?: ToolApprovalHandler;
  workspaceRoot?: string;
};
