import type { AgentModelSelection, AgentProvider } from "@shared/agent";
import type {
  ModelCatalogEntry,
  ModelTokenPricing,
  ModelVendorConnection,
  PresetVendorKind,
  VendorKind,
} from "@shared/model-catalog";
import { markCredentialReentryRequired } from "./credentialMigration";

export type {
  ModelCatalogEntry,
  ModelTokenPricing,
  ModelVendorConnection,
  PresetVendorKind,
  VendorKind,
} from "@shared/model-catalog";

/** Flattened display view for the chat picker and token usage. */
export interface ManagedModel {
  id: string;
  vendorId: string;
  vendorKind: VendorKind;
  vendorLabel: string;
  name: string;
  provider: AgentProvider;
  model: string;
  baseURL: string;
  openaiApiMode: "responses" | "chat-completions";
  supports1MContext?: boolean;
  enabled?: boolean;
  /** Runtime-only status from Main; never persisted in browser storage. */
  credentialConfigured?: boolean;
  pricing?: ModelTokenPricing | null;
}

export type ModelVendorId = VendorKind;
export type PresetModelVendorId = PresetVendorKind;

export interface ModelVendorPreset {
  id: PresetVendorKind;
  label: string;
  hint: string;
  defaultProvider: AgentProvider;
  supportedProviders: readonly AgentProvider[];
  baseURLs: Partial<Record<AgentProvider, string>>;
  defaultModelId: string;
  models: readonly Omit<ModelCatalogEntry, "enabled">[];
}

export interface ModelVendorDraft {
  id: string;
  kind: VendorKind;
  label: string;
  protocol: AgentProvider;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
  models: ModelCatalogEntry[];
  isNew: boolean;
}

export const MODEL_VENDOR_PRESETS: readonly ModelVendorPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    hint: "官方 Responses API",
    defaultProvider: "openai",
    supportedProviders: ["openai"],
    baseURLs: { openai: "https://api.openai.com/v1" },
    defaultModelId: "openai-gpt-5-5",
    models: [
      {
        id: "openai-gpt-5-5",
        name: "OpenAI GPT-5.5",
        model: "gpt-5.5",
        openaiApiMode: "responses",
        pricing: {
          currency: "USD",
          inputPerMillion: 5,
          cachedInputPerMillion: 0.5,
          outputPerMillion: 30,
          updatedAt: "2026-07-26",
        },
      },
      {
        id: "openai-gpt-5-mini",
        name: "OpenAI GPT-5 mini",
        model: "gpt-5-mini",
        openaiApiMode: "responses",
        pricing: {
          currency: "USD",
          inputPerMillion: 0.25,
          cachedInputPerMillion: 0.025,
          outputPerMillion: 2,
          updatedAt: "2026-07-26",
        },
      },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    hint: "官方 Messages API",
    defaultProvider: "anthropic",
    supportedProviders: ["anthropic"],
    baseURLs: { anthropic: "https://api.anthropic.com" },
    defaultModelId: "anthropic-sonnet-4-6",
    models: [
      {
        id: "anthropic-sonnet-4-6",
        name: "Anthropic Claude Sonnet 4.6",
        model: "claude-sonnet-4-6",
        openaiApiMode: "responses",
        pricing: {
          currency: "USD",
          inputPerMillion: 3,
          cachedInputPerMillion: 0.3,
          cacheCreationInputPerMillion: 3.75,
          outputPerMillion: 15,
          updatedAt: "2026-07-26",
        },
      },
      {
        id: "anthropic-opus-4-6",
        name: "Anthropic Claude Opus 4.6",
        model: "claude-opus-4-6",
        openaiApiMode: "responses",
        pricing: {
          currency: "USD",
          inputPerMillion: 5,
          cachedInputPerMillion: 0.5,
          cacheCreationInputPerMillion: 6.25,
          outputPerMillion: 25,
          updatedAt: "2026-07-26",
        },
      },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    hint: "V4 Flash 与 V4 Pro",
    defaultProvider: "anthropic",
    supportedProviders: ["anthropic", "openai"],
    baseURLs: {
      anthropic: "https://api.deepseek.com/anthropic",
      openai: "https://api.deepseek.com",
    },
    defaultModelId: "deepseek-v4-flash",
    models: [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        model: "deepseek-v4-flash",
        openaiApiMode: "responses",
        supports1MContext: true,
        pricing: {
          currency: "CNY",
          inputPerMillion: 1,
          cachedInputPerMillion: 0.02,
          outputPerMillion: 2,
          updatedAt: "2026-07-31",
        },
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        model: "deepseek-v4-pro",
        openaiApiMode: "chat-completions",
        supports1MContext: true,
        pricing: {
          currency: "CNY",
          inputPerMillion: 3,
          cachedInputPerMillion: 0.025,
          outputPerMillion: 6,
          updatedAt: "2026-07-31",
        },
      },
    ],
  },
] as const;

