import {
  type AgentStepLimits,
  DEFAULT_AGENT_STEP_LIMITS,
  resolveAgentStepLimits,
} from "@shared/agent-step-limits";

export const AGENT_STEP_LIMITS_STORAGE_KEY = "agent-ppt.step-limits";

export function loadAgentStepLimits(): AgentStepLimits {
  try {
    const stored = window.localStorage.getItem(AGENT_STEP_LIMITS_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_AGENT_STEP_LIMITS };
    return resolveAgentStepLimits(JSON.parse(stored) as Partial<AgentStepLimits>);
  } catch {
    return { ...DEFAULT_AGENT_STEP_LIMITS };
  }
}
