import {
  type AgentGatewayPreferences,
  resolveAgentGatewayPreferences,
} from "@agent-harness/configuration/gateway-settings";
import { markCredentialReentryRequired } from "./credentialMigration";

export const AGENT_GATEWAY_CONFIG_STORAGE_KEY = "agent-ppt.gateway-config.v2";
export const LEGACY_AGENT_GATEWAY_CONFIG_STORAGE_KEY = "agent-ppt.gateway-config.v1";

function hasPersistedCredentials(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.entries(record).some(([key, entry]) =>
    (key === "apiKey" || key === "webSearchApiKey") && typeof entry === "string"
      ? Boolean(entry.trim())
      : hasPersistedCredentials(entry),
  );
}

function sanitizePreferences(value: unknown): AgentGatewayPreferences {
  if (hasPersistedCredentials(value)) markCredentialReentryRequired();
  if (!value || typeof value !== "object") return resolveAgentGatewayPreferences();
  const { timeoutMs, maxOutputTokens, fallbackModelId, webSearchEndpoint, webSearchTimeoutMs } =
    value as Partial<AgentGatewayPreferences>;
  return resolveAgentGatewayPreferences({
    timeoutMs,
    maxOutputTokens,
    fallbackModelId,
    webSearchEndpoint,
    webSearchTimeoutMs,
  });
}

function auditLegacyGatewayPreferences(raw: string): void {
  try {
    if (hasPersistedCredentials(JSON.parse(raw) as unknown)) {
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
    if (stored !== null) {
      if (legacy !== null) auditLegacyGatewayPreferences(legacy);
      const preferences = sanitizePreferences(JSON.parse(stored));
      return preferences;
    }
    if (legacy === null) return resolveAgentGatewayPreferences();
    const preferences = sanitizePreferences(JSON.parse(legacy));
    return preferences;
  } catch {
    markCredentialReentryRequired();
    return resolveAgentGatewayPreferences();
  }
}