/** @deprecated Prefer MODEL_VENDOR_PRESETS; retained for tests that inspect preset model ids. */
export const MODEL_VENDOR_MODELS: ManagedModel[] = MODEL_VENDOR_PRESETS.flatMap((preset) =>
  preset.models.map((model) => ({
    id: model.id,
    vendorId: preset.id,
    vendorKind: preset.id,
    vendorLabel: preset.label,
    name: model.name,
    provider: preset.defaultProvider,
    model: model.model,
    baseURL: preset.baseURLs[preset.defaultProvider] ?? "",
    openaiApiMode: model.openaiApiMode,
    ...(model.supports1MContext === true ? { supports1MContext: true } : {}),
    enabled: true,
    pricing: model.pricing,
  })),
);

export const MODEL_STORAGE_KEY = "agent-ppt.models.v3";
export const LEGACY_MODEL_STORAGE_KEY_V2 = "agent-ppt.models.v2";
export const LEGACY_MODEL_STORAGE_KEY = "agent-ppt.models.v1";
export const SELECTED_MODEL_STORAGE_KEY = "agent-ppt.selected-model.v1";

function normalizedBaseURL(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

export function getModelVendorPreset(kind: VendorKind): ModelVendorPreset | undefined {
  return MODEL_VENDOR_PRESETS.find((preset) => preset.id === kind);
}

export function flattenVendors(vendors: readonly ModelVendorConnection[]): ManagedModel[] {
  return vendors.flatMap((vendor) =>
    vendor.models.map((entry) => ({
      id: entry.id,
      vendorId: vendor.id,
      vendorKind: vendor.kind,
      vendorLabel: vendor.label,
      name: entry.name,
      provider: vendor.protocol,
      model: entry.model,
      baseURL: vendor.baseURL,
      openaiApiMode: entry.openaiApiMode,
      ...(entry.supports1MContext === true ? { supports1MContext: true } : {}),
      enabled: vendor.enabled !== false && entry.enabled !== false,
      ...(vendor.credentialConfigured === undefined
        ? {}
        : { credentialConfigured: vendor.credentialConfigured }),
      pricing: entry.pricing,
    })),
  );
}

export function buildVendorDraftFromPreset(
  kind: PresetVendorKind,
  existing?: ModelVendorConnection,
): ModelVendorDraft {
  const preset = getModelVendorPreset(kind)!;
  if (existing) {
    return {
      id: existing.id,
      kind: existing.kind,
      label: existing.label,
      protocol: existing.protocol,
      baseURL: existing.baseURL,
      apiKey: "",
      enabled: existing.enabled,
      models: existing.models.map((model) => ({ ...model })),
      isNew: false,
    };
  }
  return {
    id: kind,
    kind,
    label: preset.label,
    protocol: preset.defaultProvider,
    baseURL: preset.baseURLs[preset.defaultProvider] ?? "",
    apiKey: "",
    enabled: true,
    models: preset.models.map((model) => ({
      ...model,
      enabled: true,
      pricing: model.pricing ?? null,
    })),
    isNew: true,
  };
}

export function buildCustomVendorDraft(existing?: ModelVendorConnection): ModelVendorDraft {
  if (existing) {
    return {
      id: existing.id,
      kind: "custom",
      label: existing.label,
      protocol: existing.protocol,
      baseURL: existing.baseURL,
      apiKey: "",
      enabled: existing.enabled,
      models: existing.models.map((model) => ({ ...model })),
      isNew: false,
    };
  }
  const id = `custom-${crypto.randomUUID()}`;
  return {
    id,
    kind: "custom",
    label: "自定义兼容服务",
    protocol: "openai",
    baseURL: "",
    apiKey: "",
    enabled: true,
    models: [],
    isNew: true,
  };
}

export function buildModelVendorDraft(
  vendorId: ModelVendorId,
  existingModels: readonly ManagedModel[],
  customModelId = `custom-${crypto.randomUUID()}`,
): ModelVendorDraft {
  if (vendorId === "custom") {
    const draft = buildCustomVendorDraft();
    draft.models = [
      {
        id: customModelId,
        name: "自定义模型",
        model: "",
        openaiApiMode: "chat-completions",
        supports1MContext: false,
        enabled: true,
        pricing: null,
      },
    ];
    return draft;
  }
  const existingVendor = groupModelsIntoVendors(existingModels).find((v) => v.kind === vendorId);
  return buildVendorDraftFromPreset(vendorId, existingVendor);
}

export function changeModelVendorDraftProtocol(
  draft: ModelVendorDraft,
  protocol: AgentProvider,
): ModelVendorDraft {
  const preset = getModelVendorPreset(draft.kind);
  const baseURL = preset?.baseURLs[protocol] ?? draft.baseURL;
  return {
    ...draft,
    protocol,
    baseURL,
    models: draft.models.map((model) => {
      const defaultModel = preset?.models.find((candidate) => candidate.id === model.id);
      return {
        ...model,
        openaiApiMode:
          protocol === "openai"
            ? (defaultModel?.openaiApiMode ?? model.openaiApiMode)
            : model.openaiApiMode,
      };
    }),
  };
}

export function materializeVendorDraft(draft: ModelVendorDraft): ModelVendorConnection {
  const baseURL = draft.baseURL.trim().replace(/\/+$/, "");
  return {
    id: draft.id,
    kind: draft.kind,
    label: draft.label.trim() || (getModelVendorPreset(draft.kind)?.label ?? "自定义兼容服务"),
    protocol: draft.protocol,
    baseURL,
    enabled: draft.enabled !== false,
    models: draft.models.map((model) => ({
      ...model,
      name: model.name.trim() || model.model.trim(),
      model: model.model.trim(),
      enabled: model.enabled !== false,
      pricing: model.pricing
        ? {
            ...model.pricing,
            updatedAt: new Date().toISOString().slice(0, 10),
          }
        : model.pricing,
    })),
    credentialConfigured: true,
  };
}

/** @deprecated Use materializeVendorDraft */
export function materializeModelVendorDraft(draft: ModelVendorDraft): ManagedModel[] {
  return flattenVendors([materializeVendorDraft(draft)]);
}

export function createCatalogEntriesFromRemoteIds(
  remoteModels: ReadonlyArray<{ id: string; displayName?: string }>,
  protocol: AgentProvider,
  createId: () => string = () => `model-${crypto.randomUUID()}`,
): ModelCatalogEntry[] {
  return remoteModels.map((remote) => {
    const modelId = remote.id.trim();
    const displayName = remote.displayName?.trim() || modelId;
    return {
      id: createId(),
      name: displayName,
      model: modelId,
      openaiApiMode: protocol === "openai" ? "chat-completions" : "responses",
      supports1MContext: false,
      enabled: true,
      pricing: null,
    };
  });
}

/** @deprecated Use createCatalogEntriesFromRemoteIds */
export function createManagedModelsFromRemoteIds(
  remoteModels: ReadonlyArray<{ id: string; displayName?: string }>,
  draft: Pick<ModelVendorDraft, "protocol" | "baseURL">,
  createId: () => string = () => `custom-${crypto.randomUUID()}`,
): ManagedModel[] {
  const baseURL = draft.baseURL.trim().replace(/\/+$/, "");
  return createCatalogEntriesFromRemoteIds(remoteModels, draft.protocol, createId).map((entry) => ({
    id: entry.id,
    vendorId: "custom",
    vendorKind: "custom" as const,
    vendorLabel: "自定义兼容服务",
    name: entry.name,
    provider: draft.protocol,
    model: entry.model,
    baseURL,
    openaiApiMode: entry.openaiApiMode,
    supports1MContext: false,
    enabled: true,
    pricing: null,
  }));
}

interface LegacyUsdPricing {
  inputPerMillionUsd?: unknown;
  cachedInputPerMillionUsd?: unknown;
  cacheCreationInputPerMillionUsd?: unknown;
  outputPerMillionUsd?: unknown;
  updatedAt?: unknown;
}

function validPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function normalizeModelTokenPricing(value: unknown): ModelTokenPricing | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ModelTokenPricing> & LegacyUsdPricing;
  if (
    (candidate.currency === "CNY" || candidate.currency === "USD") &&
    validPrice(candidate.inputPerMillion) &&
    validPrice(candidate.cachedInputPerMillion) &&
    (candidate.cacheCreationInputPerMillion === undefined ||
      validPrice(candidate.cacheCreationInputPerMillion)) &&
    validPrice(candidate.outputPerMillion)
  ) {
    return {
      currency: candidate.currency,
      inputPerMillion: candidate.inputPerMillion,
      cachedInputPerMillion: candidate.cachedInputPerMillion,
      ...(candidate.cacheCreationInputPerMillion === undefined
        ? {}
        : {
            cacheCreationInputPerMillion: candidate.cacheCreationInputPerMillion,
          }),
      outputPerMillion: candidate.outputPerMillion,
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
    };
  }
  if (
    validPrice(candidate.inputPerMillionUsd) &&
    validPrice(candidate.cachedInputPerMillionUsd) &&
    (candidate.cacheCreationInputPerMillionUsd === undefined ||
      validPrice(candidate.cacheCreationInputPerMillionUsd)) &&
    validPrice(candidate.outputPerMillionUsd)
  ) {
    return {
      currency: "USD",
      inputPerMillion: candidate.inputPerMillionUsd,
      cachedInputPerMillion: candidate.cachedInputPerMillionUsd,
      ...(candidate.cacheCreationInputPerMillionUsd === undefined
        ? {}
        : {
            cacheCreationInputPerMillion: candidate.cacheCreationInputPerMillionUsd,
          }),
      outputPerMillion: candidate.outputPerMillionUsd,
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
    };
  }
  return undefined;
}

