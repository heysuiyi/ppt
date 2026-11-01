import type { HookCallback } from "../hooks/hook-registry";
import {
  evaluateToolPermission,
  type PermissionDecision,
  type ToolPermissionBlock,
} from "./tool-access-policy";

export type ToolApprovalRequest = {
  toolName: string;
  args: unknown;
  reason: string;
  signal?: AbortSignal;
};

export type ToolApprovalHandler = (request: ToolApprovalRequest) => Promise<boolean>;

export type { PermissionDecision } from "./tool-access-policy";

export interface PreToolUseBlock extends ToolPermissionBlock {
  event: "PreToolUse";
  scope: "main" | "subagent";
  threadId?: string;
  requestToolApproval?: ToolApprovalHandler;
  signal?: AbortSignal;
}

/** 三道闸门顺序固定：硬拒绝 → 规则匹配 → 用户审批。 */
export function evaluatePermission(block: PreToolUseBlock): PermissionDecision {
  return evaluateToolPermission(block);
}

/**
 * Non-optional authorization boundary used directly by every executor.
 *
 * This is intentionally not registered in the mutable hook registry:
 * clearHooks() may remove extensions and test observers, but it cannot unload
 * permission enforcement.
 */
export async function authorizeToolUse(
  preBlock: PreToolUseBlock,
): Promise<Awaited<ReturnType<HookCallback>>> {
  const decision = evaluatePermission(preBlock);

  if (decision.type === "deny") {
    return { type: "stop", reason: decision.reason, toolDenied: true };
  }

  if (decision.type === "require_approval") {
    const handler = preBlock.requestToolApproval;
    if (!handler) {
      return {
        type: "stop",
        reason: `操作需要用户确认：${decision.reason}`,
        toolDenied: true,
      };
    }
    const approved = await handler({
      toolName: preBlock.toolName,
      args: preBlock.args,
      reason: decision.reason,
      signal: preBlock.signal,
    });
    if (!approved) {
      return { type: "stop", reason: "用户拒绝了该工具操作。", toolDenied: true };
    }
  }

  return null;
}

/** Compatibility adapter for consumers that intentionally compose a hook. */
export function createPermissionPreToolUseHook(): HookCallback {
  return async (block) => {
    return await authorizeToolUse(block as PreToolUseBlock);
  };
}
