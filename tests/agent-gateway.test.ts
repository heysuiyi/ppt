import { describe, expect, it } from "vitest";
import {
  AgentModelSettingsRegistry,
  DEFAULT_AGENT_TIMEOUT_MS,
  resolveAgentModelConfig,
  resolveFallbackModelSelection,
} from "../src/main/agent/gateway/config";
import { AgentGatewayError } from "../src/main/agent/gateway/errors";
import type { AgentModelSettings } from "../src/shared/agent";

function settingsRegistry(...primarySettings: AgentModelSettings[]): AgentModelSettingsRegistry {
  const registry = new AgentModelSettingsRegistry();
  for (const settings of primarySettings) registry.registerPrimary(settings);
  return registry;
}

const primary: AgentModelSettings = {
  configurationId: "primary-config",
  provider: "openai",
  model: "primary-model",
  apiKey: "primary-key",
  openaiApiMode: "responses",
};

describe("resolveAgentModelConfig", () => {
  it("resolves the explicitly registered primary without exposing its key in selection", () => {
    const config = resolveAgentModelConfig(
      { configurationId: "primary-config", provider: "openai", model: "primary-model" },
      settingsRegistry(primary),
    );
    expect(config).toMatchObject({
      configurationId: "primary-config",
      provider: "openai",
      model: "primary-model",
      apiKey: "primary-key",
      callPath: "responses",
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      maxOutputTokens: 16_384,
    });
  });

  it("uses the latest explicit primary when selection is omitted", () => {
    const registry = settingsRegistry(primary, {
      provider: "anthropic",
      model: "selected-model",
      apiKey: "anthropic-key",
      baseURL: "https://anthropic.example.test",
    });
    expect(
      resolveAgentModelConfig(undefined, registry, {
        timeoutMs: 15_000,
        maxOutputTokens: 4096,
      }),
    ).toMatchObject({
      provider: "anthropic",
      model: "selected-model",
      apiKey: "anthropic-key",
      baseURL: "https://anthropic.example.test",
      callPath: "anthropic",
      timeoutMs: 15_000,
      maxOutputTokens: 4096,
    });
  });

  it("requires explicit runtime configuration rather than inferring a model", () => {
    expect(() => resolveAgentModelConfig(undefined, settingsRegistry())).toThrow(
      "No runtime model configured",
    );
  });

  it("does not reuse runtime credentials for another explicit model", () => {
    expect(() =>
      resolveAgentModelConfig(
        { provider: "openai", model: "other-model" },
        settingsRegistry(primary),
      ),
    ).toThrow("No API key configured for openai");
  });

  it.each([
    ["chat-completions", "chat"],
    ["responses", "responses"],
  ] as const)("routes explicit OpenAI mode %s to %s", (openaiApiMode, callPath) => {
    const config = resolveAgentModelConfig(
      undefined,
      settingsRegistry({
        ...primary,
        baseURL: "https://compatible.example.test/v1",
        openaiApiMode,
      }),
    );
    expect(config.callPath).toBe(callPath);
    expect(config.baseURL).toBe("https://compatible.example.test/v1");
  });

  it("rejects an invalid runtime protocol mode", () => {
    expect(() =>
      resolveAgentModelConfig(
        undefined,
        settingsRegistry({
          ...primary,
          openaiApiMode: "legacy" as AgentModelSettings["openaiApiMode"],
        }),
      ),
    ).toThrow("Unsupported openaiApiMode");
  });

  it("replaces and clears fallback identities without removing primary identities", () => {
    const registry = settingsRegistry(primary);
    registry.registerFallback({
      configurationId: "old-fallback",
      provider: "openai",
      model: "old-model",
      apiKey: "old-key",
    });
    registry.registerFallback({
      configurationId: "new-fallback",
      provider: "openai",
      model: "new-model",
      apiKey: "new-key",
    });
    expect(() =>
      resolveAgentModelConfig(
        { configurationId: "old-fallback", provider: "openai", model: "old-model" },
        registry,
      ),
    ).toThrow("Unknown model configuration");
    expect(resolveAgentModelConfig(primary, registry).apiKey).toBe("primary-key");
    const fallback = {
      configurationId: "new-fallback",
      provider: "openai" as const,
      model: "new-model",
    };
    expect(resolveAgentModelConfig(fallback, registry).apiKey).toBe("new-key");
    registry.registerFallback(undefined);
    expect(() => resolveAgentModelConfig(fallback, registry)).toThrow(
      "Unknown model configuration",
    );
    expect(resolveAgentModelConfig(primary, registry).apiKey).toBe("primary-key");
  });

  it("clears all primary credential lookup paths", () => {
    const registry = settingsRegistry(primary);
    registry.clearPrimary();
    expect(() => resolveAgentModelConfig(undefined, registry)).toThrow(
      "No runtime model configured",
    );
    expect(() => resolveAgentModelConfig(primary, registry)).toThrow("Unknown model configuration");
  });

  it("resolves fallback selection only from gateway configuration without secrets", () => {
    expect(resolveFallbackModelSelection(primary)).toBeUndefined();
    expect(
      resolveFallbackModelSelection(primary, {
        timeoutMs: 180_000,
        maxOutputTokens: 16_384,
        fallbackModel: {
          configurationId: "fallback-config",
          vendorId: "fallback-vendor",
          provider: "anthropic",
          model: "fallback-model",
          apiKey: "secret",
          supports1MContext: true,
        },
      }),
    ).toEqual({
      configurationId: "fallback-config",
      vendorId: "fallback-vendor",
      provider: "anthropic",
      model: "fallback-model",
      supports1MContext: true,
    });
  });

  it("allows same-model fallback only when configuration identity differs", () => {
    const gatewayConfig = {
      timeoutMs: 180_000,
      maxOutputTokens: 16_384,
      fallbackModel: { ...primary, configurationId: "fallback-config", apiKey: "fallback-key" },
    };
    expect(resolveFallbackModelSelection(primary, gatewayConfig)).toEqual({
      configurationId: "fallback-config",
      provider: "openai",
      model: "primary-model",
    });
    expect(
      resolveFallbackModelSelection(gatewayConfig.fallbackModel, gatewayConfig),
    ).toBeUndefined();
    expect(
      resolveFallbackModelSelection(
        { provider: "openai", model: "primary-model" },
        { ...gatewayConfig, fallbackModel: { provider: "openai", model: "primary-model" } },
      ),
    ).toBeUndefined();
  });

  it("defers a missing fallback key failure until that fallback is queried", () => {
    const registry = settingsRegistry(primary);
    const fallback = { provider: "anthropic" as const, model: "fallback-model" };
    registry.registerFallback(fallback);
    expect(resolveAgentModelConfig(primary, registry).apiKey).toBe("primary-key");
    expect(() => resolveAgentModelConfig(fallback, registry)).toThrow(
      "No API key configured for anthropic",
    );
  });

  it("reports a clear configuration error when the selected model has no key", () => {
    try {
      resolveAgentModelConfig({ provider: "openai", model: "test-model" }, settingsRegistry());
      throw new Error("Expected configuration error");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentGatewayError);
      expect(error).toMatchObject({ code: "configuration", provider: "openai" });
      expect((error as Error).message).toContain("Settings");
    }
  });
});
