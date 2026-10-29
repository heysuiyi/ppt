import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentConfiguration,
  registerAgentConfigurationIpc,
} from "../src/main/agent-configuration";
import type { SafeStorageAdapter } from "../src/main/agent-configuration/internal/credential-store";
import type { VendorConfiguration } from "../src/shared/agent-configuration";
import type { AgentSettings } from "../src/shared/agent-settings";
import { DEFAULT_AGENT_STEP_LIMITS } from "../src/shared/agent-step-limits";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
function vendor(
  id = "primary",
  baseURL = "https://primary.example.test/v1",
  protocol: "openai" | "anthropic" = "openai",
): VendorConfiguration {
  return {
    id,
    kind: "custom",
    label: id,
    protocol,
    baseURL,
    enabled: true,
    models: [
      {
        id: `${id}-model`,
        name: id,
        model: `${id}-remote`,
        openaiApiMode: "responses",
        enabled: true,
      },
    ],
  };
}
function settings(vendors = [vendor()]): AgentSettings {
  return {
    vendors,
    gateway: { timeoutMs: 180_000, maxOutputTokens: 16_384 },
    stepLimits: DEFAULT_AGENT_STEP_LIMITS,
    executionStrategy: "REQUEST_APPROVAL",
    defaultTemplateId: "builtin/swiss-minimal",
  };
}
function preferences(input: AgentSettings) {
  const { vendors: _vendors, ...result } = input;
  return result;
}
async function configuration(
  environment: NodeJS.ProcessEnv = {},
  safeStorage = new FakeSafeStorage(),
) {
  const directory = await mkdtemp(join(tmpdir(), "agent-configuration-"));
  directories.push(directory);
  return {
    ...createAgentConfiguration({ applicationDataRoot: directory, safeStorage, environment }),
    directory,
    safeStorage,
  };
}

class FakeSafeStorage implements SafeStorageAdapter {
  available = true;
  decryptCalls = 0;
  failEncryption = false;
  decryptString(encrypted: Buffer) {
    this.decryptCalls++;
    return encrypted.toString("utf8");
  }
  async decryptStringAsync(encrypted: Buffer) {
    return { result: this.decryptString(encrypted), shouldReEncrypt: false };
  }
  encryptString(value: string) {
    if (this.failEncryption) throw new Error("sensitive adapter failure");
    return Buffer.from(value);
  }
  async encryptStringAsync(value: string) {
    return this.encryptString(value);
  }
  getSelectedStorageBackend() {
    return "unknown" as const;
  }
  async isAsyncEncryptionAvailable() {
    return this.available;
  }
  isEncryptionAvailable() {
    return this.available;
  }
}

