import type { AgentModelSelection, AgentModelSettings, AgentProvider } from "@shared/agent";
import {
  type AgentGatewayConfig,
  DEFAULT_AGENT_GATEWAY_CONFIG,
} from "@shared/agent-gateway-config";
import { getModelReasoningEfforts } from "@shared/model-reasoning";
import { AgentGatewayError } from "./errors";
import type { ResolvedAgentModelConfig } from "./types";

/** Internal Gateway call path; callers never select this directly. */
export type AgentCallPath = "chat" | "responses" | "anthropic";

/** Internal config passed to provider drivers. Carries SDK routing details. */
export interface DriverResolvedConfig extends ResolvedAgentModelConfig {
  callPath: AgentCallPath;
}

export const DEFAULT_AGENT_TIMEOUT_MS = DEFAULT_AGENT_GATEWAY_CONFIG.timeoutMs;
export const DEFAULT_AGENT_MAX_OUTPUT_TOKENS = DEFAULT_AGENT_GATEWAY_CONFIG.maxOutputTokens;

/**
 * Keeps credentials addressable by model configuration identity without
 * letting a same-provider fallback replace the active provider default.
 */
export class AgentModelSettingsRegistry {
  private activePrimary?: AgentModelSettings;
  private readonly providerDefaults = new Map<AgentProvider, AgentModelSettings>();
  private readonly primaryByConfigurationId = new Map<string, AgentModelSettings>();
  private readonly fallbackByConfigurationId = new Map<string, AgentModelSettings>();
  private readonly fallbackByProviderModel = new Map<
    AgentProvider,
    Map<string, AgentModelSettings>
  >();

  registerPrimary(settings: AgentModelSettings): void {
    const registered = { ...settings };
    this.activePrimary = registered;
    this.providerDefaults.set(settings.provider, registered);
    if (settings.configurationId) {
      this.primaryByConfigurationId.set(settings.configurationId, registered);
    }
  }

  clearPrimary(): void {
    this.activePrimary = undefined;
    this.providerDefaults.clear();
    this.primaryByConfigurationId.clear();
  }

  registerFallback(settings: AgentModelSettings | undefined): void {
    this.fallbackByConfigurationId.clear();
    this.fallbackByProviderModel.clear();
    if (!settings) return;

    const registered = { ...settings };
    if (settings.configurationId) {
      this.fallbackByConfigurationId.set(settings.configurationId, registered);
      return;
    }

    let providerModels = this.fallbackByProviderModel.get(settings.provider);
    if (!providerModels) {
      providerModels = new Map<string, AgentModelSettings>();
      this.fallbackByProviderModel.set(settings.provider, providerModels);
    }
    providerModels.set(settings.model, registered);
  }

  getActivePrimary(): AgentModelSettings | undefined {
    return this.activePrimary;
  }

  resolve(
    selection: AgentModelSelection | undefined,
    provider: AgentProvider,
  ): AgentModelSettings | undefined {
    if (selection?.configurationId) {
      const primary = this.primaryByConfigurationId.get(selection.configurationId);
      const fallback = this.fallbackByConfigurationId.get(selection.configurationId);
      const exact = [primary, fallback].find(
        (candidate) => candidate?.provider === provider && candidate.model === selection.model,
      );
      if (exact) return exact;

      if (primary || fallback) {
        throw new AgentGatewayError(
          `Model configuration ${selection.configurationId} does not match ${provider}/${selection.model}.`,
          "configuration",
          provider,
        );
      }
      throw new AgentGatewayError(
        `Unknown model configuration: ${selection.configurationId}.`,
        "configuration",
        provider,
      );
    }

    const providerDefault = this.providerDefaults.get(provider);
    if (!selection?.model) return providerDefault;
    const modelFallback = this.fallbackByProviderModel.get(provider)?.get(selection.model);
    if (modelFallback) return modelFallback;
    return providerDefault?.model === selection.model ? providerDefault : undefined;
  }
}

function resolveCallPath(
  provider: AgentProvider,
  baseURL: string | undefined,
  runtimeMode: AgentModelSettings["openaiApiMode"],
): AgentCallPath {
  if (provider === "anthropic") return "anthropic";

  if (runtimeMode === "chat-completions") return "chat";
  if (runtimeMode === "responses") return "responses";
  if (runtimeMode) {
    throw new AgentGatewayError(
      `Unsupported openaiApiMode: ${runtimeMode}. Expected responses or chat-completions.`,
      "configuration",
      "openai",
    );
  }

  return baseURL ? "chat" : "responses";
}

function isSameModelSelection(
  current: AgentModelSelection | undefined,
  candidate: Pick<AgentModelSelection, "configurationId" | "provider" | "model">,
): boolean {
  if (current?.provider !== candidate.provider || current.model !== candidate.model) {
    return false;
  }
  if (current.configurationId || candidate.configurationId) {
    return current.configurationId === candidate.configurationId;
  }
  return true;
}

export function resolveFallbackModelSelection(
  current: AgentModelSelection | undefined,
  gatewayConfig?: AgentGatewayConfig,
): AgentModelSelection | undefined {
  const configured = gatewayConfig?.fallbackModel;
  if (!configured || isSameModelSelection(current, configured)) return undefined;
  return {
    ...(configured.configurationId ? { configurationId: configured.configurationId } : {}),
    ...(configured.vendorId ? { vendorId: configured.vendorId } : {}),
    provider: configured.provider,
    model: configured.model,
    ...(configured.reasoningEffort !== undefined
      ? { reasoningEffort: configured.reasoningEffort }
      : {}),
    ...(configured.supports1MContext ? { supports1MContext: true } : {}),
  };
}

export function resolveAgentModelConfig(
  selection: AgentModelSelection | undefined,
  runtimeSettings: AgentModelSettingsRegistry,
  gatewayConfig?: AgentGatewayConfig,
): DriverResolvedConfig {
  const selected = selection ?? runtimeSettings.getActivePrimary();
  if (!selected) {
    throw new AgentGatewayError("No runtime model configured.", "configuration");
  }
  const { provider, model } = selected;
  const runtime = runtimeSettings.resolve(selected, provider);
  const apiKey = runtime?.apiKey?.trim();

  if (!apiKey) {
    throw new AgentGatewayError(
      `No API key configured for ${provider}. Open Settings → 模型 and enter an API key for the active model.`,
      "configuration",
      provider,
    );
  }

  const baseURL = runtime?.baseURL;
  const reasoningEffort = runtime?.reasoningEffort;
  const supportedEffort =
    reasoningEffort !== undefined &&
    getModelReasoningEfforts({
      provider,
      model,
      openaiApiMode: runtime?.openaiApiMode ?? (baseURL ? "chat-completions" : "responses"),
    }).includes(reasoningEffort);

  return {
    ...((selection?.configurationId ?? runtime?.configurationId)
      ? { configurationId: selection?.configurationId ?? runtime?.configurationId }
      : {}),
    ...((selection?.vendorId ?? runtime?.vendorId)
      ? { vendorId: selection?.vendorId ?? runtime?.vendorId }
      : {}),
    provider,
    model,
    ...(supportedEffort ? { reasoningEffort } : {}),
    apiKey,
    baseURL,
    callPath: resolveCallPath(provider, baseURL, runtime?.openaiApiMode),
    timeoutMs: gatewayConfig?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    maxOutputTokens: gatewayConfig?.maxOutputTokens ?? DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
  };
}
