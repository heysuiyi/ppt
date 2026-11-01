import type {
  AgentConfigurationSnapshot,
  AgentPreferences,
} from "@agent-harness/configuration/configuration-contract";
import type { CredentialStorageStatus } from "@agent-harness/configuration/credential-contract";
import {
  type AgentGatewayPreferences,
  DEFAULT_WEB_SEARCH_ENDPOINT,
} from "@agent-harness/configuration/gateway-settings";
import type { AgentExecutionStrategy } from "@agent-harness/configuration/model-contract";
import { getModelReasoningEfforts } from "@agent-harness/configuration/model-reasoning";
import type { AgentStepLimits } from "@agent-harness/configuration/step-limits";
import type { UiThemeSummary } from "@app/shared/ipc";
import { DEFAULT_DESIGN_SYSTEM, type DesignSystemV2, designSystemV2Schema } from "@design-system";
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
} from "../modelCatalog";
import { persistAgentConfiguration, saveExecutionPreferences } from "./agentSettingsPersistence";
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
import { useAppearanceRuntime, useComputedScheme } from "./useAppearanceRuntime";
import { normalizePersistedUiThemeId } from "./userUiTheme";

export interface SettingsController {
  vendors: ModelVendorConnection[];
  models: ManagedModel[];
  enabledModels: ManagedModel[];
  visibleModels: ManagedModel[];
  selectedModel?: ManagedModel;
  selectedModelId: string;
  selectModel: (id: string) => void;
  selectedReasoningEffort?: string;
  setReasoningEffort: (effort: string | undefined) => void;
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
  const [vendors, setVendors] = useState<ModelVendorConnection[]>(() =>
    bootstrap.credentials
      ? applyCredentialFlags(
          bootstrap.vendors,
          new Map(bootstrap.credentials.models.map((model) => [model.vendorId, model.configured])),
        )
      : bootstrap.vendors,
  );
  const vendorsRef = useRef(vendors);
  vendorsRef.current = vendors;
  const models = useMemo(() => flattenVendors(vendors), [vendors]);
  const [credentialStorageStatus, setCredentialStorageStatus] =
    useState<CredentialStorageStatus | null>(bootstrap.credentials?.storage ?? null);
  const [webSearchCredentialConfigured, setWebSearchCredentialConfigured] = useState(
    bootstrap.credentials?.webSearchConfigured ?? false,
  );
  const credentialRefreshIdRef = useRef(0);
  const [selectedModelId, setSelectedModelId] = useState(() => bootstrap.selectedModelId);
  // 输入框覆盖值按模型保留，仅影响后续请求，不写回厂商配置。
  const [reasoningOverrides, setReasoningOverrides] = useState<Record<string, string>>({});
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
  const override = selectedModel ? reasoningOverrides[selectedModel.id] : undefined;
  const selectedReasoningEffort =
    selectedModel && override && getModelReasoningEfforts(selectedModel).includes(override)
      ? override
      : undefined;
  const setReasoningEffort = (effort: string | undefined) => {
    if (!selectedModel) return;
    if (effort !== undefined && !getModelReasoningEfforts(selectedModel).includes(effort)) return;
    setReasoningOverrides((current) => ({ ...current, [selectedModel.id]: effort ?? "" }));
  };
  const computedScheme = useComputedScheme(colorScheme);

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

  const executionPreferences: AgentPreferences = {
    gateway: agentGatewayPreferences,
    stepLimits: agentStepLimits,
    executionStrategy,
    defaultTemplateId,
  };
  const executionPreferencesJson = JSON.stringify(executionPreferences);
  const preferencesRef = useRef(executionPreferencesJson);
  preferencesRef.current = executionPreferencesJson;
  const queuedPreferencesRef = useRef(executionPreferencesJson);
  const webSearchEndpoint =
    agentGatewayPreferences.webSearchEndpoint?.trim() || DEFAULT_WEB_SEARCH_ENDPOINT;

  const applyCredentialSnapshot = useCallback((snapshot: AgentConfigurationSnapshot) => {
    credentialRefreshIdRef.current += 1;
    setCredentialStorageStatus(snapshot.credentials.storage);
    setWebSearchCredentialConfigured(snapshot.credentials.webSearchConfigured);
    setVendors((current) =>
      applyCredentialFlags(
        current,
        new Map(snapshot.credentials.models.map((model) => [model.vendorId, model.configured])),
      ),
    );
  }, []);

