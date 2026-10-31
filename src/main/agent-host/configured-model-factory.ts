import { createHash } from "node:crypto";
import type {
  ModelBinding,
  ModelClientFactory,
  ModelSelection,
} from "@agent-ppt/harness/model/model-contract";
import { AgentError } from "@agent-ppt/harness/protocol-errors";
import { type Disposable, sameValue } from "@agent-ppt/harness/protocol-values";
import type { Logger } from "../../logs/log-contract";
import { createMimoTokenPlanCN, MimoModelError } from "../../models/mimo-token-plan-cn";
import {
  MIMO_TOKEN_PLAN_CN_BASE_URL,
  MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
  type MimoTokenPlanCN,
} from "../../models/mimo-token-plan-cn-contract";
import type { AgentModelSelection, AgentModelSettings } from "../../shared/agent";
import { getEffectiveMainMaxSteps } from "../../shared/agent-step-limits";
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
  return createHash("sha256")
    .update(
      JSON.stringify({
        adapter: MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
        replayVersion: 1,
        baseURL: MIMO_TOKEN_PLAN_CN_BASE_URL,
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
function mimoAgentError(error: unknown): unknown {
  return error instanceof MimoModelError ? new AgentError(error.code, error.message) : error;
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
  let modelAdapter: "mimo-token-plan-cn" | undefined;
  try {
    // resolveRuntime 用 WeakMap 识别计划；必须传回原对象，不能 JSON 重建。
    const plan = await runtime.loadExecutionPlan(configuredModelId);
    signal.throwIfAborted();
    // 先检查签发的适配器身份，不为不支持的配置解析凭据或创建旧执行路径。
    if (plan.modelAdapter !== MIMO_TOKEN_PLAN_CN_PROVIDER_ID) {
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
  if (modelAdapter === MIMO_TOKEN_PLAN_CN_PROVIDER_ID) {
    if (
      settings.provider !== "openai" ||
      settings.openaiApiMode !== "responses" ||
      settings.baseURL !== MIMO_TOKEN_PLAN_CN_BASE_URL
    ) {
      throw new AgentError("MODEL_CONFIGURATION_FAILED", "MiMo 必须使用固定 CN Responses 连接。");
    }
    const selection: ModelSelection = Object.freeze({
      providerId: MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
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
    let provider: MimoTokenPlanCN;
    try {
      provider = createMimoTokenPlanCN({
        apiKey: settings.apiKey,
        connectionFingerprint,
        timeoutMs,
        maxOutputTokens,
        ...(logger ? { logger } : {}),
      });
    } catch (error) {
      throw mimoAgentError(error);
    }
    settings = undefined;
    return {
      selection,
      connectionFingerprint,
      maxSteps,
      models: {
        async create(requested, bindingSignal): Promise<ModelBinding> {
          if (!sameValue(requested, selection))
            throw new AgentError("MODEL_SELECTION_CHANGED", "模型绑定与已准备配置不一致。");
          try {
            const binding = await provider.create(requested, bindingSignal);
            return {
              dispose: () => binding.dispose(),
              client: {
                selection: binding.client.selection,
                capabilities: binding.client.capabilities,
                async generate(request, requestSignal, context) {
                  try {
                    return await binding.client.generate(request, requestSignal, context);
                  } catch (error) {
                    throw mimoAgentError(error);
                  }
                },
                async *stream(request, requestSignal, context) {
                  try {
                    yield* binding.client.stream(request, requestSignal, context);
                  } catch (error) {
                    throw mimoAgentError(error);
                  }
                },
              },
            };
          } catch (error) {
            throw mimoAgentError(error);
          }
        },
      },
      dispose: () => provider.dispose(),
    };
  }
  throw new AgentError("MODEL_ADAPTER_UNSUPPORTED", "运行配置没有可用的原生模型适配器。");
}
