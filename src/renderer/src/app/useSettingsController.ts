import { DEFAULT_DESIGN_SYSTEM, type DesignSystemV2, designSystemV2Schema } from "@design-system";
import type { AgentExecutionStrategy } from "@shared/agent";
import {
  type AgentGatewayPreferences,
  DEFAULT_WEB_SEARCH_ENDPOINT,
} from "@shared/agent-gateway-config";
import type { AgentStepLimits } from "@shared/agent-step-limits";
import {
  type CredentialStorageStatus,
  type ModelCredentialBinding,
  normalizeModelCredentialBinding,
  normalizeWebSearchCredentialBinding,
} from "@shared/credentials";
import type { UiThemeSummary } from "@shared/ipc";
import type { Presentation } from "@shared/presentation";
import { getBuiltinTemplate } from "@shared/template-catalog";
import { APPLICATION_DEFAULT_TEMPLATE_ID, isUploadedTemplateId } from "@shared/template-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  countUsableModels,
  flattenVendors,
  isModelEnabled,
  type ManagedModel,
  type ModelVendorConnection,
  SELECTED_MODEL_STORAGE_KEY,
  vendorCredentialBinding,
} from "../modelCatalog";
import { saveExecutionSettings } from "./agentSettingsPersistence";
import {
  type AppBootstrapSnapshot,
  type ComputedColorScheme,
  savePersistedUiSettings,
  type UiColorScheme,
  type UiFontFamily,
  type UiSkin,
} from "./appBootstrap";
import {
  normalizePersistedUiFontFamily,
  normalizePersistedUiFontSize,
  normalizePersistedUiLineHeight,
} from "./uiTypography";
import { getComputedScheme, useAppearanceRuntime } from "./useAppearanceRuntime";
import { normalizePersistedUiThemeId } from "./userUiTheme";

export interface SettingsController {
  vendors: ModelVendorConnection[];
  models: ManagedModel[];
  enabledModels: ManagedModel[];
  visibleModels: ManagedModel[];
  selectedModel?: ManagedModel;
  selectedModelId: string;
  selectModel: (id: string) => void;
  saveVendor: (vendor: ModelVendorConnection, apiKey?: string) => Promise<boolean>;
  deleteVendor: (vendorId: string) => Promise<boolean>;
  deleteModel: (modelId: string) => Promise<boolean>;
  setVendorEnabled: (vendorId: string, enabled: boolean) => Promise<boolean>;
  setModelEnabled: (modelId: string, enabled: boolean) => Promise<boolean>;
  credentialStorageStatus: CredentialStorageStatus | null;
  webSearchCredentialConfigured: boolean;
  saveWebSearchCredential: (apiKey: string, endpoint?: string) => Promise<boolean>;
  deleteWebSearchCredential: () => Promise<boolean>;
  selectedDesignSystem: DesignSystemV2;
  setSelectedDesignSystem: (value: DesignSystemV2) => void;
  defaultTemplateId: string;
  setDefaultTemplateId: (value: string) => void;
  agentStepLimits: AgentStepLimits;
  setAgentStepLimits: (value: AgentStepLimits) => void;
  agentGatewayPreferences: AgentGatewayPreferences;
  setAgentGatewayPreferences: (value: AgentGatewayPreferences) => void;
  executionStrategy: AgentExecutionStrategy;
  setExecutionStrategy: (value: AgentExecutionStrategy) => void;
  skin: UiSkin;
  setSkin: (value: UiSkin) => void;
  uiThemeId: string;
  setUiThemeId: (value: string) => void;
  uiThemes: UiThemeSummary[];
  refreshUiThemes: () => Promise<void>;
  openUiThemesDirectory: () => Promise<void>;
  colorScheme: UiColorScheme;
  setColorScheme: (value: UiColorScheme) => void;
  computedScheme: ComputedColorScheme;
  uiFontFamily: UiFontFamily;
  setUiFontFamily: (value: UiFontFamily) => void;
  uiFontSize: number;
  setUiFontSize: (value: number) => void;
  uiLineHeight: number;
  setUiLineHeight: (value: number) => void;
  saveStatus: "saved" | "saving" | "failed";
  markSaving: () => void;
}

