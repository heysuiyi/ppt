/**
 * Agent 循环的稳定扩展点。循环只调用 triggerHooks()，具体行为由注册表决定。
 */

export const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * 仅前置 Hook（UserPromptSubmit / PreToolUse）使用非 null 返回值中断流程。
 * PostToolUse / Stop 是观测型 Hook；调用方不得让其返回值改写已经发生的事实。
 */
export type HookStopResult = {
  type: "stop";
  reason: string;
  /** PreToolUse：跳过工具执行并将 reason 写入 transcript */
  toolDenied?: boolean;
};

export type HookCallback = (
  block: unknown,
) => HookStopResult | null | Promise<HookStopResult | null>;

const hooks: Record<HookEvent, HookCallback[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

export function registerHook(event: HookEvent, callback: HookCallback): void {
  hooks[event].push(callback);
}

export function clearHooks(event?: HookEvent): void {
  if (event) {
    hooks[event] = [];
    return;
  }
  for (const name of HOOK_EVENTS) {
    hooks[name] = [];
  }
}

export async function triggerHooks(
  event: HookEvent,
  block: unknown,
): Promise<HookStopResult | null> {
  for (const callback of hooks[event]) {
    const result = await callback(block);
    if (result !== null) {
      return result;
    }
  }
  return null;
}
