// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_GATEWAY_CONFIG_STORAGE_KEY,
  LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY,
  loadAgentGatewayPreferences,
} from "../app/renderer/src/agentGatewayConfig";
import {
  initializeAgentSettings,
  loadAppBootstrapSnapshot,
} from "../app/renderer/src/app/appBootstrap";
import { CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY } from "../app/renderer/src/credentialMigration";
import {
  buildVendorDraftFromPreset,
  LEGACY_MODEL_STORAGE_KEY,
  LEGACY_MODEL_STORAGE_KEY_V2,
  MODEL_STORAGE_KEY,
  materializeVendorDraft,
} from "../app/renderer/src/modelCatalog";
import type { AgentConfigurationSnapshot } from "../src/shared/agent-configuration";
import { resolveAgentGatewayPreferences } from "../src/shared/agent-gateway-config";
import { DEFAULT_AGENT_STEP_LIMITS } from "../src/shared/agent-step-limits";
import { APPLICATION_DEFAULT_TEMPLATE_ID } from "../src/shared/template-protocol";

function legacyModel(name = "Legacy Model", apiKey = "legacy-secret") {
  return {
    id: "legacy-model",
    name,
    provider: "openai",
    model: "gpt-5.5",
    baseURL: "https://api.openai.com/v1",
    apiKey,
  };
}

function savedConfiguration(): AgentConfigurationSnapshot {
  return {
    settings: {
      vendors: [materializeVendorDraft(buildVendorDraftFromPreset("openai"))],
      gateway: resolveAgentGatewayPreferences(),
      stepLimits: DEFAULT_AGENT_STEP_LIMITS,
      executionStrategy: "AUTO",
      defaultTemplateId: APPLICATION_DEFAULT_TEMPLATE_ID,
    },
    credentials: {
      storage: { state: "secure", backend: "unknown" },
      models: [{ vendorId: "openai", configured: true }],
      webSearchConfigured: false,
    },
  };
}