function inferVendorKind(
  provider: AgentProvider,
  baseURL: string,
  modelId: string,
): PresetVendorKind | "custom" {
  for (const preset of MODEL_VENDOR_PRESETS) {
    if (preset.models.some((model) => model.id === modelId)) return preset.id;
    for (const candidate of Object.values(preset.baseURLs)) {
      if (candidate && normalizedBaseURL(candidate) === normalizedBaseURL(baseURL)) {
        return preset.id;
      }
    }
  }
  void provider;
  return "custom";
}

function normalizeCatalogEntry(value: unknown): ModelCatalogEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<ModelCatalogEntry>;
  if (
    typeof item.id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.model !== "string"
  )
    return undefined;
  const storedPricing = normalizeModelTokenPricing(item.pricing);
  return {
    id: item.id,
    name: item.name,
    model: item.model,
    openaiApiMode: item.openaiApiMode === "responses" ? "responses" : "chat-completions",
    ...(item.supports1MContext === true ? { supports1MContext: true } : {}),
    enabled: item.enabled !== false,
    pricing: storedPricing === undefined ? null : storedPricing,
  };
}

function normalizeVendorConnection(value: unknown): ModelVendorConnection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<ModelVendorConnection>;
  if (
    typeof item.id !== "string" ||
    typeof item.label !== "string" ||
    (item.kind !== "openai" &&
      item.kind !== "anthropic" &&
      item.kind !== "deepseek" &&
      item.kind !== "custom") ||
    (item.protocol !== "openai" && item.protocol !== "anthropic") ||
    typeof item.baseURL !== "string" ||
    !Array.isArray(item.models)
  ) {
    return undefined;
  }
  const models = item.models.flatMap((entry) => {
    const normalized = normalizeCatalogEntry(entry);
    return normalized ? [normalized] : [];
  });
  return {
    id: item.id,
    kind: item.kind,
    label: item.label,
    protocol: item.protocol,
    baseURL: item.baseURL,
    enabled: item.enabled !== false,
    models,
    credentialConfigured: false,
  };
}

