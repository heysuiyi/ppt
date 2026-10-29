// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STEP_LIMITS_STORAGE_KEY } from "../src/renderer/src/agentStepLimits";
import {
  initializeAgentSettings,
  loadAppBootstrapSnapshot,
  UI_SETTINGS_STORAGE_KEY,
} from "../src/renderer/src/app/appBootstrap";
import { CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY } from "../src/renderer/src/credentialMigration";
import { LEGACY_MODEL_STORAGE_KEY } from "../src/renderer/src/modelCatalog";
import type { AgentConfigurationSnapshot } from "../src/shared/agent-configuration";
import { resolveAgentGatewayPreferences } from "../src/shared/agent-gateway-config";
import { DEFAULT_AGENT_STEP_LIMITS } from "../src/shared/agent-step-limits";
import { APPLICATION_DEFAULT_TEMPLATE_ID } from "../src/shared/template-protocol";

function configuration(mainMaxSteps = 7): AgentConfigurationSnapshot {
  return {
    settings: {
      vendors: [],
      gateway: resolveAgentGatewayPreferences(),
      stepLimits: { ...DEFAULT_AGENT_STEP_LIMITS, mainMaxSteps },
      executionStrategy: "AUTO",
      defaultTemplateId: APPLICATION_DEFAULT_TEMPLATE_ID,
    },
    credentials: {
      storage: { state: "secure", backend: "unknown" },
      models: [],
      webSearchConfigured: true,
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("Main configuration bootstrap", () => {
  it("returns saved Main defaults and credentials instead of browser defaults", async () => {
    const saved = configuration();
    const initialize = vi.fn();
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentConfiguration: vi.fn(async () => saved),
        initializeAgentConfiguration: initialize,
      },
    });
    localStorage.setItem(
      UI_SETTINGS_STORAGE_KEY,
      JSON.stringify({ executionStrategy: "REQUEST_APPROVAL", defaultTemplateId: "outdated" }),
    );

    const bootstrap = await initializeAgentSettings();

    expect(bootstrap.persistedUiSettings.executionStrategy).toBe("AUTO");
    expect(bootstrap.persistedUiSettings.defaultTemplateId).toBe(APPLICATION_DEFAULT_TEMPLATE_ID);
    expect(bootstrap.agentStepLimits.mainMaxSteps).toBe(7);
    expect(bootstrap.credentials).toEqual(saved.credentials);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("initializes a fresh installation with secret-free browser defaults", async () => {
    const saved = configuration();
    const initialize = vi.fn(async () => saved);
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentConfiguration: vi.fn(async () => undefined),
        initializeAgentConfiguration: initialize,
      },
    });

    const bootstrap = await initializeAgentSettings();

    expect(initialize).toHaveBeenCalledWith({
      vendors: [],
      gateway: resolveAgentGatewayPreferences(),
      stepLimits: DEFAULT_AGENT_STEP_LIMITS,
      executionStrategy: "REQUEST_APPROVAL",
      defaultTemplateId: APPLICATION_DEFAULT_TEMPLATE_ID,
    });
    expect(bootstrap.credentials).toEqual(saved.credentials);
    expect(bootstrap.credentialReentryRequired).toBe(false);
  });

  it("keeps migration inputs and the warning until Main initialization succeeds", async () => {
    const legacyModels = JSON.stringify([
      {
        id: "legacy-model",
        name: "Legacy Model",
        provider: "openai",
        model: "gpt-5.5",
        baseURL: "https://api.openai.com/v1",
        apiKey: "legacy-secret",
      },
    ]);
    const legacyLimits = JSON.stringify({ ...DEFAULT_AGENT_STEP_LIMITS, mainMaxSteps: 11 });
    const legacyUi = JSON.stringify({ themeMode: "light", executionStrategy: "AUTO" });
    localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, legacyModels);
    localStorage.setItem(AGENT_STEP_LIMITS_STORAGE_KEY, legacyLimits);
    localStorage.setItem("agent-ppt.ui-settings.v1", legacyUi);
    const initialize = vi
      .fn()
      .mockImplementationOnce(async () => {
        expect(localStorage.getItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY)).toBe("1");
        throw new Error("disk full");
      })
      .mockImplementation(async (settings) => ({ ...configuration(), settings }));
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentConfiguration: vi.fn(async () => undefined),
        initializeAgentConfiguration: initialize,
      },
    });

    await expect(initializeAgentSettings()).rejects.toThrow("disk full");
    expect(localStorage.getItem(LEGACY_MODEL_STORAGE_KEY)).toBe(legacyModels);
    expect(localStorage.getItem(AGENT_STEP_LIMITS_STORAGE_KEY)).toBe(legacyLimits);
    expect(localStorage.getItem("agent-ppt.ui-settings.v1")).toBe(legacyUi);
    expect(localStorage.getItem(UI_SETTINGS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY)).toBe("1");

    const bootstrap = await initializeAgentSettings();

    expect(bootstrap.agentStepLimits.mainMaxSteps).toBe(11);
    expect(bootstrap.models).toHaveLength(1);
    expect(bootstrap.credentialReentryRequired).toBe(true);
    expect(bootstrap.credentials).toEqual(configuration().credentials);
    expect(localStorage.getItem(LEGACY_MODEL_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(AGENT_STEP_LIMITS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY)).toBeNull();
    expect(JSON.stringify(initialize.mock.calls[1][0])).not.toContain("legacy-secret");
    expect(initialize.mock.calls[1][0].vendors[0]).not.toHaveProperty("credentialConfigured");
    expect(initialize.mock.calls[1][0]).toEqual(initialize.mock.calls[0][0]);
  });

  it("uses each explicitly fetched snapshot without retaining Main state between bootstraps", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(configuration(7))
      .mockResolvedValueOnce(configuration(11));
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { getAgentConfiguration: get },
    });

    const first = await initializeAgentSettings();
    const second = await initializeAgentSettings();

    expect(first.agentStepLimits.mainMaxSteps).toBe(7);
    expect(second.agentStepLimits.mainMaxSteps).toBe(11);
    expect(loadAppBootstrapSnapshot().agentStepLimits).toEqual(DEFAULT_AGENT_STEP_LIMITS);
  });

  it("assembles a supplied Main snapshot without reading legacy agent settings", () => {
    localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, "invalid json");
    const saved = configuration();

    const bootstrap = loadAppBootstrapSnapshot(saved);

    expect(bootstrap.credentials).toEqual(saved.credentials);
    expect(bootstrap.agentStepLimits.mainMaxSteps).toBe(7);
    expect(bootstrap.credentialReentryRequired).toBe(false);
    expect(localStorage.getItem(LEGACY_MODEL_STORAGE_KEY)).toBe("invalid json");
  });
});
