import {
  type AgentGatewayPreferences,
  resolveAgentGatewayPreferences,
} from "@shared/agent-gateway-config";
import { markCredentialReentryRequired } from "./credentialMigration";

export const AGENT_GATEWAY_CONFIG_STORAGE_KEY = "agent-ppt.gateway-config.v2";
export const LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY = "agent-ppt.gateway-config.v1";

function hasPersistedWebSearchKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const apiKey = (value as Record<string, unknown>).webSearchApiKey;
  return typeof apiKey === "string" && Boolean(apiKey.trim());
}

function sanitizePreferences(value: unknown): AgentGatewayPreferences {
  if (hasPersistedWebSearchKey(value)) markCredentialReentryRequired();
  return resolveAgentGatewayPreferences(value as Partial<AgentGatewayPreferences> | undefined);
}

function auditLegacyGatewayPreferences(raw: string): void {
  try {
    if (hasPersistedWebSearchKey(JSON.parse(raw) as unknown)) {
      markCredentialReentryRequired();
    }
  } catch {
    markCredentialReentryRequired();
  }
}

export function loadAgentGatewayPreferences(): AgentGatewayPreferences {
  try {
    const stored = window.localStorage.getItem(AGENT_GATEWAY_CONFIG_STORAGE_KEY);
    const legacy = window.localStorage.getItem(LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY);
    if (legacy !== null) {
      window.localStorage.removeItem(LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY);
    }
    if (stored !== null) {
      if (legacy !== null) auditLegacyGatewayPreferences(legacy);
      const preferences = sanitizePreferences(JSON.parse(stored));
      saveAgentGatewayPreferences(preferences);
      return preferences;
    }
    if (legacy === null) return resolveAgentGatewayPreferences();
    const preferences = sanitizePreferences(JSON.parse(legacy));
    saveAgentGatewayPreferences(preferences);
    return preferences;
  } catch {
    try {
      window.localStorage.removeItem(AGENT_GATEWAY_CONFIG_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY);
    } catch {
      /* Storage may be unavailable; there is no safe browser fallback for secrets. */
    }
    markCredentialReentryRequired();
    return resolveAgentGatewayPreferences();
  }
}

export function saveAgentGatewayPreferences(preferences: AgentGatewayPreferences): void {
  window.localStorage.setItem(
    AGENT_GATEWAY_CONFIG_STORAGE_KEY,
    JSON.stringify(resolveAgentGatewayPreferences(preferences)),
  );
}
