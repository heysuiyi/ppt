import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAgentModelsSchema,
  type VendorConfiguration,
} from "@agent-harness/configuration/configuration-contract";
import { DEFAULT_AGENT_STEP_LIMITS } from "@agent-harness/configuration/step-limits";
import { getModelProfile } from "@agent-harness/models/model-profiles";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDesktopAgentConfiguration } from "../app/main/agent-configuration/desktop-configuration";
import { listProviderModels } from "../packages/configuration/dist/internal/model-discovery.js";

const profile = getModelProfile("mimo-token-plan-cn");
if (profile?.endpoint?.kind !== "fixed")
  throw new Error("MiMo discovery tests require the fixed endpoint profile.");
const mimoBaseURL = profile.endpoint.url;
const transport = globalThis.fetch;
const sdk = {
  openai: [] as Array<{ apiKey: string | undefined; url: string }>,
  anthropic: [] as Array<{ apiKey: string | undefined; url: string }>,
  native: [] as Array<{ apiKey: string | undefined; url: string }>,
  nativeModels: [] as Array<{ id: string }>,
  nativeFailure: false,
  fail: false,
  waitForModels: undefined as Promise<void> | undefined,
  started: undefined as (() => void) | undefined,
};
let server: Server;
const directories: string[] = [];
beforeEach(async () => {
  sdk.openai.length = 0;
  sdk.anthropic.length = 0;
  sdk.native.length = 0;
  sdk.nativeModels = [{ id: "mimo-v2.6-pro" }, { id: "unknown-model" }];
  sdk.nativeFailure = false;
  sdk.fail = false;
  sdk.waitForModels = undefined;
  sdk.started = undefined;
  server = createServer(async (request, response) => {
    const native = request.headers["x-test-native"] === "true";
    const anthropic = request.headers["x-test-anthropic"] === "true";
    response.setHeader("content-type", "application/json");
    if (sdk.fail || (native && sdk.nativeFailure)) {
      response.statusCode = native ? 401 : 500;
      response.end(JSON.stringify({ error: { message: "request failed with secret-api-key" } }));
      return;
    }
    sdk.started?.();
    await sdk.waitForModels;
    response.end(
      JSON.stringify({
        data: native
          ? sdk.nativeModels
          : anthropic
            ? [
                { id: "claude-b", display_name: "Claude B" },
                { id: "claude-a" },
                { id: "claude-a", display_name: "Claude A" },
              ]
            : [{ id: " model-b " }, { id: "model-a" }, { id: "model-a" }, { id: " " }],
        has_more: false,
      }),
    );
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local discovery address.");
  const endpoint = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      ![
        new URL(mimoBaseURL).host,
        "saved.example.test",
        "draft.example.test",
        "environment.example.test",
        "api.openai.com",
        "api.anthropic.com",
      ].includes(url.host) ||
      !url.pathname.endsWith("/models")
    )
      throw new Error(`Unexpected discovery destination: ${url.href}`);
    const native = url.href === `${mimoBaseURL}/models`;
    const anthropic = url.host === "api.anthropic.com";
    const calls = native ? sdk.native : anthropic ? sdk.anthropic : sdk.openai;
    calls.push({
      apiKey: anthropic
        ? (request.headers.get("x-api-key") ?? undefined)
        : request.headers.get("authorization")?.replace(/^Bearer /, ""),
      url: url.href,
    });
    const headers = new Headers(request.headers);
    headers.set("x-test-native", String(native));
    headers.set("x-test-anthropic", String(anthropic));
    return transport(new Request(endpoint + url.pathname + url.search, request), { headers });
  };
});
afterEach(async () => {
  globalThis.fetch = transport;
  const closed = Promise.withResolvers<void>();
  server.close((error) => (error ? closed.reject(error) : closed.resolve()));
  await closed.promise;
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
  const config = createDesktopAgentConfiguration({
    applicationDataRoot: root,
    safeStorage,
    environment,
  });
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

describe("adapter discovery capability", () => {
  it("reports missing discovery as an explicit caller-visible error", async () => {
    await expect(listProviderModels({}, new AbortController().signal)).rejects.toMatchObject({
      code: "provider-error",
    });
  });
});

describe("configuration model discovery", () => {
  it.each(["legacy", "native"] as const)(
    "aborts in-flight %s discovery when its owning scope closes",
    async (adapter) => {
      const api = await management();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      sdk.started = started.resolve;
      sdk.waitForModels = release.promise;
      const controller = new AbortController();
      const discovery = api.listRemoteModels(
        {
          type: "draft",
          provider: "openai",
          baseURL: adapter === "native" ? mimoBaseURL : "https://draft.example.test/v1",
          ...(adapter === "native" ? { modelAdapter: "mimo-token-plan-cn" as const } : {}),
          apiKey: "cancelled-discovery-secret",
        },
        controller.signal,
      );
      // Attach the rejection handler before aborting to keep the test's rejected promise owned.
      const rejected = expect(discovery).rejects.toThrow();
      try {
        await started.promise;
        controller.abort();
        await rejected;
      } finally {
        release.resolve();
      }
      expect(sdk.openai.length + sdk.native.length).toBe(1);
      expect((await api.getSnapshot())!.credentials.models[0]!.configured).toBe(false);
    },
  );

  it("lists native models through the real SDK and preserves capability metadata", async () => {
    const api = await management();
    const before = await api.getSnapshot();
    await expect(
      api.listRemoteModels({
        type: "draft",
        provider: "openai",
        baseURL: mimoBaseURL,
        modelAdapter: "mimo-token-plan-cn",
        apiKey: "temporary-mimo-key",
      }),
    ).resolves.toEqual({
      models: [
        { id: "mimo-v2.6-pro", supported: true },
        {
          id: "unknown-model",
          supported: false,
          unsupportedReason: expect.any(String),
        },
      ],
    });
    expect(sdk.native).toEqual([{ apiKey: "temporary-mimo-key", url: `${mimoBaseURL}/models` }]);
    expect(sdk.openai).toEqual([]);
    expect(sdk.anthropic).toEqual([]);
    expect(await api.getSnapshot()).toEqual(before);
  });

  it("derives the native adapter from saved kind and never falls back to an environment key", async () => {
    const api = await management({
      OPENAI_API_KEY: "unrelated-openai-key",
      OPENAI_BASE_URL: mimoBaseURL,
      MIMO_API_KEY: "unbound-mimo-key",
    });
    const native: VendorConfiguration = {
      ...vendor,
      kind: "mimo-token-plan-cn",
      baseURL: mimoBaseURL,
    };
    await api.saveVendor({ vendor: native, credential: { type: "keep" } });
    await expect(
      api.listRemoteModels({
        type: "saved-vendor",
        vendorId: native.id,
      }),
    ).rejects.toThrow();
    expect(sdk.native).toEqual([]);
    await api.saveVendor({
      vendor: native,
      credential: { type: "replace", apiKey: "saved-mimo-key" },
    });
    await api.listRemoteModels({ type: "saved-vendor", vendorId: native.id });
    expect(sdk.native).toEqual([{ apiKey: "saved-mimo-key", url: `${mimoBaseURL}/models` }]);
    expect(sdk.openai).toEqual([]);
    expect((await api.getSnapshot())!.settings.vendors[0]!.models).toEqual([]);
  });

  it("reports safe native SDK errors without legacy fallback or business retries", async () => {
    const api = await management();
    sdk.nativeFailure = true;
    await expect(
      api.listRemoteModels({
        type: "draft",
        provider: "openai",
        baseURL: mimoBaseURL,
        modelAdapter: "mimo-token-plan-cn",
        apiKey: "temporary-mimo-key",
      }),
    ).rejects.toMatchObject({ code: "AUTHENTICATION", adapterId: "mimo-token-plan-cn" });
    expect(sdk.native).toHaveLength(1);
    expect(sdk.openai).toEqual([]);
    expect(sdk.anthropic).toEqual([]);
  });

  it("preserves an empty native discovery result and rejects mismatched draft routes before creation", async () => {
    const api = await management();
    const draft = {
      type: "draft" as const,
      provider: "openai" as const,
      baseURL: mimoBaseURL,
      modelAdapter: "mimo-token-plan-cn" as const,
      apiKey: "temporary-mimo-key",
    };
    sdk.nativeModels = [];
    await expect(api.listRemoteModels(draft)).resolves.toEqual({ models: [] });
    await expect(
      api.listRemoteModels({
        ...draft,
        baseURL: "https://api.xiaomimimo.com/v1",
      }),
    ).rejects.toThrow();
    expect(sdk.native).toHaveLength(1);
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
        url: "https://draft.example.test/v1/models",
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
    expect(sdk.anthropic[0].apiKey).toBe("draft-key");
    const destination = new URL(sdk.anthropic[0].url);
    expect(destination.origin).toBe("https://api.anthropic.com");
    expect(destination.pathname).toBe("/v1/models");
  });

  it("derives a saved connection address and key exclusively from backend settings", async () => {
    const api = await management();
    await api.saveVendor({ vendor, credential: { type: "replace", apiKey: "saved-key" } });
    await api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id });
    expect(sdk.openai[0]).toMatchObject({ apiKey: "saved-key", url: `${vendor.baseURL}/models` });
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
    ).rejects.toThrow();
    await api.saveVendor({ vendor, credential: { type: "replace", apiKey: "saved-key" } });
    await api.saveVendor({
      vendor: { ...vendor, baseURL: "https://changed.example.test/v1" },
      credential: { type: "keep" },
    });
    await expect(
      api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id }),
    ).rejects.toThrow();
    await expect(
      api.listRemoteModels({ type: "saved-vendor", vendorId: "missing" }),
    ).rejects.toThrow();
    expect(sdk.openai).toEqual([]);
  });

  it("uses normalized environment-bound routes but never leaks a key to an unrelated vendor", async () => {
    const api = await management({
      OPENAI_API_KEY: "environment-key",
      OPENAI_BASE_URL: "https://saved.example.test/v1/",
    });
    await api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id });
    expect(sdk.openai[0]).toMatchObject({
      apiKey: "environment-key",
      url: `${vendor.baseURL}/models`,
    });
    await api.saveVendor({
      vendor: { ...vendor, baseURL: "https://attacker.example.test/v1" },
      credential: { type: "keep" },
    });
    await expect(
      api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id }),
    ).rejects.toThrow();
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
      url: "https://environment.example.test/v1/models",
    });
    await api.saveVendor({
      vendor: unbound,
      credential: { type: "replace", apiKey: "stored-key" },
    });
    await api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id });
    expect(sdk.openai[1]).toMatchObject({
      apiKey: "stored-key",
      url: "https://api.openai.com/v1/models",
    });
  });

  it("does not expose provider exception text containing credentials", async () => {
    const api = await management();
    sdk.fail = true;
    let failure: unknown;
    try {
      await api.listRemoteModels({
        type: "draft",
        provider: "openai",
        baseURL: "https://draft.example.test/v1",
        apiKey: "secret-api-key",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "provider-error" });
    expect(JSON.stringify(failure)).not.toContain("secret-api-key");
  });

  it("does not hold the configuration queue while a provider request is pending", async () => {
    const api = await management();
    await api.saveVendor({ vendor, credential: { type: "replace", apiKey: "saved-key" } });
    const released = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    sdk.waitForModels = released.promise;
    sdk.started = started.resolve;
    const discovering = api.listRemoteModels({ type: "saved-vendor", vendorId: vendor.id });
    await started.promise;
    try {
      await api.saveVendor({
        vendor: { ...vendor, label: "Edited while listing" },
        credential: { type: "keep" },
      });
      expect((await api.getSnapshot())?.settings.vendors[0]?.label).toBe("Edited while listing");
    } finally {
      released.resolve();
      await discovering;
    }
  });
});