describe("agent configuration management", () => {
  it("initializes once, preserves disk format, and supplies default preferences", async () => {
    const config = await configuration();
    await expect(config.management.getSnapshot()).resolves.toBeUndefined();
    const first = await config.management.initialize(settings());
    const second = await config.management.initialize(settings([vendor("other")]));
    expect(second.settings).toEqual(first.settings);
    expect(
      JSON.parse(await readFile(join(config.directory, "agent-settings.json"), "utf8")),
    ).toEqual(first.settings);
    const defaults = await configuration();
    expect((await defaults.management.initialize()).settings).toMatchObject({
      vendors: [],
      executionStrategy: "REQUEST_APPROVAL",
      stepLimits: DEFAULT_AGENT_STEP_LIMITS,
    });
  });

  it("coordinates vendor keys, snapshots, preferences, and deletion", async () => {
    const config = await configuration();
    await config.management.initialize(
      settings([vendor(), vendor("fallback", "https://fallback.example.test", "anthropic")]),
    );
    const saved = await config.management.saveVendor({
      vendor: vendor(),
      credential: { type: "replace", apiKey: "primary-secret" },
    });
    expect(saved.credentials.models[0]).toEqual({ vendorId: "primary", configured: true });
    expect(JSON.stringify(saved)).not.toContain("primary-secret");
    expect(JSON.stringify(saved)).not.toContain("ciphertext");
    await config.management.savePreferences({
      ...preferences(saved.settings),
      gateway: { ...saved.settings.gateway, fallbackModelId: "fallback-model" },
    });
    const deleted = await config.management.deleteVendor("fallback");
    expect(deleted.settings.gateway.fallbackModelId).toBeUndefined();
    const removed = await config.management.deleteVendor("primary");
    expect(removed.credentials.models).toEqual([]);
    expect(
      JSON.parse(await readFile(join(config.directory, "credentials.v2.json"), "utf8")).credentials,
    ).toEqual([]);
  });

  it("keeps a normalized connection key but removes it on address changes without rebinding", async () => {
    const config = await configuration();
    await config.management.initialize(settings());
    await config.management.saveVendor({
      vendor: vendor(),
      credential: { type: "replace", apiKey: "bound-secret" },
    });
    const normalized = await config.management.saveVendor({
      vendor: vendor("primary", "https://primary.example.test/v1/"),
      credential: { type: "keep" },
    });
    expect(normalized.credentials.models[0]?.configured).toBe(true);
    const changed = await config.management.saveVendor({
      vendor: vendor("primary", "https://attacker.example.test/v1"),
      credential: { type: "keep" },
    });
    expect(changed.credentials.models[0]?.configured).toBe(false);
    await config.management.saveVendor({ vendor: vendor(), credential: { type: "keep" } });
    const resolved = await config.runtime.resolveRuntime(
      await config.runtime.loadExecutionPlan("primary-model"),
    );
    expect(resolved.primary.apiKey).toBeUndefined();
  });

  it("validates the complete catalog before updating credentials", async () => {
    const config = await configuration();
    await config.management.initialize(settings());
    const conflicting = vendor("other");
    conflicting.models[0]!.id = "primary-model";
    await expect(
      config.management.saveVendor({
        vendor: conflicting,
        credential: { type: "replace", apiKey: "must-not-save" },
      }),
    ).rejects.toThrow();
    expect((await config.management.getSnapshot())?.settings.vendors).toHaveLength(1);
    await expect(
      readFile(join(config.directory, "credentials.v2.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not report success or update settings after encryption fails", async () => {
    const config = await configuration();
    await config.management.initialize(settings());
    config.safeStorage.failEncryption = true;
    await expect(
      config.management.saveVendor({
        vendor: vendor("new"),
        credential: { type: "replace", apiKey: "must-not-leak" },
      }),
    ).rejects.toMatchObject({
      code: "ENCRYPTION_FAILED",
      message: "The credential could not be encrypted.",
    });
    expect(
      (await config.management.getSnapshot())?.settings.vendors.map((entry) => entry.id),
    ).toEqual(["primary"]);
  });

  it("serializes whole management changes across factories sharing a root", async () => {
    const config = await configuration();
    await config.management.initialize(settings());
    const other = createAgentConfiguration({
      applicationDataRoot: config.directory,
      safeStorage: config.safeStorage,
      environment: {},
    });
    await Promise.all([
      config.management.saveVendor({
        vendor: vendor("second"),
        credential: { type: "replace", apiKey: "second-key" },
      }),
      other.management.saveVendor({
        vendor: vendor("third"),
        credential: { type: "replace", apiKey: "third-key" },
      }),
    ]);
    expect(
      (await config.management.getSnapshot())?.settings.vendors.map((entry) => entry.id),
    ).toEqual(["primary", "second", "third"]);
  });

  it("coordinates search endpoint edits and removes keys instead of rebinding", async () => {
    const config = await configuration();
    await config.management.initialize(settings());
    const saved = await config.management.updateSearchCredential({
      endpoint: "https://api.tavily.com/search/",
      credential: { type: "replace", apiKey: "search-secret" },
    });
    expect(saved.settings.gateway.webSearchEndpoint).toBe("https://api.tavily.com/search");
    expect(saved.credentials.webSearchConfigured).toBe(true);
    const changed = await config.management.updateSearchCredential({
      endpoint: "https://other.example.test/search",
      credential: { type: "keep" },
    });
    expect(changed.credentials.webSearchConfigured).toBe(false);
    await config.management.updateSearchCredential({
      endpoint: "https://api.tavily.com/search",
      credential: { type: "keep" },
    });
    expect((await config.management.getSnapshot())?.credentials.webSearchConfigured).toBe(false);
  });
});

describe("agent execution configuration", () => {
  it("hydrates primary, fallback and search only after a secret-free plan", async () => {
    const config = await configuration();
    const initial = settings([
      vendor(),
      vendor("fallback", "https://fallback.example.test", "anthropic"),
    ]);
    initial.gateway.fallbackModelId = "fallback-model";
    await config.management.initialize(initial);
    await config.management.saveVendor({
      vendor: initial.vendors[0]!,
      credential: { type: "replace", apiKey: "primary-secret" },
    });
    await config.management.saveVendor({
      vendor: initial.vendors[1]!,
      credential: { type: "replace", apiKey: "fallback-secret" },
    });
    await config.management.updateSearchCredential({
      endpoint: "https://api.tavily.com/search",
      credential: { type: "replace", apiKey: "search-secret" },
    });
    const plan = await config.runtime.loadExecutionPlan("primary-model");
    expect(config.safeStorage.decryptCalls).toBe(0);
    expect(JSON.stringify(plan)).not.toMatch(/secret|apiKey|ciphertext/);
    const runtime = await config.runtime.resolveRuntime(plan);
    expect(runtime.primary.apiKey).toBe("primary-secret");
    expect(runtime.gateway.fallbackModel?.apiKey).toBe("fallback-secret");
    expect(runtime.search.webSearchApiKey).toBe("search-secret");
  });

  it("rejects missing/disabled models without modifying the catalog", async () => {
    const config = await configuration();
    await expect(config.runtime.loadExecutionPlan("primary-model")).rejects.toThrow(/initialized/);
    const disabled = vendor();
    disabled.models[0]!.enabled = false;
    await config.management.initialize(settings([disabled]));
    await expect(config.runtime.loadExecutionPlan("missing")).rejects.toThrow(/does not exist/);
    await expect(config.runtime.loadExecutionPlan("primary-model")).rejects.toThrow(/disabled/);
  });

  it("keeps a single catalog and environment selection when preferences change after admission", async () => {
    const environment = {
      AGENT_FALLBACK_PROVIDER: "anthropic",
      AGENT_FALLBACK_MODEL: "env-fallback",
      ANTHROPIC_API_KEY: "env-key",
      ANTHROPIC_BASE_URL: "https://proxy.example.test",
    };
    const config = await configuration(environment);
    const initial = settings();
    await config.management.initialize(initial);
    const plan = await config.runtime.loadExecutionPlan("primary-model");
    await config.management.saveVendor({
      vendor: { ...vendor(), models: [{ ...vendor().models[0]!, model: "changed-remote" }] },
      credential: { type: "keep" },
    });
    await config.management.savePreferences({
      ...preferences(initial),
      gateway: { timeoutMs: 100, maxOutputTokens: 20 },
    });
    environment.AGENT_FALLBACK_MODEL = "changed-env";
    environment.ANTHROPIC_BASE_URL = "https://changed.example.test";
    const runtime = await config.runtime.resolveRuntime(plan);
    expect(runtime.primary.model).toBe("primary-remote");
    expect(runtime.gateway).toMatchObject({
      timeoutMs: 180_000,
      maxOutputTokens: 16_384,
      fallbackModel: {
        model: "env-fallback",
        baseURL: "https://proxy.example.test",
        apiKey: "env-key",
      },
    });
  });

  it("does not fail a primary run when optional credentials are missing or unavailable", async () => {
    const config = await configuration({
      AGENT_FALLBACK_PROVIDER: "anthropic",
      AGENT_FALLBACK_MODEL: "fallback",
    });
    await config.management.initialize(settings());
    config.safeStorage.available = false;
    const runtime = await config.runtime.resolveRuntime(
      await config.runtime.loadExecutionPlan("primary-model"),
    );
    expect(runtime.primary.apiKey).toBeUndefined();
    expect(runtime.gateway.fallbackModel).toMatchObject({ model: "fallback" });
    expect(runtime.gateway.fallbackModel?.apiKey).toBeUndefined();
    expect(runtime.search.webSearchApiKey).toBeUndefined();
  });

  it("ignores unused invalid environment routes when optional keys are absent", async () => {
    const config = await configuration({
      AGENT_FALLBACK_PROVIDER: "anthropic",
      AGENT_FALLBACK_MODEL: "fallback",
      ANTHROPIC_BASE_URL: "not-a-url",
      TAVILY_SEARCH_ENDPOINT: "not-a-url",
    });
    await config.management.initialize(settings());
    const runtime = await config.runtime.resolveRuntime(
      await config.runtime.loadExecutionPlan("primary-model"),
    );
    expect(runtime.gateway.fallbackModel).toMatchObject({
      model: "fallback",
      baseURL: "https://api.anthropic.com",
    });
    expect(runtime.gateway.fallbackModel?.apiKey).toBeUndefined();
    expect(runtime.search).toEqual({ webSearchEndpoint: "https://api.tavily.com/search" });
  });

  it("uses stored credentials and explicit mode/address ahead of all environment settings", async () => {
    const config = await configuration({
      OPENAI_API_KEY: "env-key",
      OPENAI_BASE_URL: "https://env.example.test/v1",
      OPENAI_API_MODE: "invalid",
      AGENT_TIMEOUT_MS: "-1",
      AGENT_MAX_OUTPUT_TOKENS: "invalid",
      TAVILY_API_KEY: "env-search",
      TAVILY_SEARCH_ENDPOINT: "https://env.example.test/search",
    });
    await config.management.initialize(settings([vendor("primary", "")]));
    await config.management.saveVendor({
      vendor: vendor("primary", ""),
      credential: { type: "replace", apiKey: "stored-key" },
    });
    await config.management.updateSearchCredential({
      endpoint: "https://api.tavily.com/search",
      credential: { type: "replace", apiKey: "stored-search" },
    });
    const runtime = await config.runtime.resolveRuntime(
      await config.runtime.loadExecutionPlan("primary-model"),
    );
    expect(runtime.primary).toMatchObject({
      apiKey: "stored-key",
      baseURL: "https://api.openai.com/v1",
      openaiApiMode: "responses",
    });
    expect(runtime.gateway).toMatchObject({ timeoutMs: 180_000, maxOutputTokens: 16_384 });
    expect(runtime.search).toMatchObject({
      webSearchApiKey: "stored-search",
      webSearchEndpoint: "https://api.tavily.com/search",
    });
  });

  it("uses environment URLs for unbound keys and preserves explicit catalog mode", async () => {
    const config = await configuration({
      OPENAI_API_KEY: "env-key",
      OPENAI_BASE_URL: "https://proxy.example.test/v1/",
      OPENAI_API_MODE: "chat-completions",
      TAVILY_API_KEY: "env-search",
      TAVILY_SEARCH_ENDPOINT: "https://proxy.example.test/search/",
    });
    await config.management.initialize(settings([vendor("primary", "")]));
    const snapshot = await config.management.getSnapshot();
    expect(snapshot?.credentials).toMatchObject({
      models: [{ configured: true }],
      webSearchConfigured: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("env-key");
    const runtime = await config.runtime.resolveRuntime(
      await config.runtime.loadExecutionPlan("primary-model"),
    );
    expect(runtime.primary).toMatchObject({
      apiKey: "env-key",
      baseURL: "https://proxy.example.test/v1",
      openaiApiMode: "responses",
    });
    expect(runtime.search).toMatchObject({
      webSearchApiKey: "env-search",
      webSearchEndpoint: "https://proxy.example.test/search",
    });
  });

  it("isolates environment keys to official or normalized environment-bound routes", async () => {
    const config = await configuration({
      OPENAI_API_KEY: "env-key",
      OPENAI_BASE_URL: "https://bound.example.test/v1/",
      TAVILY_API_KEY: "env-search",
      TAVILY_SEARCH_ENDPOINT: "https://bound.example.test/search/",
    });
    await config.management.initialize(
      settings([
        vendor(),
        vendor("official", "https://api.openai.com/v1/"),
        vendor("bound", "https://bound.example.test/v1"),
      ]),
    );
    const current = (await config.management.getSnapshot())!;
    await config.management.savePreferences({
      ...preferences(current.settings),
      gateway: {
        ...current.settings.gateway,
        webSearchEndpoint: "https://attacker.example.test/search",
      },
    });
    const snapshot = (await config.management.getSnapshot())!;
    expect(snapshot.credentials.models.map((entry) => entry.configured)).toEqual([
      false,
      true,
      true,
    ]);
    expect(snapshot.credentials.webSearchConfigured).toBe(false);
    const runtime = await config.runtime.resolveRuntime(
      await config.runtime.loadExecutionPlan("primary-model"),
    );
    expect(runtime.primary.apiKey).toBeUndefined();
    expect(runtime.search.webSearchApiKey).toBeUndefined();
  });

  it("resolves environment fallback mode and rejects invalid mode only when credentials can be used", async () => {
    const config = await configuration({
      AGENT_FALLBACK_PROVIDER: "openai",
      AGENT_FALLBACK_MODEL: "fallback",
      OPENAI_API_KEY: "env-key",
      OPENAI_API_MODE: "chat-completions",
    });
    await config.management.initialize(settings());
    const runtime = await config.runtime.resolveRuntime(
      await config.runtime.loadExecutionPlan("primary-model"),
    );
    expect(runtime.gateway.fallbackModel).toMatchObject({
      model: "fallback",
      apiKey: "env-key",
      openaiApiMode: "chat-completions",
    });
    const invalid = await configuration({
      AGENT_FALLBACK_PROVIDER: "openai",
      AGENT_FALLBACK_MODEL: "fallback",
      OPENAI_API_KEY: "env-key",
      OPENAI_API_MODE: "invalid",
    });
    await invalid.management.initialize(settings());
    await expect(
      invalid.runtime.resolveRuntime(await invalid.runtime.loadExecutionPlan("primary-model")),
    ).rejects.toThrow(/OPENAI_API_MODE/);
  });

  it("does not select itself as environment fallback and keeps disabled catalog fallback lazy", async () => {
    const config = await configuration({
      AGENT_FALLBACK_PROVIDER: "openai",
      AGENT_FALLBACK_MODEL: "primary-remote",
    });
    const initial = settings([vendor(), { ...vendor("fallback"), enabled: false }]);
    initial.gateway.fallbackModelId = "fallback-model";
    await config.management.initialize(initial);
    expect(
      (await config.runtime.loadExecutionPlan("primary-model")).services.fallbackModel,
    ).toBeUndefined();
  });
});

describe("configuration IPC trust boundary", () => {
  it("authorizes every channel before inspecting input or changing state", async () => {
    const config = await configuration();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const trusted = vi.fn(() => {
      throw new Error("untrusted");
    });
    registerAgentConfigurationIpc(
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler as (...args: unknown[]) => unknown);
        },
      },
      config.management,
      trusted,
    );
    expect(handlers.size).toBe(7);
    for (const handler of handlers.values())
      expect(() => handler({}, { secret: "not-a-request" })).toThrow("untrusted");
    expect(trusted).toHaveBeenCalledTimes(7);
    await expect(config.management.getSnapshot()).resolves.toBeUndefined();
  });

  it("rejects renderer-supplied bindings and extra addresses for saved discovery", async () => {
    const config = await configuration();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerAgentConfigurationIpc(
      {
        handle: (channel, handler) => {
          handlers.set(channel, handler as (...args: unknown[]) => unknown);
        },
      },
      config.management,
      () => {},
    );
    expect(() =>
      handlers.get("agent-configuration:list-remote-models")!(
        {},
        { type: "saved-vendor", vendorId: "primary", baseURL: "https://attacker.example.test" },
      ),
    ).toThrow();
    expect(() =>
      handlers.get("agent-configuration:save-vendor")!(
        {},
        { vendor: vendor(), credential: { type: "keep" }, credentialBinding: {} },
      ),
    ).toThrow();
  });
});
