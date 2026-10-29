import {
  type AgentConfigurationSnapshot,
  agentPreferencesSchema,
  type ConfigurationManagement,
  discoverAgentModelsSchema,
  saveAgentVendorSchema,
  updateSearchCredentialSchema,
  type VendorConfiguration,
  vendorIdSchema,
} from "@shared/agent-configuration";
import {
  DEFAULT_AGENT_GATEWAY_CONFIG,
  DEFAULT_WEB_SEARCH_ENDPOINT,
} from "@shared/agent-gateway-config";
import { type AgentSettings, agentSettingsSchema } from "@shared/agent-settings";
import { DEFAULT_AGENT_STEP_LIMITS } from "@shared/agent-step-limits";
import { normalizeCredentialUrl } from "@shared/credentials";
import { APPLICATION_DEFAULT_TEMPLATE_ID } from "@shared/template-protocol";
import { type CredentialStore, CredentialStoreError } from "./internal/credential-store";
import { normalizeModelCredentialBinding } from "./internal/credential-types";
import {
  OFFICIAL_MODEL_BASE_URLS,
  resolveEnvironmentModelApiKey,
  resolveEnvironmentWebSearchApiKey,
} from "./internal/environment-policy";
import { discoverModels } from "./internal/model-discovery";
import type { AgentSettingsStore } from "./internal/settings-store";

