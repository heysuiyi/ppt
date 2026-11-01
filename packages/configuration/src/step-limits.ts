import { z } from "zod";

export const agentStepLimitsSchema = z.object({
  /** When false, use internal safety caps only (no user-facing step limit). */
  enabled: z.boolean(),
  /** Max model rounds for the main agent per request. */
  mainMaxSteps: z.number().int().min(1).max(200),
  /** Max model rounds for each teammate assignment. */
  subMaxSteps: z.number().int().min(1).max(200),
});

export type AgentStepLimits = z.infer<typeof agentStepLimitsSchema>;

export const DEFAULT_AGENT_STEP_LIMITS: AgentStepLimits = {
  enabled: true,
  mainMaxSteps: 24,
  subMaxSteps: 16,
};

/** Safety caps when the user turns off the limit switch. */
export const AGENT_STEP_LIMITS_FALLBACK: Pick<AgentStepLimits, "mainMaxSteps" | "subMaxSteps"> = {
  mainMaxSteps: 100,
  subMaxSteps: 50,
};

export function resolveAgentStepLimits(input?: Partial<AgentStepLimits> | null): AgentStepLimits {
  return agentStepLimitsSchema.parse({ ...DEFAULT_AGENT_STEP_LIMITS, ...input });
}

export function getEffectiveMainMaxSteps(limits: AgentStepLimits): number {
  return limits.enabled ? limits.mainMaxSteps : AGENT_STEP_LIMITS_FALLBACK.mainMaxSteps;
}

export function getEffectiveSubMaxSteps(limits: AgentStepLimits): number {
  return limits.enabled ? limits.subMaxSteps : AGENT_STEP_LIMITS_FALLBACK.subMaxSteps;
}

export function buildMainStepLimitMessage(limits: AgentStepLimits): string {
  if (limits.enabled) {
    return (
      `本次请求的主 Agent 模型调用次数已超过上限（${limits.mainMaxSteps} 次）。` +
      "请在「设置 → 工作流」中调高上限或关闭限制后重试。"
    );
  }
  return "本次请求的处理步骤过多，请缩小修改范围后重试。";
}

export function buildSubStepLimitMessage(limits: AgentStepLimits): string {
  if (limits.enabled) {
    return (
      `子 Agent 模型调用次数已超过上限（${limits.subMaxSteps} 次）。` +
      "请在「设置 → 工作流」中调高子 Agent 上限。"
    );
  }
  return "子 Agent 处理步骤过多，未能完成委派任务。";
}
