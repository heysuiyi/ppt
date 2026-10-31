import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentConfiguration } from "../src/main/agent-configuration";
import {
  MIMO_TOKEN_PLAN_CN_BASE_URL,
  MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
} from "../src/models/mimo-token-plan-cn-contract";
import {
  discoverAgentModelsSchema,
  type VendorConfiguration,
} from "../src/shared/agent-configuration";
import { DEFAULT_AGENT_STEP_LIMITS } from "../src/shared/agent-step-limits";

const sdk = vi.hoisted(() => ({
  openai: [] as unknown[],
  anthropic: [] as unknown[],
  fail: false,
  waitForModels: undefined as Promise<void> | undefined,
  started: undefined as (() => void) | undefined,
}));
const mimo = vi.hoisted(() => ({
  create: vi.fn(),
  listModels: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("../src/models/mimo-token-plan-cn", () => ({
  createMimoTokenPlanCN: mimo.create,
}));
vi.mock("openai", () => ({
  default: class OpenAI {
    constructor(options: unknown) {
      sdk.openai.push(options);
    }
    models = {
      list: async function* () {
        if (sdk.fail) throw new Error("request failed with secret-api-key");
        sdk.started?.();
        await sdk.waitForModels;
        yield { id: " model-b " };
        yield { id: "model-a" };
        yield { id: "model-a" };
        yield { id: " " };
      },
    };
  },
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    constructor(options: unknown) {
      sdk.anthropic.push(options);
    }
    models = {
      list: async function* () {
        yield { id: "claude-b", display_name: "Claude B" };
        yield { id: "claude-a" };
        yield { id: "claude-a", display_name: "Claude A" };
      },
    };
  },
}));
const directories: string[] = [];
beforeEach(() => {
  sdk.openai.length = 0;
  sdk.anthropic.length = 0;
  sdk.fail = false;
  sdk.waitForModels = undefined;
  sdk.started = undefined;
  mimo.create.mockReset().mockReturnValue({
    listModels: mimo.listModels,
    dispose: mimo.dispose,
  });
  mimo.listModels.mockReset().mockResolvedValue([
    { id: "mimo-v2-pro", supported: true },
    { id: "unknown-model", supported: false, unsupportedReason: "Unsupported model capabilities." },
  ]);
  mimo.dispose.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const vendor: VendorConfiguration = {
  id: "saved",
  kind: "custom",
  label: "Saved",
  protocol: "openai",
  baseURL: "https://saved.example.test/v1",
  enabled: true,
  models: [],
};
async function management(environment: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "agent-discovery-"));
  directories.push(root);
  const safeStorage = {
    decryptString: (value: Buffer) => value.toString(),
    decryptStringAsync: async (value: Buffer) => ({
      result: value.toString(),
      shouldReEncrypt: false,
    }),
    encryptString: (value: string) => Buffer.from(value),
    encryptStringAsync: async (value: string) => Buffer.from(value),
    getSelectedStorageBackend: () => "unknown" as const,
    isAsyncEncryptionAvailable: async () => true,
    isEncryptionAvailable: () => true,
  };
  const config = createAgentConfiguration({ applicationDataRoot: root, safeStorage, environment });
  await config.management.initialize({
    vendors: [vendor],
    gateway: { timeoutMs: 180_000, maxOutputTokens: 16_384 },
    stepLimits: DEFAULT_AGENT_STEP_LIMITS,
    executionStrategy: "REQUEST_APPROVAL",
    defaultTemplateId: "builtin/swiss-minimal",
  });
  return config.management;
}

describe("model discovery request boundary", () => {
  it("requires a draft key and disallows arbitrary routes or bindings on saved connections", () => {
    expect(() =>
      discoverAgentModelsSchema.parse({
        type: "draft",
        provider: "openai",
        baseURL: "https://example.test",
      }),
    ).toThrow();
    expect(() =>
      discoverAgentModelsSchema.parse({
        type: "saved-vendor",
        vendorId: "saved",
        baseURL: "https://attacker.example.test",
      }),
    ).toThrow();
    expect(() =>
      discoverAgentModelsSchema.parse({
        type: "saved-vendor",
        vendorId: "saved",
        credentialBinding: { vendorId: "saved" },
      }),
    ).toThrow();
    expect(() =>
      discoverAgentModelsSchema.parse({
        type: "draft",
        provider: "openai",
        baseURL: "http://remote.example.test",
        apiKey: "key",
      }),
    ).toThrow();
    expect(
      discoverAgentModelsSchema.parse({
        type: "draft",
        provider: "openai",
        baseURL: "http://127.0.0.1:1234/v1/",
        apiKey: " key ",
      }),
    ).toMatchObject({ baseURL: "http://127.0.0.1:1234/v1", apiKey: "key" });
  });
});

describe("configuration model discovery", () => {
  it("dispatches native drafts through the shared provider and preserves capability metadata", async () => {
    const api = await management();
    const before = await api.getSnapshot();
    await expect(
      api.listRemoteModels({
        type: "draft",
        provider: "openai",
        baseURL: MIMO_TOKEN_PLAN_CN_BASE_URL,
        modelAdapter: MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
        apiKey: "temporary-mimo-key",
      }),
    ).resolves.toEqual({
      models: [
        { id: "mimo-v2-pro", supported: true },
        {
          id: "unknown-model",
          supported: false,
          unsupportedReason: "Unsupported model capabilities.",
        },
      ],
    });
    expect(mimo.create).toHaveBeenCalledWith({
      apiKey: "temporary-mimo-key",
      connectionFingerprint: MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
      timeoutMs: 20_000,
      maxOutputTokens: 16_384,
    });
    expect(mimo.listModels).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(mimo.dispose).toHaveBeenCalledOnce();
    expect(sdk.openai).toEqual([]);
    expect(sdk.anthropic).toEqual([]);
    expect(await api.getSnapshot()).toEqual(before);
  });

  it("derives the native adapter from saved kind and never falls back to an environment key", async () => {
    const api = await management({
      OPENAI_API_KEY: "unrelated-openai-key",
      OPENAI_BASE_URL: MIMO_TOKEN_PLAN_CN_BASE_URL,
      MIMO_API_KEY: "unbound-mimo-key",
    });
    const native: VendorConfiguration = {
      ...vendor,
      kind: MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
      baseURL: MIMO_TOKEN_PLAN_CN_BASE_URL,
    };
    await api.saveVendor({ vendor: native, credential: { type: "keep" } });
    await expect(
      api.listRemoteModels({
        type: "saved-vendor",
        vendorId: native.id,
      }),
    ).rejects.toThrow(/credential/i);
    expect(mimo.create).not.toHaveBeenCalled();
    await api.saveVendor({
      vendor: native,
      credential: { type: "replace", apiKey: "saved-mimo-key" },
    });
    await api.listRemoteModels({ type: "saved-vendor", vendorId: native.id });
    expect(mimo.create).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "saved-mimo-key" }));
    expect(mimo.dispose).toHaveBeenCalledOnce();
    expect(sdk.openai).toEqual([]);
    expect((await api.getSnapshot())!.settings.vendors[0]!.models).toEqual([]);
  });

  it("disposes native discovery on failure without trying legacy transports or cached candidates", async () => {
    const api = await management();
    const failure = Object.assign(new Error("MiMo model discovery failed."), {
      code: "authentication",
    });
    mimo.listModels.mockRejectedValueOnce(failure);
    await expect(
      api.listRemoteModels({
        type: "draft",
        provider: "openai",
        baseURL: MIMO_TOKEN_PLAN_CN_BASE_URL,
        modelAdapter: MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
        apiKey: "temporary-mimo-key",
      }),
    ).rejects.toBe(failure);
    expect(mimo.dispose).toHaveBeenCalledOnce();
    expect(sdk.openai).toEqual([]);
    expect(sdk.anthropic).toEqual([]);
  });

  it("preserves an empty native discovery result and rejects mismatched draft routes before creation", async () => {
    const api = await management();
    const draft = {
      type: "draft" as const,
      provider: "openai" as const,
      baseURL: MIMO_TOKEN_PLAN_CN_BASE_URL,
      modelAdapter: MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
      apiKey: "temporary-mimo-key",
    };
    mimo.listModels.mockResolvedValueOnce([]);
    await expect(api.listRemoteModels(draft)).resolves.toEqual({ models: [] });
    expect(mimo.dispose).toHaveBeenCalledOnce();
    await expect(
      api.listRemoteModels({
        ...draft,
        baseURL: "https://api.xiaomimimo.com/v1",
      }),
    ).rejects.toThrow();
    expect(mimo.create).toHaveBeenCalledOnce();
    expect(sdk.openai).toEqual([]);
  });

  it("lists sorted, deduplicated OpenAI models using supplied draft credentials", async () => {
    const api = await management();
    await expect(
      api.listRemoteModels({
        type: "draft",
        provider: "openai",
        baseURL: "https://draft.example.test/v1/",
        apiKey: "draft-key",
      }),
    ).resolves.toEqual({ models: [{ id: "model-a" }, { id: "model-b" }] });
    expect(sdk.openai).toEqual([
      {
        apiKey: "draft-key",
        baseURL: "https://draft.example.test/v1",
        timeout: 20_000,
        maxRetries: 0,
      },
    ]);
  });

  it("lists Anthropic display names and fills duplicate metadata", async () => {
    const api = await management();
    await expect(
      api.listRemoteModels({
        type: "draft",
        provider: "anthropic",
        baseURL: "https://api.anthropic.com",
        apiKey: "draft-key",
      }),
    ).resolves.toEqual({
      models: [
        { id: "claude-a", displayName: "Claude A" },
        { id: "claude-b", displayName: "Claude B" },
      ],
    });
    expect(sdk.anthropic[0]).toMatchObject({
      apiKey: "draft-key",
      baseURL: "https://api.anthropic.com",
    });
  });

  it("derives a saved connection address and key exclusively from backend settings", async () => {
    const api = await management();
    await api.saveVendor({ vendor, credential: { type: "replace", apiKey: "saved-key" } });
    await api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id });
    expect(sdk.openai[0]).toMatchObject({ apiKey: "saved-key", baseURL: vendor.baseURL });
    await expect(
      api.listRemoteModels({
        type: "saved-vendor",
        vendorId: vendor.id,
        baseURL: "https://attacker.example.test",
      } as never),
    ).rejects.toThrow();
    expect(sdk.openai).toHaveLength(1);
  });

  it("refuses missing credentials and never sends an old key after connection edits", async () => {
    const api = await management();
    await expect(
      api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id }),
    ).rejects.toThrow(/credential/i);
    await api.saveVendor({ vendor, credential: { type: "replace", apiKey: "saved-key" } });
    await api.saveVendor({
      vendor: { ...vendor, baseURL: "https://changed.example.test/v1" },
      credential: { type: "keep" },
    });
    await expect(
      api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id }),
    ).rejects.toThrow(/credential/i);
    await expect(
      api.listRemoteModels({ type: "saved-vendor", vendorId: "missing" }),
    ).rejects.toThrow(/does not exist/);
    expect(sdk.openai).toEqual([]);
  });

  it("uses normalized environment-bound routes but never leaks a key to an unrelated vendor", async () => {
    const api = await management({
      OPENAI_API_KEY: "environment-key",
      OPENAI_BASE_URL: "https://saved.example.test/v1/",
    });
    await api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id });
    expect(sdk.openai[0]).toMatchObject({ apiKey: "environment-key", baseURL: vendor.baseURL });
    await api.saveVendor({
      vendor: { ...vendor, baseURL: "https://attacker.example.test/v1" },
      credential: { type: "keep" },
    });
    await expect(
      api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id }),
    ).rejects.toThrow(/credential/i);
    expect(sdk.openai).toHaveLength(1);
  });

  it("uses an environment destination only for its environment key, not a stored key", async () => {
    const api = await management({
      OPENAI_API_KEY: "environment-key",
      OPENAI_BASE_URL: "https://environment.example.test/v1/",
    });
    const unbound = { ...vendor, baseURL: "" };
    await api.saveVendor({ vendor: unbound, credential: { type: "keep" } });
    await api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id });
    expect(sdk.openai[0]).toMatchObject({
      apiKey: "environment-key",
      baseURL: "https://environment.example.test/v1",
    });
    await api.saveVendor({
      vendor: unbound,
      credential: { type: "replace", apiKey: "stored-key" },
    });
    await api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id });
    expect(sdk.openai[1]).toMatchObject({
      apiKey: "stored-key",
      baseURL: "https://api.openai.com/v1",
    });
  });

  it("does not expose provider exception text containing credentials", async () => {
    const api = await management();
    sdk.fail = true;
    await expect(
      api.listRemoteModels({
        type: "draft",
        provider: "openai",
        baseURL: "https://draft.example.test/v1",
        apiKey: "secret-api-key",
      }),
    ).rejects.toMatchObject({
      code: "provider-error",
      message: "Failed to list OpenAI-compatible models.",
    });
  });

  it("does not hold the configuration queue while a provider request is pending", async () => {
    const api = await management();
    await api.saveVendor({ vendor, credential: { type: "replace", apiKey: "saved-key" } });
    let releaseModels!: () => void;
    let markStarted!: () => void;
    sdk.waitForModels = new Promise<void>((resolve) => {
      releaseModels = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    sdk.started = markStarted;
    const discovering = api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id });
    await started;
    try {
      await api.saveVendor({
        vendor: { ...vendor, label: "Edited while listing" },
        credential: { type: "keep" },
      });
      expect((await api.getSnapshot())?.settings.vendors[0]?.label).toBe("Edited while listing");
    } finally {
      releaseModels();
      await discovering;
    }
  });
});
