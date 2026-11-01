import {
  AGENT_STEP_LIMITS_FALLBACK,
  buildMainStepLimitMessage,
  buildSubStepLimitMessage,
  DEFAULT_AGENT_STEP_LIMITS,
  getEffectiveMainMaxSteps,
  getEffectiveSubMaxSteps,
  resolveAgentStepLimits,
} from "@agent-harness/configuration/step-limits";
import { describe, expect, it } from "vitest";

describe("agent-step-limits", () => {
  it("uses defaults when input is empty", () => {
    expect(resolveAgentStepLimits()).toEqual(DEFAULT_AGENT_STEP_LIMITS);
  });

  it("merges partial overrides", () => {
    expect(resolveAgentStepLimits({ mainMaxSteps: 32 })).toMatchObject({
      enabled: true,
      mainMaxSteps: 32,
      subMaxSteps: 16,
    });
  });

  it("applies user caps when enabled", () => {
    const limits = resolveAgentStepLimits({ enabled: true, mainMaxSteps: 30, subMaxSteps: 12 });
    expect(getEffectiveMainMaxSteps(limits)).toBe(30);
    expect(getEffectiveSubMaxSteps(limits)).toBe(12);
  });

  it("uses fallback caps when disabled", () => {
    const limits = resolveAgentStepLimits({ enabled: false, mainMaxSteps: 30, subMaxSteps: 12 });
    expect(getEffectiveMainMaxSteps(limits)).toBe(AGENT_STEP_LIMITS_FALLBACK.mainMaxSteps);
    expect(getEffectiveSubMaxSteps(limits)).toBe(AGENT_STEP_LIMITS_FALLBACK.subMaxSteps);
  });

  it("builds user-facing limit messages", () => {
    const enabled = resolveAgentStepLimits({ enabled: true, mainMaxSteps: 24, subMaxSteps: 16 });
    expect(buildMainStepLimitMessage(enabled)).toContain("24");
    expect(buildMainStepLimitMessage(enabled)).toContain("设置");
    expect(buildSubStepLimitMessage(enabled)).toContain("16");

    const disabled = resolveAgentStepLimits({ enabled: false });
    expect(buildMainStepLimitMessage(disabled)).not.toContain("设置");
  });
});