export function vendorBinding(vendor: VendorConfiguration) {
  return normalizeModelCredentialBinding({
    vendorId: vendor.id,
    provider: vendor.protocol,
    ...(vendor.baseURL ? { baseURL: vendor.baseURL } : {}),
  });
}
export function createManagement(
  settingsStore: AgentSettingsStore,
  credentials: CredentialStore,
  environment: NodeJS.ProcessEnv,
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>,
): ConfigurationManagement {
  const requireSettings = async () => {
    const settings = await settingsStore.get();
    if (!settings) throw new Error("Execution settings have not been initialized.");
    return settings;
  };
  const snapshot = async (settings: AgentSettings): Promise<AgentConfigurationSnapshot> => {
    const models = settings.vendors.map(vendorBinding);
    const endpoint = settings.gateway.webSearchEndpoint?.trim() || DEFAULT_WEB_SEARCH_ENDPOINT;
    const status = await credentials.getStatus({ models, webSearch: { endpoint } });
    return {
      settings,
      credentials: {
        ...status,
        models: status.models.map((entry, index) => ({
          ...entry,
          configured:
            entry.configured ||
            Boolean(
              resolveEnvironmentModelApiKey(
                models[index]!.provider,
                models[index]!.baseURL,
                environment,
              ),
            ),
        })),
        webSearchConfigured:
          status.webSearchConfigured ||
          Boolean(
            resolveEnvironmentWebSearchApiKey(settings.gateway.webSearchEndpoint, environment),
          ),
      },
    };
  };
  return {
    getSnapshot: () =>
      exclusive(async () => {
        const settings = await settingsStore.get();
        return settings ? snapshot(settings) : undefined;
      }),
    initialize: (legacy) =>
      exclusive(async () => {
        const existing = await settingsStore.get();
        if (existing) return snapshot(existing);
        const settings = agentSettingsSchema.parse(
          legacy ?? {
            vendors: [],
            gateway: DEFAULT_AGENT_GATEWAY_CONFIG,
            stepLimits: DEFAULT_AGENT_STEP_LIMITS,
            executionStrategy: "REQUEST_APPROVAL",
            defaultTemplateId: APPLICATION_DEFAULT_TEMPLATE_ID,
          },
        );
        return snapshot(await settingsStore.save(settings, true));
      }),
    saveVendor: (input) =>
      exclusive(async () => {
        const { vendor, credential } = saveAgentVendorSchema.parse(input);
        const current = await requireSettings();
        const previous = current.vendors.find((entry) => entry.id === vendor.id);
        const vendors = previous
          ? current.vendors.map((entry) => (entry.id === vendor.id ? vendor : entry))
          : [...current.vendors, vendor];
        const fallbackModelId = current.gateway.fallbackModelId;
        const gateway =
          fallbackModelId &&
          !vendors.some((entry) => entry.models.some((model) => model.id === fallbackModelId))
            ? { ...current.gateway, fallbackModelId: undefined }
            : current.gateway;
        const next = agentSettingsSchema.parse({ ...current, vendors, gateway });
        const binding = vendorBinding(vendor);
        if (credential.type === "replace") {
          await credentials.setModelCredentials({ bindings: [binding], apiKey: credential.apiKey });
        } else if (
          credential.type === "remove" ||
          (previous && JSON.stringify(vendorBinding(previous)) !== JSON.stringify(binding))
        ) {
          await credentials.deleteModelCredential({ vendorId: vendor.id });
        }
        return snapshot(await settingsStore.save(next));
      }),
    deleteVendor: (input) =>
      exclusive(async () => {
        const vendorId = vendorIdSchema.parse(input);
        const current = await requireSettings();
        const removed = current.vendors.find((vendor) => vendor.id === vendorId);
        const fallbackRemoved = removed?.models.some(
          (model) => model.id === current.gateway.fallbackModelId,
        );
        const next = agentSettingsSchema.parse({
          ...current,
          vendors: current.vendors.filter((vendor) => vendor.id !== vendorId),
          gateway: fallbackRemoved
            ? { ...current.gateway, fallbackModelId: undefined }
            : current.gateway,
        });
        await credentials.deleteModelCredential({ vendorId });
        return snapshot(await settingsStore.save(next));
      }),
    savePreferences: (input) =>
      exclusive(async () => {
        const preferences = agentPreferencesSchema.parse(input);
        const current = await requireSettings();
        if (preferences.gateway.webSearchEndpoint?.trim())
          normalizeCredentialUrl(preferences.gateway.webSearchEndpoint);
        const next = agentSettingsSchema.parse({ ...current, ...preferences });
        const previousEndpoint = normalizeCredentialUrl(
          current.gateway.webSearchEndpoint?.trim() || DEFAULT_WEB_SEARCH_ENDPOINT,
        );
        const nextEndpoint = normalizeCredentialUrl(
          next.gateway.webSearchEndpoint?.trim() || DEFAULT_WEB_SEARCH_ENDPOINT,
        );
        if (previousEndpoint !== nextEndpoint) await credentials.deleteWebSearchCredential();
        return snapshot(await settingsStore.save(next));
      }),
    updateSearchCredential: (input) =>
      exclusive(async () => {
        const request = updateSearchCredentialSchema.parse(input);
        const current = await requireSettings();
        const next = agentSettingsSchema.parse({
          ...current,
          gateway: { ...current.gateway, webSearchEndpoint: request.endpoint },
        });
        if (request.credential.type === "replace") {
          await credentials.setWebSearchCredential({
            binding: { endpoint: request.endpoint },
            apiKey: request.credential.apiKey,
          });
        } else if (
          request.credential.type === "remove" ||
          normalizeCredentialUrl(
            current.gateway.webSearchEndpoint?.trim() || DEFAULT_WEB_SEARCH_ENDPOINT,
          ) !== request.endpoint
        ) {
          await credentials.deleteWebSearchCredential();
        }
        return snapshot(await settingsStore.save(next));
      }),
    listRemoteModels: async (input) => {
      const request = discoverAgentModelsSchema.parse(input);
      const connection =
        request.type === "draft"
          ? request
          : await exclusive(async () => {
              const settings = await requireSettings();
              const vendor = settings.vendors.find((entry) => entry.id === request.vendorId);
              if (!vendor) throw new Error("Selected vendor does not exist.");
              const binding = vendorBinding(vendor);
              let storedKey: string | undefined;
              try {
                storedKey = await credentials.resolveModelCredential(binding);
              } catch (error) {
                if (
                  !(error instanceof CredentialStoreError && error.code === "STORAGE_UNAVAILABLE")
                )
                  throw error;
              }
              const apiKey =
                storedKey ??
                resolveEnvironmentModelApiKey(binding.provider, binding.baseURL, environment);
              if (!apiKey) throw new Error("No credential matches this vendor connection.");
              const environmentURL =
                vendor.protocol === "openai"
                  ? environment.OPENAI_BASE_URL?.trim()
                  : environment.ANTHROPIC_BASE_URL?.trim();
              // The saved connection determines address and protocol together.
              return {
                provider: vendor.protocol,
                baseURL: normalizeCredentialUrl(
                  vendor.baseURL ||
                    (storedKey ? undefined : environmentURL) ||
                    OFFICIAL_MODEL_BASE_URLS[vendor.protocol],
                ),
                apiKey,
              };
            });
      return discoverModels(connection);
    },
  };
}