function normalizeStoredVendors(value: unknown): ModelVendorConnection[] {
  if (!value || typeof value !== "object") return [];
  const root = value as { version?: unknown; vendors?: unknown };
  if (root.version !== 3 || !Array.isArray(root.vendors)) return [];
  const vendors: ModelVendorConnection[] = [];
  const seenPresetKinds = new Set<PresetVendorKind>();
  for (const candidate of root.vendors) {
    const vendor = normalizeVendorConnection(candidate);
    if (!vendor) continue;
    if (vendor.kind !== "custom") {
      if (seenPresetKinds.has(vendor.kind)) continue;
      seenPresetKinds.add(vendor.kind);
    }
    vendors.push(vendor);
  }
  return vendors;
}

type LegacyFlatModel = {
  id: string;
  name: string;
  provider: AgentProvider;
  model: string;
  baseURL: string;
  openaiApiMode: "responses" | "chat-completions";
  supports1MContext?: boolean;
  enabled?: boolean;
  pricing?: ModelTokenPricing | null;
};

function normalizeLegacyFlatModels(value: unknown, legacyV1: boolean): LegacyFlatModel[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  let foundSecret = false;
  const models = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Partial<LegacyFlatModel> & { apiKey?: unknown };
    if (
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.model !== "string" ||
      (item.provider !== "openai" && item.provider !== "anthropic")
    )
      return [];
    const apiKey = typeof item.apiKey === "string" ? item.apiKey.trim() : "";
    if (apiKey) foundSecret = true;
    const bundled = MODEL_VENDOR_MODELS.find((model) => model.id === item.id);
    if (legacyV1 && bundled && !apiKey) return [];
    const storedPricing = normalizeModelTokenPricing(item.pricing);
    return [
      {
        id: item.id,
        name: item.name,
        provider: item.provider,
        model: item.model,
        baseURL: typeof item.baseURL === "string" ? item.baseURL : "",
        openaiApiMode: item.openaiApiMode === "responses" ? "responses" : "chat-completions",
        ...(item.supports1MContext === true ? { supports1MContext: true } : {}),
        enabled: item.enabled !== false,
        pricing: storedPricing === undefined ? (bundled?.pricing ?? null) : storedPricing,
      } satisfies LegacyFlatModel,
    ];
  });
  if (foundSecret) markCredentialReentryRequired();
  return models;
}

