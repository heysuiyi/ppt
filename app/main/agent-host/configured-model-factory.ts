import { createHash } from "node:crypto";
import type {
  ModelBinding,
  ModelClientFactory,
  ModelSelection,
} from "@agent-harness/core/model/model-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import { type Disposable, sameValue } from "@agent-harness/core/protocol-values";
import type { Logger } from "@agent-harness/logs/log-contract";
import type { ModelAdapterId, ModelProvider } from "@agent-harness/models/model-contract";
import { ModelProviderError } from "@agent-harness/models/model-errors";
import { getModelProfile } from "@agent-harness/models/model-profiles";
import { createModelProvider } from "@agent-harness/models/models";
import type { AgentModelSelection, AgentModelSettings } from "../../../src/shared/agent";
import { getEffectiveMainMaxSteps } from "../../../src/shared/agent-step-limits";
import type { AgentConfiguration } from "../agent-configuration";

export interface PreparedConfiguredModel extends Disposable {
  readonly models: ModelClientFactory;
  readonly selection: ModelSelection;
  readonly connectionFingerprint: string;
  readonly maxSteps: number;
}

/** 宿主用同一连接身份关联已存会话；不解析凭据，也不创建模型客户端。 */
export function configuredModelFingerprint(
  configuredModelId: string,
  model: AgentModelSelection,
  maxOutputTokens: number,
): string {
  const profile = getModelProfile("mimo-token-plan-cn");
  if (profile?.endpoint?.kind !== "fixed")
    throw new AgentError("MODEL_CONFIGURATION_FAILED", "MiMo 必须使用固定 CN Responses 连接。");
  return createHash("sha256")
    .update(
      JSON.stringify({
        adapter: profile.adapterId,
        replayVersion: 1,
        baseURL: profile.endpoint.url,
        configuredModelId,
        configurationId: model.configurationId ?? null,
        vendorId: model.vendorId ?? null,
        model: model.model,
        reasoningEffort: model.reasoningEffort ?? null,
        maxOutputTokens,
      }),
    )
    .digest("hex");
}

// 只转换适配器已脱敏的具名错误，未知异常仍由通用执行边界隐藏。
function modelProviderAgentError(error: unknown): unknown {
  return error instanceof ModelProviderError ? new AgentError(error.code, error.message) : error;
}

/** 只绑定已签发计划的主模型；凭据、搜索和备用模型均不进入通用内核。 */
export async function prepareConfiguredModel(
  runtime: AgentConfiguration["runtime"],
  configuredModelId: string,
  signal: AbortSignal,
  logger?: Logger,
): Promise<PreparedConfiguredModel> {
  signal.throwIfAborted();
  let settings: AgentModelSettings | undefined;
  let timeoutMs: number;
  let maxOutputTokens: number;
  let maxSteps: number;
  let modelAdapter: ModelAdapterId | undefined;
  try {
    // resolveRuntime 用 WeakMap 识别计划；必须传回原对象，不能 JSON 重建。
    const plan = await runtime.loadExecutionPlan(configuredModelId);
    signal.throwIfAborted();
    // 先检查签发的适配器身份，不为不支持的配置解析凭据或创建旧执行路径。
    if (!plan.modelAdapter || !getModelProfile(plan.modelAdapter)) {
      throw new AgentError(
        "MODEL_ADAPTER_UNSUPPORTED",
        "所选模型尚无可用的原生适配器，请选择已接入的原生模型配置。",
      );
    }
    const resolved = await runtime.resolveRuntime(plan);
    signal.throwIfAborted();
    settings = { ...resolved.primary };
    modelAdapter = resolved.modelAdapter;
    timeoutMs = resolved.gateway.timeoutMs;
    maxOutputTokens = resolved.gateway.maxOutputTokens;
    maxSteps = getEffectiveMainMaxSteps(plan.stepLimits);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AgentError && error.code === "MODEL_ADAPTER_UNSUPPORTED") throw error;
    throw new AgentError(
      "MODEL_CONFIGURATION_FAILED",
      "无法解析已配置模型，请在应用设置中检查模型与凭据。",
    );
  }
  if (!settings.apiKey?.trim()) {
    throw new AgentError(
      "MODEL_CREDENTIAL_MISSING",
      "所选模型没有可用凭据，请先在应用设置中配置。",
    );
  }
  const profile = modelAdapter ? getModelProfile(modelAdapter) : undefined;
  if (profile) {
    if (
      profile.protocol !== "openai-responses" ||
      profile.endpoint?.kind !== "fixed" ||
      settings.provider !== "openai" ||
      settings.openaiApiMode !== "responses" ||
      settings.baseURL !== profile.endpoint.url
    ) {
      throw new AgentError("MODEL_CONFIGURATION_FAILED", "MiMo 必须使用固定 CN Responses 连接。");
    }
    const selection: ModelSelection = Object.freeze({
      providerId: profile.adapterId,
      modelId: settings.model,
      ...(settings.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: settings.reasoningEffort }),
    });
    const connectionFingerprint = configuredModelFingerprint(
      configuredModelId,
      settings,
      maxOutputTokens,
    );
    let provider: ModelProvider | undefined;
    try {
      provider = await createModelProvider(
        {
          adapterId: profile.adapterId,
          apiKey: settings.apiKey,
          connectionFingerprint,
          timeoutMs,
          maxOutputTokens,
          ...(logger ? { logger } : {}),
        },
        signal,
      );
      signal.throwIfAborted();
    } catch (error) {
      await provider?.dispose();
      throw modelProviderAgentError(error);
    }
    settings = undefined;
    const preparedProvider = provider;
    return {
      selection,
      connectionFingerprint,
      maxSteps,
      models: {
        async create(requested, bindingSignal): Promise<ModelBinding> {
          if (!sameValue(requested, selection))
            throw new AgentError("MODEL_SELECTION_CHANGED", "模型绑定与已准备配置不一致。");
          try {
            const binding = await preparedProvider.create(requested, bindingSignal);
            return {
              dispose: () => binding.dispose(),
              client: {
                selection: binding.client.selection,
                capabilities: binding.client.capabilities,
                async generate(request, requestSignal, context) {
                  try {
                    return await binding.client.generate(request, requestSignal, context);
                  } catch (error) {
                    throw modelProviderAgentError(error);
                  }
                },
                async *stream(request, requestSignal, context) {
                  try {
                    yield* binding.client.stream(request, requestSignal, context);
                  } catch (error) {
                    throw modelProviderAgentError(error);
                  }
                },
              },
            };
          } catch (error) {
            throw modelProviderAgentError(error);
          }
        },
      },
      dispose: () => preparedProvider.dispose(),
    };
  }
  throw new AgentError("MODEL_ADAPTER_UNSUPPORTED", "运行配置没有可用的原生模型适配器。");
}
