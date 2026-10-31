// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY } from "../src/renderer/src/credentialMigration";
import {
  buildCustomVendorDraft,
  buildVendorDraftFromPreset,
  changeModelVendorDraftProtocol,
  createCatalogEntriesFromRemoteIds,
  flattenVendors,
  LEGACY_MODEL_STORAGE_KEY,
  LEGACY_MODEL_STORAGE_KEY_V2,
  loadManagedVendors,
  MODEL_STORAGE_KEY,
  MODEL_VENDOR_PRESETS,
  materializeVendorDraft,
  normalizeModelTokenPricing,
} from "../src/renderer/src/modelCatalog";

function presetModel(kind: "openai" | "deepseek", index = 0) {
  return flattenVendors([materializeVendorDraft(buildVendorDraftFromPreset(kind))])[index]!;
}

describe("model catalog", () => {
  beforeEach(() => window.localStorage.clear());
  it("retains MiMo efforts and stable IDs in persisted drafts and flattened disabled models", () => {
    const draft = buildVendorDraftFromPreset("mimo-token-plan-cn");
    expect(draft.models).toEqual([]);
    expect(changeModelVendorDraftProtocol(draft, "anthropic")).toBe(draft);
    draft.models = [
      {
        id: "saved-mimo",
        name: "MiMo",
        model: "mimo-v2.6-pro",
        openaiApiMode: "responses",
        reasoningEffort: "ultra",
        enabled: false,
      },
    ];
    const vendor = materializeVendorDraft(draft);
    window.localStorage.setItem(
      MODEL_STORAGE_KEY,
      JSON.stringify({ version: 3, vendors: [vendor] }),
    );
    const loaded = loadManagedVendors();
    expect(loaded[0]?.models[0]).toMatchObject({
      id: "saved-mimo",
      reasoningEffort: "ultra",
      enabled: false,
    });
    expect(flattenVendors(loaded)[0]).toMatchObject({ reasoningEffort: "ultra", enabled: false });
    expect(
      buildVendorDraftFromPreset("mimo-token-plan-cn", loaded[0]).models[0]?.reasoningEffort,
    ).toBe("ultra");
  });

  it("defines official presets and DeepSeek Anthropic defaults", () => {
    expect(MODEL_VENDOR_PRESETS.map((preset) => preset.id)).toEqual([
      "mimo-token-plan-cn",
      "openai",
      "anthropic",
      "deepseek",
    ]);
    const draft = buildVendorDraftFromPreset("deepseek");
    expect(draft).toMatchObject({
      protocol: "anthropic",
      baseURL: "https://api.deepseek.com/anthropic",
      models: [
        expect.objectContaining({
          model: "deepseek-v4-flash",
          openaiApiMode: "responses",
          supports1MContext: true,
        }),
        expect.objectContaining({
          model: "deepseek-v4-pro",
          openaiApiMode: "chat-completions",
          supports1MContext: true,
        }),
      ],
    });
    expect(draft).not.toHaveProperty("apiKey");
  });

  it("switches DeepSeek to its OpenAI URL and model-specific API modes", () => {
    const switched = changeModelVendorDraftProtocol(
      buildVendorDraftFromPreset("deepseek"),
      "openai",
    );
    expect(switched.protocol).toBe("openai");
    expect(switched.baseURL).toBe("https://api.deepseek.com");
    expect(switched.models.map((model) => model.openaiApiMode)).toEqual([
      "responses",
      "chat-completions",
    ]);
  });

  it("reuses vendor metadata without guessing credential status", () => {
    const existing = materializeVendorDraft(buildVendorDraftFromPreset("deepseek"));
    existing.protocol = "openai";
    existing.baseURL = "https://proxy.example.com/v1";
    existing.models[0]!.name = "My Flash";
    existing.credentialConfigured = true;
    const draft = buildVendorDraftFromPreset("deepseek", existing);
    const saved = materializeVendorDraft(draft);
    expect(draft).toMatchObject({ protocol: "openai", baseURL: existing.baseURL, isNew: false });
    expect(draft.models[0]!.name).toBe("My Flash");
    expect(draft).not.toHaveProperty("apiKey");
    expect(saved).not.toHaveProperty("credentialConfigured");
    expect(flattenVendors([saved]).every((model) => model.credentialConfigured === undefined)).toBe(
      true,
    );
  });

  it("starts custom vendor drafts with an empty catalog", () => {
    expect(buildCustomVendorDraft()).toMatchObject({
      kind: "custom",
      protocol: "openai",
      models: [],
    });
  });

  it("creates remote catalog entries without connection or credential fields", () => {
    const entries = createCatalogEntriesFromRemoteIds(
      [{ id: " gpt-5.5 ", displayName: " GPT-5.5 " }, { id: "gpt-5-mini" }],
      "openai",
      () => "fixed-id",
    );
    expect(entries).toEqual([
      {
        id: "fixed-id",
        name: "GPT-5.5",
        model: "gpt-5.5",
        openaiApiMode: "chat-completions",
        supports1MContext: false,
        enabled: true,
        pricing: null,
      },
      {
        id: "fixed-id",
        name: "gpt-5-mini",
        model: "gpt-5-mini",
        openaiApiMode: "chat-completions",
        supports1MContext: false,
        enabled: true,
        pricing: null,
      },
    ]);
  });

  it("starts empty without writing vendor templates", () => {
    expect(loadManagedVendors()).toEqual([]);
    expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBeNull();
  });

  it("reads v2 models without rewriting or removing migration inputs", () => {
    const raw = JSON.stringify([{ ...presetModel("deepseek"), apiKey: "configured-key" }]);
    window.localStorage.setItem(LEGACY_MODEL_STORAGE_KEY_V2, raw);
    const vendors = loadManagedVendors();
    expect(vendors).toHaveLength(1);
    expect(vendors[0]).toMatchObject({
      id: "deepseek",
      kind: "deepseek",
      protocol: "anthropic",
      credentialConfigured: false,
    });
    expect(JSON.stringify(vendors)).not.toContain("configured-key");
    expect(window.localStorage.getItem(LEGACY_MODEL_STORAGE_KEY_V2)).toBe(raw);
    expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY)).toBe("1");
  });

  it.each([LEGACY_MODEL_STORAGE_KEY, LEGACY_MODEL_STORAGE_KEY_V2])(
    "keeps CN connections in %s custom until the native adapter is explicitly selected",
    (storageKey) => {
      const baseURL = "https://token-plan-cn.xiaomimimo.com/v1";
      const models = (["chat-completions", "responses"] as const).map((openaiApiMode) => ({
        id: `legacy-${openaiApiMode}`,
        name: openaiApiMode,
        provider: "openai",
        model: "mimo-v2.6-flash",
        baseURL,
        openaiApiMode,
        enabled: true,
      }));
      window.localStorage.setItem(storageKey, JSON.stringify(models));
      const vendors = loadManagedVendors();
      expect(
        vendors.map(({ kind, baseURL: url, models: entries }) => ({
          kind,
          baseURL: url,
          mode: entries[0]?.openaiApiMode,
          modelId: entries[0]?.id,
        })),
      ).toEqual(
        models.map((model) => ({
          kind: "custom",
          baseURL,
          mode: model.openaiApiMode,
          modelId: model.id,
        })),
      );
    },
  );

  it("drops unconfigured v1 presets but keeps configured metadata and original storage", () => {
    const raw = JSON.stringify([
      presetModel("openai"),
      { ...presetModel("deepseek"), apiKey: "configured-key" },
    ]);
    window.localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, raw);
    const models = flattenVendors(loadManagedVendors());
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "deepseek-v4-flash", credentialConfigured: false });
    expect(models[0]).not.toHaveProperty("apiKey");
    expect(window.localStorage.getItem(LEGACY_MODEL_STORAGE_KEY)).toBe(raw);
    expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBeNull();
  });

  it("audits coexisting legacy data while preferring v3 and discarding untrusted status and secrets", () => {
    const vendor = materializeVendorDraft(buildVendorDraftFromPreset("openai"));
    const raw = JSON.stringify({
      version: 3,
      vendors: [
        { ...vendor, credentialConfigured: true, apiKey: "v3-secret", unexpected: "ignored" },
      ],
    });
    window.localStorage.setItem(MODEL_STORAGE_KEY, raw);
    window.localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, "{malformed");
    window.localStorage.setItem(
      LEGACY_MODEL_STORAGE_KEY_V2,
      JSON.stringify([{ apiKey: "legacy-secret" }]),
    );
    const vendors = loadManagedVendors();
    expect(vendors[0]).toMatchObject({ id: "openai", credentialConfigured: false });
    expect(vendors[0]).not.toHaveProperty("apiKey");
    expect(vendors[0]).not.toHaveProperty("unexpected");
    expect(window.localStorage.getItem(MODEL_STORAGE_KEY)).toBe(raw);
    expect(window.localStorage.getItem(LEGACY_MODEL_STORAGE_KEY)).toBe("{malformed");
    expect(window.localStorage.getItem(LEGACY_MODEL_STORAGE_KEY_V2)).not.toBeNull();
    expect(window.localStorage.getItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY)).toBe("1");
  });

  it("retains malformed migration storage and requests credential reentry", () => {
    window.localStorage.setItem(LEGACY_MODEL_STORAGE_KEY, "{not-json");
    expect(loadManagedVendors()).toEqual([]);
    expect(window.localStorage.getItem(LEGACY_MODEL_STORAGE_KEY)).toBe("{not-json");
    expect(window.localStorage.getItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY)).toBe("1");
  });

  it("normalizes legacy USD prices and preserves explicit pricing or disabled pricing", () => {
    expect(
      normalizeModelTokenPricing({
        inputPerMillionUsd: 4,
        cachedInputPerMillionUsd: 0.4,
        outputPerMillionUsd: 20,
        updatedAt: "2026-07-01",
      }),
    ).toEqual({
      currency: "USD",
      inputPerMillion: 4,
      cachedInputPerMillion: 0.4,
      outputPerMillion: 20,
      updatedAt: "2026-07-01",
    });
    const pricing = {
      currency: "CNY",
      inputPerMillion: 8,
      cachedInputPerMillion: 1,
      outputPerMillion: 16,
      updatedAt: "2026-07-01",
    };
    window.localStorage.setItem(
      LEGACY_MODEL_STORAGE_KEY_V2,
      JSON.stringify([
        { ...presetModel("openai"), pricing },
        { ...presetModel("openai", 1), pricing: null },
        { ...presetModel("deepseek"), pricing: undefined },
      ]),
    );
    const models = flattenVendors(loadManagedVendors());
    expect(models[0]!.pricing).toEqual(pricing);
    expect(models[1]!.pricing).toBeNull();
    expect(models[2]!.pricing).toEqual(
      MODEL_VENDOR_PRESETS.find((preset) => preset.id === "deepseek")!.models[0]!.pricing,
    );
  });
});