export function groupModelsIntoVendors(
  models: readonly LegacyFlatModel[] | readonly ManagedModel[],
): ModelVendorConnection[] {
  const vendorsByKey = new Map<string, ModelVendorConnection>();

  for (const model of models) {
    const vendorId =
      "vendorId" in model && typeof model.vendorId === "string"
        ? model.vendorId
        : (() => {
            const kind = inferVendorKind(model.provider, model.baseURL, model.id);
            return kind === "custom" ? `custom-${model.id}` : kind;
          })();
    const kind: VendorKind =
      "vendorKind" in model && model.vendorKind
        ? model.vendorKind
        : vendorId.startsWith("custom-")
          ? "custom"
          : (vendorId as PresetVendorKind);
    const label =
      "vendorLabel" in model && model.vendorLabel
        ? model.vendorLabel
        : (getModelVendorPreset(kind)?.label ?? "自定义兼容服务");

    let vendor = vendorsByKey.get(vendorId);
    if (!vendor) {
      vendor = {
        id: vendorId,
        kind,
        label,
        protocol: model.provider,
        baseURL: model.baseURL,
        enabled: true,
        models: [],
        credentialConfigured: false,
      };
      vendorsByKey.set(vendorId, vendor);
    }
    vendor.models.push({
      id: model.id,
      name: model.name,
      model: model.model,
      openaiApiMode: model.openaiApiMode,
      ...(model.supports1MContext === true ? { supports1MContext: true } : {}),
      enabled: model.enabled !== false,
      pricing: model.pricing ?? null,
    });
  }

  return [...vendorsByKey.values()];
}

function parseLegacyModelStorage(raw: string): unknown {
  const value = JSON.parse(raw) as unknown;
  if (
    Array.isArray(value) &&
    value.some((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const apiKey = (candidate as { apiKey?: unknown }).apiKey;
      return typeof apiKey === "string" && Boolean(apiKey.trim());
    })
  ) {
    markCredentialReentryRequired();
  }
  return value;
}

function auditLegacyModelStorage(raw: string): void {
  try {
    parseLegacyModelStorage(raw);
  } catch {
    markCredentialReentryRequired();
  }
}