  const applyCommittedSnapshot = (
    snapshot: AgentConfigurationSnapshot,
    submittedPreferences: string,
  ) => {
    const committedVendors = applyCredentialFlags(
      snapshot.settings.vendors,
      new Map(snapshot.credentials.models.map((model) => [model.vendorId, model.configured])),
    );
    setVendors(committedVendors);
    vendorsRef.current = committedVendors;
    applyCredentialSnapshot(snapshot);
    // A catalog/credential response may arrive while a preference form is being edited.
    if (preferencesRef.current !== submittedPreferences) return;
    const preferences: AgentPreferences = {
      gateway: snapshot.settings.gateway,
      stepLimits: snapshot.settings.stepLimits,
      executionStrategy: snapshot.settings.executionStrategy,
      defaultTemplateId: snapshot.settings.defaultTemplateId,
    };
    queuedPreferencesRef.current = JSON.stringify(preferences);
    setAgentGatewayPreferencesState(preferences.gateway);
    setAgentStepLimitsState(preferences.stepLimits);
    setExecutionStrategyState(preferences.executionStrategy);
    setDefaultTemplateIdState(preferences.defaultTemplateId);
  };

  useEffect(() => {
    if (executionPreferencesJson === queuedPreferencesRef.current) return;
    queuedPreferencesRef.current = executionPreferencesJson;
    let current = true;
    setExecutionSaveStatus("saving");
    void saveExecutionPreferences(JSON.parse(executionPreferencesJson))
      .then((snapshot) => {
        if (!current) return;
        const preferences: AgentPreferences = {
          gateway: snapshot.settings.gateway,
          stepLimits: snapshot.settings.stepLimits,
          executionStrategy: snapshot.settings.executionStrategy,
          defaultTemplateId: snapshot.settings.defaultTemplateId,
        };
        queuedPreferencesRef.current = JSON.stringify(preferences);
        setAgentGatewayPreferencesState(preferences.gateway);
        setAgentStepLimitsState(preferences.stepLimits);
        setExecutionStrategyState(preferences.executionStrategy);
        setDefaultTemplateIdState(preferences.defaultTemplateId);
        applyCredentialSnapshot(snapshot);
        setExecutionSaveStatus("saved");
      })
      .catch((error: unknown) => {
        if (!current) return;
        setExecutionSaveStatus("failed");
        notify(`执行配置保存失败：${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      current = false;
    };
  }, [executionPreferencesJson, notify, applyCredentialSnapshot]);

  const refreshCredentialStatus = useCallback(async () => {
    const refreshId = ++credentialRefreshIdRef.current;
    try {
      const snapshot = await window.desktopApi.getAgentConfiguration();
      if (refreshId !== credentialRefreshIdRef.current) return;
      if (!snapshot) throw new Error("执行配置尚未初始化");
      // Refresh status only; never replace unsaved UI preferences or vendor drafts.
      applyCredentialSnapshot(snapshot);
    } catch (error) {
      if (refreshId !== credentialRefreshIdRef.current) return;
      setCredentialStorageStatus({
        state: "unavailable",
        backend: "unknown",
        warning: "safe-storage-unavailable",
      });
      setWebSearchCredentialConfigured(false);
      setVendors((current) => applyCredentialFlags(current, new Map()));
      notify(`凭据状态读取失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [notify, applyCredentialSnapshot]);

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

  const saveVendor = async (vendor: ModelVendorConnection, apiKey?: string): Promise<boolean> => {
    markSaving();
    const submittedPreferences = preferencesRef.current;
    const { credentialConfigured: _status, ...configuration } = vendor;
    const nextApiKey = apiKey?.trim();
    try {
      await persistAgentConfiguration(async () => {
        const snapshot = await window.desktopApi.saveAgentVendor({
          vendor: configuration,
          credential: nextApiKey ? { type: "replace", apiKey: nextApiKey } : { type: "keep" },
        });
        applyCommittedSnapshot(snapshot, submittedPreferences);
      });
      if (!selectedModelId && vendor.models[0]) setSelectedModelId(vendor.models[0].id);
      return true;
    } catch (error) {
      notify(`厂商配置保存失败: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const deleteVendor = async (vendorId: string): Promise<boolean> => {
    markSaving();
    const submittedPreferences = preferencesRef.current;
    try {
      return await persistAgentConfiguration(async () => {
        const current = vendorsRef.current;
        const existing = current.find((vendor) => vendor.id === vendorId);
        if (!existing) return false;
        const remaining = current.filter((vendor) => vendor.id !== vendorId);
        if (
          countUsableModels(flattenVendors(current)) > 0 &&
          countUsableModels(flattenVendors(remaining)) === 0
        ) {
          notify("至少保留一个可用模型");
          return false;
        }
        const snapshot = await window.desktopApi.deleteAgentVendor(vendorId);
        applyCommittedSnapshot(snapshot, submittedPreferences);
        const fallback = flattenVendors(vendorsRef.current).find(
          (model) => isModelEnabled(model) && model.credentialConfigured,
        );
        setSelectedModelId((currentId) =>
          existing.models.some((model) => model.id === currentId)
            ? (fallback?.id ?? "")
            : currentId,
        );
        return true;
      });
    } catch (error) {
      notify(`厂商配置删除失败: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  // Evaluate local edits inside the queue, after earlier Main commits update vendorsRef.
  // Whole-vendor dialog saves deliberately remain whole-draft replacements.
  const mutateVendor = async (
    buildVendor: (current: ModelVendorConnection[]) => ModelVendorConnection | undefined,
  ): Promise<boolean> => {
    markSaving();
    const submittedPreferences = preferencesRef.current;
    try {
      return await persistAgentConfiguration(async () => {
        const current = vendorsRef.current;
        const vendor = buildVendor(current);
        if (!vendor) return false;
        const remaining = current.map((item) => (item.id === vendor.id ? vendor : item));
        if (
          countUsableModels(flattenVendors(current)) > 0 &&
          countUsableModels(flattenVendors(remaining)) === 0
        ) {
          notify("至少保留一个可用模型");
          return false;
        }
        const { credentialConfigured: _status, ...configuration } = vendor;
        const snapshot = await window.desktopApi.saveAgentVendor({
          vendor: configuration,
          credential: { type: "keep" },
        });
        applyCommittedSnapshot(snapshot, submittedPreferences);
        const committedModels = flattenVendors(vendorsRef.current);
        const fallback = committedModels.find(
          (model) => isModelEnabled(model) && model.credentialConfigured,
        );
        setSelectedModelId((currentId) =>
          committedModels.some((model) => model.id === currentId)
            ? currentId
            : (fallback?.id ?? ""),
        );
        return true;
      });
    } catch (error) {
      notify(`厂商配置保存失败: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const deleteModel = (modelId: string): Promise<boolean> =>
    mutateVendor((current) => {
      const owner = current.find((vendor) => vendor.models.some((model) => model.id === modelId));
      return owner
        ? { ...owner, models: owner.models.filter((model) => model.id !== modelId) }
        : undefined;
    });

  const setVendorEnabled = (vendorId: string, enabled: boolean): Promise<boolean> =>
    mutateVendor((current) => {
      const vendor = current.find((item) => item.id === vendorId);
      return vendor ? { ...vendor, enabled } : undefined;
    });

  const setModelEnabled = (modelId: string, enabled: boolean): Promise<boolean> =>
    mutateVendor((current) => {
      const owner = current.find((vendor) => vendor.models.some((model) => model.id === modelId));
      return owner
        ? {
            ...owner,
            models: owner.models.map((model) =>
              model.id === modelId ? { ...model, enabled } : model,
            ),
          }
        : undefined;
    });

  const saveWebSearchCredential = async (
    apiKey: string,
    endpoint = webSearchEndpoint,
  ): Promise<boolean> => {
    const normalizedApiKey = apiKey.trim();
    if (!normalizedApiKey) {
      notify("请填写 Tavily API Key");
      return false;
    }
    const submittedPreferences = preferencesRef.current;
    try {
      const snapshot = await persistAgentConfiguration(() =>
        window.desktopApi.updateAgentSearchCredential({
          endpoint,
          credential: { type: "replace", apiKey: normalizedApiKey },
        }),
      );
      applyCommittedSnapshot(snapshot, submittedPreferences);
      markSaving();
      return true;
    } catch (error) {
      notify(`搜索 API Key 保存失败: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const deleteWebSearchCredential = async (): Promise<boolean> => {
    const submittedPreferences = preferencesRef.current;
    try {
      const snapshot = await persistAgentConfiguration(() =>
        window.desktopApi.updateAgentSearchCredential({
          endpoint: webSearchEndpoint,
          credential: { type: "remove" },
        }),
      );
      applyCommittedSnapshot(snapshot, submittedPreferences);
      markSaving();
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
    selectedReasoningEffort,
    setReasoningEffort,
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
