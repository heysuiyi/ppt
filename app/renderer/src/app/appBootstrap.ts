import type { DesignSystemV2 } from "@design-system";
import type { AgentExecutionStrategy } from "@shared/agent";
import type { AgentConfigurationSnapshot } from "@shared/agent-configuration";
import type { AgentGatewayPreferences } from "@shared/agent-gateway-config";
import type { AgentStepLimits } from "@shared/agent-step-limits";
import type { CredentialStatusSnapshot } from "@shared/credentials";
import { APPLICATION_DEFAULT_TEMPLATE_ID } from "@shared/template-protocol";
import {
  AGENT_GATEWAY_CONFIG_STORAGE_KEY,
  LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY,
  loadAgentGatewayPreferences,
} from "../agentGatewayConfig";
import { AGENT_STEP_LIMITS_STORAGE_KEY, loadAgentStepLimits } from "../agentStepLimits";
import {
  CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY,
  consumeCredentialReentryNotice,
} from "../credentialMigration";
import {
  flattenVendors,
  LEGACY_MODEL_STORAGE_KEY,
  LEGACY_MODEL_STORAGE_KEY_V2,
  loadManagedVendors,
  type ManagedModel,
  MODEL_STORAGE_KEY,
  type ModelVendorConnection,
  SELECTED_MODEL_STORAGE_KEY,
} from "../modelCatalog";
import type { UiFontFamily } from "./uiTypography";

export const UI_SETTINGS_STORAGE_KEY = "agent-ppt.ui-settings.v2";
const LEGACY_UI_SETTINGS_STORAGE_KEY = "agent-ppt.ui-settings.v1";

export type UiSkin = "studio";
export type UiColorScheme = "light" | "dark" | "system";
export type ComputedColorScheme = "light" | "dark";
export type { UiFontFamily };

/** @deprecated Use UiColorScheme. Kept for migration typing only. */
type LegacyThemeMode = "light" | "dark" | "cyan" | "orange" | "system";

export interface PersistedUiSettings {
  defaultRatio: "16:9" | "4:3";
  skin: UiSkin;
  /** Built-in `studio` or a custom theme id from `~/.agent-ppt/themes/<id>/theme.css`. */
  uiThemeId: string;
  colorScheme: UiColorScheme;
  uiFontFamily: UiFontFamily;
  /** Base UI font size in px. */
  uiFontSize: number;
  /** Leading multiplier applied on top of the size scale. */
  uiLineHeight: number;
  selectedDesignSystem: DesignSystemV2;
  /** Application default builtin template id for new projects. */
  defaultTemplateId: string;
  executionStrategy: AgentExecutionStrategy;
}

export interface AppBootstrapSnapshot {
  persistedUiSettings: Partial<PersistedUiSettings>;
  initialColorScheme: UiColorScheme;
  initialComputedScheme: ComputedColorScheme;
  vendors: ModelVendorConnection[];
  models: ManagedModel[];
  selectedModelId: string;
  agentStepLimits: AgentStepLimits;
  agentGatewayPreferences: AgentGatewayPreferences;
  credentialReentryRequired: boolean;
  credentials?: CredentialStatusSnapshot;
}

function getBrowserStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function readStorageItem(key: string): string | null {
  try {
    return getBrowserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorageItem(key: string, value: string): void {
  try {
    getBrowserStorage()?.setItem(key, value);
  } catch (error) {
    console.error("保存 UI 设置失败:", error);
  }
}

function removeStorageItem(key: string): void {
  try {
    getBrowserStorage()?.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function prefersDarkColorScheme(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/**
 * Migrate v1 settings (themeMode / uiReadingTone / cyan|orange modes)
 * into v2 (skin × colorScheme). Defaults to dark studio.
 */
function migrateLegacySettings(raw: Record<string, unknown>): Partial<PersistedUiSettings> {
  const migrated: Partial<PersistedUiSettings> = { ...raw } as Partial<PersistedUiSettings>;

  if (!migrated.skin) migrated.skin = "studio";

  if (!migrated.colorScheme) {
    const legacyMode = raw.themeMode as LegacyThemeMode | undefined;
    if (legacyMode === "dark") {
      migrated.colorScheme = "dark";
    } else if (legacyMode === "system") {
      migrated.colorScheme = "system";
    } else if (legacyMode === "cyan" || legacyMode === "orange" || legacyMode === "light") {
      migrated.colorScheme = "light";
    } else {
      const legacyTone = raw.uiReadingTone;
      if (legacyTone === "cyan" || legacyTone === "orange") {
        migrated.colorScheme = "light";
      } else {
        migrated.colorScheme = "dark";
      }
    }
  }

  delete (migrated as Record<string, unknown>).themeMode;
  delete (migrated as Record<string, unknown>).uiReadingTone;
  delete (migrated as Record<string, unknown>).colorContrastOffset;
  delete (migrated as Record<string, unknown>).uiAccentColor;
  delete (migrated as Record<string, unknown>).uiControlShape;
  delete (migrated as Record<string, unknown>).borderRadiusScale;
  delete (migrated as Record<string, unknown>).logoUrl;

  return migrated;
}

export function loadPersistedUiSettings(): Partial<PersistedUiSettings> {
  try {
    const v2 = readStorageItem(UI_SETTINGS_STORAGE_KEY);
    if (v2) {
      const parsed = JSON.parse(v2) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") return {};
      delete parsed.colorContrastOffset;
      delete parsed.uiAccentColor;
      delete parsed.uiControlShape;
      delete parsed.borderRadiusScale;
      delete parsed.logoUrl;
      return parsed as Partial<PersistedUiSettings>;
    }

    const v1 = readStorageItem(LEGACY_UI_SETTINGS_STORAGE_KEY);
    if (!v1) return {};

    const parsed = JSON.parse(v1) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};

    return migrateLegacySettings(parsed);
  } catch {
    return {};
  }
}

export function savePersistedUiSettings(settings: PersistedUiSettings): void {
  const { executionStrategy: _strategy, defaultTemplateId: _template, ...uiSettings } = settings;
  writeStorageItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(uiSettings));
}

export function resolveColorScheme(scheme: UiColorScheme | undefined): ComputedColorScheme {
  if (scheme === "light") return "light";
  if (scheme === "dark") return "dark";
  if (scheme === "system") return prefersDarkColorScheme() ? "dark" : "light";
  return "dark";
}

export function resolveInitialColorScheme(settings: Partial<PersistedUiSettings>): UiColorScheme {
  const scheme = settings.colorScheme;
  if (scheme === "light" || scheme === "dark" || scheme === "system") return scheme;
  return "dark";
}

export async function initializeAgentSettings(): Promise<AppBootstrapSnapshot> {
  const existing = await window.desktopApi.getAgentConfiguration();
  // Audit every browser source, even when Main already owns the settings.
  const legacy = loadAppBootstrapSnapshot();
  const configuration =
    existing ??
    (await window.desktopApi.initializeAgentConfiguration({
      vendors: legacy.vendors.map(({ credentialConfigured: _status, ...vendor }) => vendor),
      gateway: legacy.agentGatewayPreferences,
      stepLimits: legacy.agentStepLimits,
      executionStrategy: legacy.persistedUiSettings.executionStrategy ?? "REQUEST_APPROVAL",
      defaultTemplateId:
        legacy.persistedUiSettings.defaultTemplateId ?? APPLICATION_DEFAULT_TEMPLATE_ID,
    }));
  const bootstrap = loadAppBootstrapSnapshot(configuration);
  bootstrap.credentialReentryRequired ||= legacy.credentialReentryRequired;

  // Keep migration inputs and the warning retryable until Main has persisted successfully.
  for (const key of [
    MODEL_STORAGE_KEY,
    LEGACY_MODEL_STORAGE_KEY,
    LEGACY_MODEL_STORAGE_KEY_V2,
    AGENT_GATEWAY_CONFIG_STORAGE_KEY,
    LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY,
    AGENT_STEP_LIMITS_STORAGE_KEY,
  ]) {
    removeStorageItem(key);
  }
  if (
    !readStorageItem(UI_SETTINGS_STORAGE_KEY) &&
    readStorageItem(LEGACY_UI_SETTINGS_STORAGE_KEY)
  ) {
    writeStorageItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(legacy.persistedUiSettings));
    removeStorageItem(LEGACY_UI_SETTINGS_STORAGE_KEY);
  }
  consumeCredentialReentryNotice();
  return bootstrap;
}

export function loadAppBootstrapSnapshot(
  configuration?: AgentConfigurationSnapshot,
): AppBootstrapSnapshot {
  const persistedUiSettings = loadPersistedUiSettings();
  const initialColorScheme = resolveInitialColorScheme(persistedUiSettings);
  const settings = configuration?.settings;
  const vendors = settings?.vendors ?? loadManagedVendors();
  const models = flattenVendors(vendors);
  const agentGatewayPreferences = settings?.gateway ?? loadAgentGatewayPreferences();

  return {
    persistedUiSettings: {
      ...persistedUiSettings,
      ...(settings
        ? {
            executionStrategy: settings.executionStrategy,
            defaultTemplateId: settings.defaultTemplateId,
          }
        : {}),
    },
    initialColorScheme,
    initialComputedScheme: resolveColorScheme(initialColorScheme),
    vendors,
    models,
    selectedModelId: readStorageItem(SELECTED_MODEL_STORAGE_KEY) ?? models[0]?.id ?? "",
    agentStepLimits: settings?.stepLimits ?? loadAgentStepLimits(),
    agentGatewayPreferences,
    credentials: configuration?.credentials,
    credentialReentryRequired: readStorageItem(CREDENTIAL_REENTRY_NOTICE_STORAGE_KEY) === "1",
  };
}
