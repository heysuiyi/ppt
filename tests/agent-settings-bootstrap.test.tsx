// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_STEP_LIMITS } from "../src/shared/agent-step-limits";
import { APPLICATION_DEFAULT_TEMPLATE_ID } from "../src/shared/template-protocol";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

describe("Main settings bootstrap", () => {
  it("uses saved Main defaults even when browser defaults differ", async () => {
    const settings = {
      vendors: [],
      gateway: { timeoutMs: 120000, maxOutputTokens: 8000 },
      stepLimits: { ...DEFAULT_AGENT_STEP_LIMITS, mainMaxSteps: 7 },
      executionStrategy: "AUTO",
      defaultTemplateId: APPLICATION_DEFAULT_TEMPLATE_ID,
    };
    const migrate = vi.fn();
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentSettings: vi.fn(async () => settings),
        migrateAgentSettings: migrate,
      },
    });
    const { initializeAgentSettings, loadAppBootstrapSnapshot, UI_SETTINGS_STORAGE_KEY } =
      await import("../src/renderer/src/app/appBootstrap");
    localStorage.setItem(
      UI_SETTINGS_STORAGE_KEY,
      JSON.stringify({ executionStrategy: "REQUEST_APPROVAL", defaultTemplateId: "outdated" }),
    );
    await initializeAgentSettings();
    const snapshot = loadAppBootstrapSnapshot();
    expect(snapshot.persistedUiSettings.executionStrategy).toBe("AUTO");
    expect(snapshot.persistedUiSettings.defaultTemplateId).toBe(APPLICATION_DEFAULT_TEMPLATE_ID);
    expect(snapshot.agentStepLimits.mainMaxSteps).toBe(7);
    expect(migrate).not.toHaveBeenCalled();
  });

  it("moves legacy settings only after successful Main persistence", async () => {
    const { AGENT_STEP_LIMITS_STORAGE_KEY } = await import("../src/renderer/src/agentStepLimits");
    localStorage.setItem(
      AGENT_STEP_LIMITS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_AGENT_STEP_LIMITS, mainMaxSteps: 11 }),
    );
    const migrate = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementation(async (settings) => settings);
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentSettings: vi.fn(async () => undefined),
        migrateAgentSettings: migrate,
      },
    });
    const { initializeAgentSettings, loadAppBootstrapSnapshot } = await import(
      "../src/renderer/src/app/appBootstrap"
    );
    await expect(initializeAgentSettings()).rejects.toThrow("disk full");
    expect(localStorage.getItem(AGENT_STEP_LIMITS_STORAGE_KEY)).not.toBeNull();
    await initializeAgentSettings();
    expect(loadAppBootstrapSnapshot().agentStepLimits.mainMaxSteps).toBe(11);
    expect(localStorage.getItem(AGENT_STEP_LIMITS_STORAGE_KEY)).toBeNull();
    expect(migrate.mock.calls[1][0]).not.toHaveProperty("apiKey");
  });
});