export function serializeManagedVendors(vendors: readonly ModelVendorConnection[]): string {
  return JSON.stringify({
    version: 3,
    vendors: vendors.map((vendor) => ({
      id: vendor.id,
      kind: vendor.kind,
      label: vendor.label,
      protocol: vendor.protocol,
      baseURL: vendor.baseURL,
      enabled: vendor.enabled,
      models: vendor.models.map((model) => ({
        id: model.id,
        name: model.name,
        model: model.model,
        openaiApiMode: model.openaiApiMode,
        ...(model.supports1MContext === undefined
          ? {}
          : { supports1MContext: model.supports1MContext }),
        enabled: model.enabled,
        ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
      })),
    })),
  });
}

export function saveManagedVendors(vendors: readonly ModelVendorConnection[]): void {
  window.localStorage.setItem(MODEL_STORAGE_KEY, serializeManagedVendors(vendors));
}

/** Persist flattened models by regrouping into vendors (compat for callers still saving flats). */
export function saveManagedModels(models: readonly ManagedModel[]): void {
  saveManagedVendors(groupModelsIntoVendors(models));
}

export function serializeManagedModels(models: readonly ManagedModel[]): string {
  return serializeManagedVendors(groupModelsIntoVendors(models));
}

export function loadManagedVendors(): ModelVendorConnection[] {
  try {
    const storedV3 = window.localStorage.getItem(MODEL_STORAGE_KEY);
    const storedV2 = window.localStorage.getItem(LEGACY_MODEL_STORAGE_KEY_V2);
    const legacyV1 = window.localStorage.getItem(LEGACY_MODEL_STORAGE_KEY);

    if (legacyV1 !== null) {
      window.localStorage.removeItem(LEGACY_MODEL_STORAGE_KEY);
    }
    if (storedV2 !== null) {
      window.localStorage.removeItem(LEGACY_MODEL_STORAGE_KEY_V2);
    }

    if (storedV3 !== null) {
      if (legacyV1 !== null) auditLegacyModelStorage(legacyV1);
      if (storedV2 !== null) auditLegacyModelStorage(storedV2);
      const vendors = normalizeStoredVendors(JSON.parse(storedV3));
      saveManagedVendors(vendors);
      return vendors;
    }

    if (storedV2 !== null) {
      if (legacyV1 !== null) auditLegacyModelStorage(legacyV1);
      const flat = normalizeLegacyFlatModels(JSON.parse(storedV2), false);
      markCredentialReentryRequired();
      const vendors = groupModelsIntoVendors(flat);
      saveManagedVendors(vendors);
      return vendors;
    }

    if (legacyV1 === null) return [];
    const flat = normalizeLegacyFlatModels(parseLegacyModelStorage(legacyV1), true);
    markCredentialReentryRequired();
    const vendors = groupModelsIntoVendors(flat);
    saveManagedVendors(vendors);
    return vendors;
  } catch {
    try {
      window.localStorage.removeItem(MODEL_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_MODEL_STORAGE_KEY_V2);
      window.localStorage.removeItem(LEGACY_MODEL_STORAGE_KEY);
    } catch {
      /* Storage may be unavailable. */
    }
    markCredentialReentryRequired();
    return [];
  }
}

export function loadManagedModels(): ManagedModel[] {
  return flattenVendors(loadManagedVendors());
}

export function isModelEnabled(model: ManagedModel): boolean {
  return model.enabled !== false;
}

export function isVendorEnabled(vendor: ModelVendorConnection): boolean {
  return vendor.enabled !== false;
}

export function toAgentModelSelection(model: ManagedModel): AgentModelSelection {
  return {
    configurationId: model.id,
    vendorId: model.vendorId,
    provider: model.provider,
    model: model.model.trim(),
    baseURL: model.baseURL.trim() || undefined,
    openaiApiMode: model.provider === "openai" ? model.openaiApiMode : undefined,
    supports1MContext: model.supports1MContext === true,
  };
}

export function vendorCredentialBinding(vendor: ModelVendorConnection) {
  return {
    vendorId: vendor.id,
    provider: vendor.protocol,
    ...(vendor.baseURL.trim() ? { baseURL: vendor.baseURL.trim() } : {}),
  };
}

export function countUsableModels(models: readonly ManagedModel[]): number {
  return models.filter((model) => isModelEnabled(model) && model.credentialConfigured === true)
    .length;
}