describe("app bootstrap credential migration", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("reads legacy metadata without importing keys, rewriting sources, or consuming the warning", () => {
    const original = JSON.stringify([legacyModel()]);
    window.localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, original);

    const first = loadAppBootstrapSnapshot();
    const second = loadAppBootstrapSnapshot();

    expect(first.credentialReentryRequired).toBe(true);
    expect(second.credentialReentryRequired).toBe(true);
    expect(first.models).toHaveLength(1);
    expect(first.models[0]).not.toHaveProperty("apiKey");
    expect(window.localStorage.getItem(LEGACY_MODEL_STORAGE_KEY)).toBe(original);
    expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY)).toBe("1");
  });

  it("prefers current metadata while auditing every coexisting legacy source without deleting it", () => {
    const vendor = materializeVendorDraft(buildVendorDraftFromPreset("openai"));
    vendor.models = [{ ...vendor.models[0]!, name: "V3 Model" }];
    const sources = {
      [MODEL_STORAGE_KEY]: JSON.stringify({ version: 3, vendors: [vendor] }),
      [LEGACY_MODEL_STORAGE_KEY]: JSON.stringify([legacyModel("V1 Model", "v1-secret")]),
      [LEGACY_MODEL_STORAGE_KEY_V2]: JSON.stringify([legacyModel("V2 Model", "v2-secret")]),
      [AGENT_GATEWAY_CONFIG_STORAGE_KEY]: JSON.stringify({
        timeoutMs: 240_000,
        maxOutputTokens: 12_000,
        webSearchEndpoint: "https://v2-search.example.com",
      }),
      [LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY]: JSON.stringify({
        timeoutMs: 360_000,
        maxOutputTokens: 8_000,
        webSearchApiKey: "legacy-search-secret",
        webSearchEndpoint: "https://legacy-search.example.com",
      }),
    };
    for (const [key, value] of Object.entries(sources)) window.localStorage.setItem(key, value);

    const bootstrap = loadAppBootstrapSnapshot();

    expect(bootstrap.models).toHaveLength(1);
    expect(bootstrap.models[0]!.name).toBe("V3 Model");
    expect(bootstrap.agentGatewayPreferences).toMatchObject({
      timeoutMs: 240_000,
      maxOutputTokens: 12_000,
      webSearchEndpoint: "https://v2-search.example.com",
    });
    expect(bootstrap.credentialReentryRequired).toBe(true);
    for (const [key, value] of Object.entries(sources)) {
      expect(window.localStorage.getItem(key)).toBe(value);
    }
    expect(JSON.stringify(bootstrap)).not.toContain("secret");
  });

  it("strips obsolete gateway fields while retaining supported legacy preferences", () => {
    const original = JSON.stringify({
      timeoutMs: 240_000,
      maxOutputTokens: 12_000,
      webSearchEndpoint: "https://search.example.com",
      webSearchTimeoutMs: 30_000,
      webSearchApiKey: "search-secret",
      fallbackModel: { ...legacyModel(), apiKey: "fallback-secret" },
      fallbackModelId: "legacy-model",
      unknownLegacyField: true,
    });
    window.localStorage.setItem(LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY, original);

    const preferences = loadAgentGatewayPreferences();

    expect(preferences).toEqual({
      timeoutMs: 240_000,
      maxOutputTokens: 12_000,
      webSearchEndpoint: "https://search.example.com",
      webSearchTimeoutMs: 30_000,
      fallbackModelId: "legacy-model",
    });
    expect(window.localStorage.getItem(LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY)).toBe(original);
    expect(window.localStorage.getItem(AGENT_GATEWAY_CONFIG_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY)).toBe("1");
  });

  it("retains malformed gateway data for retry while returning safe defaults and a warning", () => {
    window.localStorage.setItem(LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY, "invalid json");

    expect(loadAgentGatewayPreferences()).toEqual(resolveAgentGatewayPreferences());
    expect(window.localStorage.getItem(LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY)).toBe(
      "invalid json",
    );
    expect(window.localStorage.getItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY)).toBe("1");
  });

  it("audits and cleans browser secrets even when Main already has a configuration", async () => {
    const saved = savedConfiguration();
    const initialize = vi.fn();
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getAgentConfiguration: vi.fn(async () => saved),
        initializeAgentConfiguration: initialize,
      },
    });
    const keys = [
      MODEL_STORAGE_KEY,
      LEGACY_MODEL_STORAGE_KEY,
      LEGACY_MODEL_STORAGE_KEY_V2,
      AGENT_GATEWAY_CONFIG_STORAGE_KEY,
      LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY,
    ];
    window.localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ version: 3, vendors: [] }));
    window.localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, JSON.stringify([legacyModel()]));
    window.localStorage.setItem(LEGACY_MODEL_STORAGE_KEY_V2, JSON.stringify([legacyModel()]));
    window.localStorage.setItem(
      AGENT_GATEWAY_CONFIG_STORAGE_KEY,
      JSON.stringify({ timeoutMs: 240_000 }),
    );
    window.localStorage.setItem(
      LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY,
      JSON.stringify({ webSearchApiKey: "legacy-search-secret" }),
    );

    const bootstrap = await initializeAgentSettings();

    expect(initialize).not.toHaveBeenCalled();
    expect(bootstrap.vendors).toEqual(saved.settings.vendors);
    expect(bootstrap.credentials).toEqual(saved.credentials);
    expect(bootstrap.agentGatewayPreferences).toEqual(saved.settings.gateway);
    expect(bootstrap.credentialReentryRequired).toBe(true);
    for (const key of keys) expect(window.localStorage.getItem(key)).toBeNull();
    expect(window.localStorage.getItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY)).toBeNull();

    const nextBootstrap = await initializeAgentSettings();
    expect(nextBootstrap.credentialReentryRequired).toBe(false);
  });
});