function applyCredentialFlags(
  vendors: ModelVendorConnection[],
  configuredByVendorId: Map<string, boolean>,
): ModelVendorConnection[] {
  let changed = false;
  const next = vendors.map((vendor) => {
    const configured = configuredByVendorId.get(vendor.id) ?? false;
    if (vendor.credentialConfigured === configured) return vendor;
    changed = true;
    return { ...vendor, credentialConfigured: configured };
  });
  return changed ? next : vendors;
}

export function useSettingsController(
  bootstrap: AppBootstrapSnapshot,
  presentation: Presentation | undefined,
  notify: (message: string) => void,
): SettingsController {
  const persisted = bootstrap.persistedUiSettings;
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving">("saved");
  const [executionSaveStatus, setExecutionSaveStatus] = useState<"saved" | "saving" | "failed">(
    "saved",
  );
  const saveTimerRef = useRef<number | null>(null);
  const [agentStepLimits, setAgentStepLimitsState] = useState(() => bootstrap.agentStepLimits);
  const [agentGatewayPreferences, setAgentGatewayPreferencesState] = useState(
    () => bootstrap.agentGatewayPreferences,
  );
  const [executionStrategy, setExecutionStrategyState] = useState<AgentExecutionStrategy>(() =>
    persisted.executionStrategy === "AUTO" ? "AUTO" : "REQUEST_APPROVAL",
  );
  const [skin, setSkinState] = useState<UiSkin>(() =>
    persisted.skin === "studio" ? "studio" : "studio",
  );
  const [uiThemeId, setUiThemeIdState] = useState<string>(() =>
    normalizePersistedUiThemeId(persisted.uiThemeId),
  );
  const [uiThemes, setUiThemes] = useState<UiThemeSummary[]>([]);
  const [colorScheme, setColorSchemeState] = useState<UiColorScheme>(
    () => bootstrap.initialColorScheme,
  );
  const [uiFontFamily, setUiFontFamilyState] = useState<UiFontFamily>(() =>
    normalizePersistedUiFontFamily(persisted.uiFontFamily),
  );
  const [uiFontSize, setUiFontSizeState] = useState<number>(() =>
    normalizePersistedUiFontSize(persisted.uiFontSize),
  );
  const [uiLineHeight, setUiLineHeightState] = useState<number>(() =>
    normalizePersistedUiLineHeight(persisted.uiLineHeight),
  );
  const [selectedDesignSystem, setSelectedDesignSystemState] = useState<DesignSystemV2>(() => {
    const parsed = designSystemV2Schema.safeParse(persisted.selectedDesignSystem);
    return parsed.success ? parsed.data : DEFAULT_DESIGN_SYSTEM;
  });
  const [defaultTemplateId, setDefaultTemplateIdState] = useState<string>(() => {
    const requested = persisted.defaultTemplateId ?? APPLICATION_DEFAULT_TEMPLATE_ID;
    if (isUploadedTemplateId(requested)) return requested;
    return getBuiltinTemplate(requested)?.id ?? APPLICATION_DEFAULT_TEMPLATE_ID;
  });
  const [vendors, setVendors] = useState<ModelVendorConnection[]>(() => bootstrap.vendors);
  const vendorsRef = useRef(vendors);
  vendorsRef.current = vendors;
  const models = useMemo(() => flattenVendors(vendors), [vendors]);
  const [credentialStorageStatus, setCredentialStorageStatus] =
    useState<CredentialStorageStatus | null>(null);
  const [webSearchCredentialConfigured, setWebSearchCredentialConfigured] = useState(false);
  const credentialRefreshIdRef = useRef(0);
  const [selectedModelId, setSelectedModelId] = useState(() => bootstrap.selectedModelId);
  const credentialStatusLoaded = credentialStorageStatus !== null;
  const enabledModels = useMemo(
    () =>
      credentialStatusLoaded
        ? models.filter((model) => isModelEnabled(model) && model.credentialConfigured === true)
        : [],
    [credentialStatusLoaded, models],
  );
  const visibleModels = useMemo(
    () =>
      credentialStatusLoaded ? enabledModels : enabledModels.length > 0 ? enabledModels : models,
    [credentialStatusLoaded, enabledModels, models],
  );
  const selectedModel =
    visibleModels.find((model) => model.id === selectedModelId) ?? visibleModels[0];
  const computedScheme = getComputedScheme(colorScheme);

  const markSaving = useCallback(() => {
    setSaveStatus("saving");
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      setSaveStatus("saved");
      saveTimerRef.current = null;
    }, 500);
  }, []);

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!visibleModels.some((model) => model.id === selectedModelId) && visibleModels[0]) {
      setSelectedModelId(visibleModels[0].id);
    }
  }, [selectedModelId, visibleModels]);

  useEffect(() => {
    window.localStorage.setItem(SELECTED_MODEL_STORAGE_KEY, selectedModelId);
  }, [selectedModelId]);

  const executionSettingsJson = JSON.stringify({
    vendors: vendors.map(({ credentialConfigured: _status, ...vendor }) => vendor),
    gateway: agentGatewayPreferences,
    stepLimits: agentStepLimits,
    executionStrategy,
    defaultTemplateId,
  });
  useEffect(() => {
    let current = true;
    setExecutionSaveStatus("saving");
    void saveExecutionSettings(JSON.parse(executionSettingsJson))
      .then(() => {
        if (current) setExecutionSaveStatus("saved");
      })
      .catch((error: unknown) => {
        if (!current) return;
        setExecutionSaveStatus("failed");
        notify(`执行配置保存失败：${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      current = false;
    };
  }, [executionSettingsJson, notify]);

  const clearFallbackIfMissing = useCallback((remainingModelIds: Set<string>) => {
    setAgentGatewayPreferencesState((current) => {
      if (!current.fallbackModelId || remainingModelIds.has(current.fallbackModelId)) {
        return current;
      }
      return { ...current, fallbackModelId: undefined };
    });
  }, []);

  const vendorCredentialBindings = useMemo(() => {
    const byVendor = new Map<string, ModelCredentialBinding>();
    for (const vendor of vendors) {
      try {
        byVendor.set(vendor.id, normalizeModelCredentialBinding(vendorCredentialBinding(vendor)));
      } catch {
        /* skip invalid vendor connection */
      }
    }
    return [...byVendor.values()];
  }, [vendors]);
  // Depend on a content fingerprint, not the bindings array identity: refresh clears
  // credentialConfigured flags and recreates `vendors`, which would otherwise rebuild
  // the array every cycle and retrigger this callback forever.
  const vendorCredentialBindingsFingerprint = JSON.stringify(vendorCredentialBindings);
  const vendorCredentialBindingsRef = useRef(vendorCredentialBindings);
  vendorCredentialBindingsRef.current = vendorCredentialBindings;
  const webSearchEndpoint =
    agentGatewayPreferences.webSearchEndpoint?.trim() || DEFAULT_WEB_SEARCH_ENDPOINT;

  const refreshCredentialStatus = useCallback(async () => {
    // Keep the callback identity tied to binding *content* (see fingerprint above).
    void vendorCredentialBindingsFingerprint;
    const desktopApi = window.desktopApi;
    const refreshId = ++credentialRefreshIdRef.current;
    setCredentialStorageStatus(null);
    setWebSearchCredentialConfigured(false);
    setVendors((current) =>
      applyCredentialFlags(current, new Map(current.map((vendor) => [vendor.id, false]))),
    );
    const failClosed = (message: string) => {
      setCredentialStorageStatus({
        state: "unavailable",
        backend: "unknown",
        warning: "safe-storage-unavailable",
      });
      setWebSearchCredentialConfigured(false);
      setVendors((current) =>
        applyCredentialFlags(current, new Map(current.map((vendor) => [vendor.id, false]))),
      );
      notify(message);
    };
    if (!desktopApi?.getCredentialStatus) {
      failClosed("凭据状态读取失败: 桌面安全存储接口不可用");
      return;
    }
    let webSearch;
    try {
      webSearch = normalizeWebSearchCredentialBinding({ endpoint: webSearchEndpoint });
    } catch (error) {
      failClosed(`搜索凭据状态读取失败: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    try {
      const snapshot = await desktopApi.getCredentialStatus({
        models: vendorCredentialBindingsRef.current,
        webSearch,
      });
      if (refreshId !== credentialRefreshIdRef.current) return;
      const configuredById = new Map(
        snapshot.models.map((model) => [model.vendorId, model.configured]),
      );
      setCredentialStorageStatus(snapshot.storage);
      setWebSearchCredentialConfigured(snapshot.webSearchConfigured);
      setVendors((current) => applyCredentialFlags(current, configuredById));
    } catch (error) {
      if (refreshId !== credentialRefreshIdRef.current) return;
      failClosed(`凭据状态读取失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [notify, vendorCredentialBindingsFingerprint, webSearchEndpoint]);

  useEffect(() => {
    void refreshCredentialStatus();
  }, [refreshCredentialStatus]);

  const refreshUiThemes = useCallback(async () => {
    const desktopApi = window.desktopApi;
    if (!desktopApi?.listUiThemes) {
      setUiThemes([]);
      return;
    }
    try {
      const themes = await desktopApi.listUiThemes();
      setUiThemes(themes);
      const availableIds = new Set(themes.map((theme) => theme.id));
      setUiThemeIdState((current) => normalizePersistedUiThemeId(current, availableIds));
    } catch (error) {
      console.error("刷新 UI 主题列表失败:", error);
      setUiThemes([]);
    }
  }, []);

  const openUiThemesDirectory = useCallback(async () => {
    try {
      await window.desktopApi?.openUiThemesDirectory?.();
      await refreshUiThemes();
    } catch (error) {
      console.error("打开 UI 主题目录失败:", error);
      notify("无法打开主题文件夹");
    }
  }, [notify, refreshUiThemes]);

  useEffect(() => {
    void refreshUiThemes();
  }, [refreshUiThemes]);

  useEffect(() => {
    savePersistedUiSettings({
      defaultRatio: "16:9",
      skin,
      uiThemeId,
      colorScheme,
      uiFontFamily,
      uiFontSize,
      uiLineHeight,
      selectedDesignSystem,
      defaultTemplateId,
      executionStrategy,
    });
  }, [
    colorScheme,
    defaultTemplateId,
    executionStrategy,
    selectedDesignSystem,
    skin,
    uiFontFamily,
    uiFontSize,
    uiLineHeight,
    uiThemeId,
  ]);

  useAppearanceRuntime({
    skin,
    uiThemeId,
    colorScheme,
    computedScheme,
    uiFontFamily,
    uiFontSize,
    uiLineHeight,
  });

  useEffect(() => {
    if (
      presentation?.designSystem &&
      JSON.stringify(presentation.designSystem) !== JSON.stringify(selectedDesignSystem)
    ) {
      setSelectedDesignSystemState(presentation.designSystem);
    }
  }, [presentation, selectedDesignSystem]);

  const update =
    <T>(setter: (value: T) => void) =>
    (value: T) => {
      markSaving();
      setter(value);
    };

  const selectModel = update(setSelectedModelId);

  const bindingForVendor = (vendor: ModelVendorConnection): ModelCredentialBinding =>
    normalizeModelCredentialBinding(vendorCredentialBinding(vendor));

  const saveVendor = async (vendor: ModelVendorConnection, apiKey?: string): Promise<boolean> => {
    markSaving();
    const nextApiKey = apiKey?.trim();
    let binding: ModelCredentialBinding;
    try {
      binding = bindingForVendor(vendor);
    } catch (error) {
      notify(`厂商连接配置无效: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }

    const existing = vendorsRef.current.find((item) => item.id === vendor.id);
    let bindingChanged = !existing;
    if (existing) {
      try {
        bindingChanged = JSON.stringify(bindingForVendor(existing)) !== JSON.stringify(binding);
      } catch {
        bindingChanged = true;
      }
    }

    if (nextApiKey) {
      try {
        await window.desktopApi.setModelCredentials({ bindings: [binding], apiKey: nextApiKey });
        credentialRefreshIdRef.current += 1;
      } catch (error) {
        notify(`API Key 保存失败: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    } else if (bindingChanged && existing?.credentialConfigured) {
      try {
        await window.desktopApi.deleteModelCredential({ vendorId: existing.id });
        credentialRefreshIdRef.current += 1;
      } catch (error) {
        notify(`旧厂商凭据清除失败: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    } else if (!nextApiKey && !existing?.credentialConfigured && vendor.models.length > 0) {
      notify("请填写 API Key");
      return false;
    }

    const credentialConfigured =
      Boolean(nextApiKey) || (!bindingChanged && existing?.credentialConfigured === true);
    const persistedVendor: ModelVendorConnection = {
      ...vendor,
      credentialConfigured,
    };

    setVendors((current) => {
      const without = current.filter((item) => item.id !== persistedVendor.id);
      if (persistedVendor.kind !== "custom") {
        return [...without.filter((item) => item.kind !== persistedVendor.kind), persistedVendor];
      }
      return [...without, persistedVendor];
    });

    if (!selectedModelId && persistedVendor.models[0]) {
      setSelectedModelId(persistedVendor.models[0].id);
    }
    return true;
  };

  const deleteVendor = async (vendorId: string): Promise<boolean> => {
    markSaving();
    const existing = vendorsRef.current.find((item) => item.id === vendorId);
    if (!existing) return false;

    const remaining = vendorsRef.current.filter((item) => item.id !== vendorId);
    const remainingModels = flattenVendors(remaining);
    const usableBefore = countUsableModels(flattenVendors(vendorsRef.current));
    const usableAfter = countUsableModels(remainingModels);
    if (usableBefore > 0 && usableAfter === 0) {
      notify("至少保留一个可用模型");
      return false;
    }

    try {
      await window.desktopApi.deleteModelCredential({ vendorId });
      credentialRefreshIdRef.current += 1;
    } catch (error) {
      notify(`厂商凭据删除失败: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }

    setVendors(remaining);
    clearFallbackIfMissing(new Set(remainingModels.map((model) => model.id)));
    if (existing.models.some((model) => model.id === selectedModelId)) {
      const fallback = remainingModels.find((model) => isModelEnabled(model));
      setSelectedModelId(fallback?.id ?? "");
    }
    return true;
  };

  const deleteModel = async (modelId: string): Promise<boolean> => {
    markSaving();
    const owner = vendorsRef.current.find((vendor) =>
      vendor.models.some((model) => model.id === modelId),
    );
    if (!owner) return false;

    const flat = flattenVendors(vendorsRef.current);
    const targetFlat = flat.find((model) => model.id === modelId);
    const usableBefore = countUsableModels(flat);
    const usableAfter = countUsableModels(flat.filter((model) => model.id !== modelId));
    if (
      targetFlat &&
      isModelEnabled(targetFlat) &&
      targetFlat.credentialConfigured === true &&
      usableBefore > 0 &&
      usableAfter === 0
    ) {
      notify("至少保留一个可用模型");
      return false;
    }

    const nextVendor: ModelVendorConnection = {
      ...owner,
      models: owner.models.filter((model) => model.id !== modelId),
    };
    setVendors((current) =>
      current.map((vendor) => (vendor.id === owner.id ? nextVendor : vendor)),
    );
    clearFallbackIfMissing(
      new Set(
        flattenVendors(
          vendorsRef.current.map((vendor) => (vendor.id === owner.id ? nextVendor : vendor)),
        ).map((model) => model.id),
      ),
    );
    if (selectedModelId === modelId) {
      const fallback = flat.find((model) => model.id !== modelId && isModelEnabled(model));
      setSelectedModelId(fallback?.id ?? "");
    }
    return true;
  };

  const setVendorEnabled = async (vendorId: string, enabled: boolean): Promise<boolean> => {
    markSaving();
    const existing = vendorsRef.current.find((item) => item.id === vendorId);
    if (!existing) return false;
    if (!enabled) {
      const remaining = vendorsRef.current.map((vendor) =>
        vendor.id === vendorId ? { ...vendor, enabled: false } : vendor,
      );
      const usableAfter = countUsableModels(flattenVendors(remaining));
      if (countUsableModels(flattenVendors(vendorsRef.current)) > 0 && usableAfter === 0) {
        notify("至少保留一个可用模型");
        return false;
      }
    }
    setVendors((current) =>
      current.map((vendor) => (vendor.id === vendorId ? { ...vendor, enabled } : vendor)),
    );
    return true;
  };

  const setModelEnabled = async (modelId: string, enabled: boolean): Promise<boolean> => {
    markSaving();
    const owner = vendorsRef.current.find((vendor) =>
      vendor.models.some((model) => model.id === modelId),
    );
    if (!owner) return false;
    if (!enabled) {
      const remaining = vendorsRef.current.map((vendor) =>
        vendor.id !== owner.id
          ? vendor
          : {
              ...vendor,
              models: vendor.models.map((model) =>
                model.id === modelId ? { ...model, enabled: false } : model,
              ),
            },
      );
      const usableAfter = countUsableModels(flattenVendors(remaining));
      if (countUsableModels(flattenVendors(vendorsRef.current)) > 0 && usableAfter === 0) {
        notify("至少保留一个可用模型");
        return false;
      }
    }
    setVendors((current) =>
      current.map((vendor) =>
        vendor.id !== owner.id
          ? vendor
          : {
              ...vendor,
              models: vendor.models.map((model) =>
                model.id === modelId ? { ...model, enabled } : model,
              ),
            },
      ),
    );
    return true;
  };

  const saveWebSearchCredential = async (
    apiKey: string,
    endpoint = webSearchEndpoint,
  ): Promise<boolean> => {
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) {
      notify("请填写 Tavily API Key");
      return false;
    }
    try {
      const binding = normalizeWebSearchCredentialBinding({ endpoint });
      await window.desktopApi.setWebSearchCredential({ binding, apiKey: normalizedApiKey });
      credentialRefreshIdRef.current += 1;
      setWebSearchCredentialConfigured(true);
      markSaving();
      return true;
    } catch (error) {
      notify(`搜索 API Key 保存失败: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const deleteWebSearchCredential = async (): Promise<boolean> => {
    try {
      await window.desktopApi.deleteWebSearchCredential();
      setWebSearchCredentialConfigured(false);
      markSaving();
      void refreshCredentialStatus();
      return true;
    } catch (error) {
      notify(`搜索 API Key 清除失败: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  return {
    vendors,
    models,
    enabledModels,
    visibleModels,
    selectedModel,
    selectedModelId,
    selectModel,
    saveVendor,
    deleteVendor,
    deleteModel,
    setVendorEnabled,
    setModelEnabled,
    credentialStorageStatus,
    webSearchCredentialConfigured,
    saveWebSearchCredential,
    deleteWebSearchCredential,
    selectedDesignSystem,
    setSelectedDesignSystem: update(setSelectedDesignSystemState),
    defaultTemplateId,
    setDefaultTemplateId: (value: string) => {
      if (isUploadedTemplateId(value)) {
        markSaving();
        setDefaultTemplateIdState(value);
        return;
      }
      const template = getBuiltinTemplate(value);
      if (!template) return;
      markSaving();
      setDefaultTemplateIdState(template.id);
      setSelectedDesignSystemState(template.designSystem);
    },
    agentStepLimits,
    setAgentStepLimits: update(setAgentStepLimitsState),
    agentGatewayPreferences,
    setAgentGatewayPreferences: update(setAgentGatewayPreferencesState),
    executionStrategy,
    setExecutionStrategy: update(setExecutionStrategyState),
    skin,
    setSkin: update(setSkinState),
    uiThemeId,
    setUiThemeId: update(setUiThemeIdState),
    uiThemes,
    refreshUiThemes,
    openUiThemesDirectory,
    colorScheme,
    setColorScheme: update(setColorSchemeState),
    computedScheme,
    uiFontFamily,
    setUiFontFamily: update(setUiFontFamilyState),
    uiFontSize,
    setUiFontSize: update(setUiFontSizeState),
    uiLineHeight,
    setUiLineHeight: update(setUiLineHeightState),
    saveStatus: executionSaveStatus === "saved" ? saveStatus : executionSaveStatus,
    markSaving,
  };
}
