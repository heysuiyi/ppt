import type { ModelAdapterId } from "@agent-harness/models/model-contract";
import { normalizeCredentialUrl } from "./credential-contract.js";
import { DEFAULT_WEB_SEARCH_ENDPOINT } from "./gateway-settings.js";
import { type CredentialStore, CredentialStoreError } from "./internal/credential-store.js";
import { modelCredentialBindingFromSelection } from "./internal/credential-types.js";
import {
  OFFICIAL_MODEL_BASE_URLS,
  resolveEnvironmentModelApiKey,
  resolveEnvironmentWebSearchApiKey,
} from "./internal/environment-policy.js";
import { type AgentSettingsStore, resolveConfiguredModel } from "./internal/settings-store.js";
import type { AgentModelSelection, AgentModelSettings } from "./model-contract.js";
import { getModelReasoningEfforts } from "./model-reasoning.js";
import type { AgentConfiguration, ExecutionPlan } from "./types.js";

export function createRuntime(
  settingsStore: AgentSettingsStore,
  credentials: CredentialStore,
  environment: NodeJS.ProcessEnv,
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>,
): AgentConfiguration["runtime"] {
  const plans = new WeakMap<
    ExecutionPlan,
    { plan: ExecutionPlan; environment: NodeJS.ProcessEnv }
  >();
  async function storedKey(selection: AgentModelSelection): Promise<string | undefined> {
    if (!selection.vendorId) return undefined;
    try {
      return await credentials.resolveModelCredential(
        modelCredentialBindingFromSelection(selection),
      );
    } catch (error) {
      if (error instanceof CredentialStoreError && error.code === "STORAGE_UNAVAILABLE")
        return undefined;
      throw error;
    }
  }
  async function resolveModel(
    selection: AgentModelSelection,
    env: NodeJS.ProcessEnv,
    modelAdapter?: ModelAdapterId,
  ): Promise<AgentModelSettings> {
    const stored = await storedKey(selection);
    const apiKey =
      stored ??
      (modelAdapter
        ? undefined
        : resolveEnvironmentModelApiKey(selection.provider, selection.baseURL, env));
    const environmentURL =
      selection.provider === "openai"
        ? env.OPENAI_BASE_URL?.trim()
        : env.ANTHROPIC_BASE_URL?.trim();
    const requestedURL = selection.baseURL ?? (stored ? undefined : environmentURL || undefined);
    const effectiveURL = requestedURL || OFFICIAL_MODEL_BASE_URLS[selection.provider];
    // A missing key is diagnosed by the service when it is actually used.
    const baseURL = apiKey
      ? normalizeCredentialUrl(effectiveURL)
      : selection.baseURL || OFFICIAL_MODEL_BASE_URLS[selection.provider];
    let openaiApiMode = selection.openaiApiMode;
    if (selection.provider === "openai" && !openaiApiMode) {
      const configured = stored ? undefined : env.OPENAI_API_MODE?.trim().toLowerCase();
      if (configured && configured !== "responses" && configured !== "chat-completions" && apiKey) {
        throw new Error("Unsupported OPENAI_API_MODE. Expected responses or chat-completions.");
      }
      openaiApiMode =
        configured === "responses" || configured === "chat-completions"
          ? configured
          : requestedURL
            ? "chat-completions"
            : "responses";
    }
    return {
      ...selection,
      baseURL,
      ...(selection.provider === "openai" ? { openaiApiMode } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  }
  return {
    loadExecutionPlan: (modelId, reasoningEffort) =>
      exclusive(async () => {
        const settings = await settingsStore.get();
        if (!settings) throw new Error("Execution settings have not been initialized.");
        const model = resolveConfiguredModel(settings, modelId);
        const modelAdapter: ModelAdapterId | undefined =
          settings.vendors.find((vendor) => vendor.id === model.vendorId)?.kind ===
          "mimo-token-plan-cn"
            ? "mimo-token-plan-cn"
            : undefined;
        if (reasoningEffort !== undefined) {
          if (modelAdapter || !getModelReasoningEfforts(model).includes(reasoningEffort))
            throw new Error("Unsupported reasoning effort for the selected model.");
          model.reasoningEffort = reasoningEffort;
        }
        const env = { ...environment };
        const fallbackId = settings.gateway.fallbackModelId;
        const fallbackEnabled = settings.vendors.some(
          (vendor) =>
            vendor.enabled &&
            vendor.models.some((entry) => entry.id === fallbackId && entry.enabled),
        );
        let fallbackModel =
          fallbackId && fallbackEnabled ? resolveConfiguredModel(settings, fallbackId) : undefined;
        if (
          fallbackModel &&
          settings.vendors.some(
            (vendor) =>
              vendor.kind === "mimo-token-plan-cn" &&
              vendor.models.some((entry) => entry.id === fallbackId),
          )
        ) {
          if (!modelAdapter)
            throw new Error("The legacy gateway cannot use a native MiMo fallback model.");
          fallbackModel = undefined;
        }
        if (modelAdapter) fallbackModel = undefined;
        if (!modelAdapter && !fallbackModel) {
          const provider = env.AGENT_FALLBACK_PROVIDER?.trim().toLowerCase();
          const fallbackName = env.AGENT_FALLBACK_MODEL?.trim();
          if ((provider === "openai" || provider === "anthropic") && fallbackName)
            fallbackModel = { provider, model: fallbackName };
        }
        if (
          fallbackModel &&
          model.provider === fallbackModel.provider &&
          model.model === fallbackModel.model &&
          (!fallbackModel.configurationId ||
            model.configurationId === fallbackModel.configurationId)
        )
          fallbackModel = undefined;
        const { fallbackModelId: _fallbackId, ...services } = settings.gateway;
        const plan: ExecutionPlan = {
          ...(modelAdapter ? { modelAdapter } : {}),
          model,
          services: { ...services, ...(fallbackModel ? { fallbackModel } : {}) },
          stepLimits: settings.stepLimits,
          executionStrategy: settings.executionStrategy,
          defaultTemplateId: settings.defaultTemplateId,
        };
        plans.set(plan, { plan: structuredClone(plan), environment: env });
        return plan;
      }),
    resolveRuntime: (input) =>
      exclusive(async () => {
        const issued = plans.get(input);
        if (!issued)
          throw new Error("Execution plan was not created by this configuration runtime.");
        const { plan, environment: env } = issued;
        const primary = await resolveModel(plan.model, env, plan.modelAdapter);
        const fallbackModel = plan.services.fallbackModel
          ? await resolveModel(plan.services.fallbackModel, env)
          : undefined;
        const requestedEndpoint = plan.services.webSearchEndpoint?.trim();
        const storedEndpoint = requestedEndpoint || DEFAULT_WEB_SEARCH_ENDPOINT;
        let storedSearchKey: string | undefined;
        try {
          storedSearchKey = await credentials.resolveWebSearchCredential({
            endpoint: storedEndpoint,
          });
        } catch (error) {
          if (!(error instanceof CredentialStoreError && error.code === "STORAGE_UNAVAILABLE"))
            throw error;
        }
        const webSearchApiKey =
          storedSearchKey ?? resolveEnvironmentWebSearchApiKey(requestedEndpoint, env);
        const effectiveEndpoint =
          requestedEndpoint ||
          (storedSearchKey ? undefined : env.TAVILY_SEARCH_ENDPOINT?.trim()) ||
          DEFAULT_WEB_SEARCH_ENDPOINT;
        const webSearchEndpoint = webSearchApiKey
          ? normalizeCredentialUrl(effectiveEndpoint)
          : storedEndpoint;
        return {
          ...(plan.modelAdapter ? { modelAdapter: plan.modelAdapter } : {}),
          primary,
          gateway: {
            timeoutMs: plan.services.timeoutMs,
            maxOutputTokens: plan.services.maxOutputTokens,
            ...(fallbackModel ? { fallbackModel } : {}),
          },
          search: {
            webSearchEndpoint,
            ...(webSearchApiKey ? { webSearchApiKey } : {}),
            ...(plan.services.webSearchTimeoutMs
              ? { webSearchTimeoutMs: plan.services.webSearchTimeoutMs }
              : {}),
          },
        };
      }),
  };
}
