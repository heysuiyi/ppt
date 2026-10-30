import { createHash } from "node:crypto";
import type {
  ModelBinding,
  ModelClientFactory,
  ModelSelection,
  ModelStreamEvent,
} from "../../agent/model/model-contract";
import { AgentError, sameValue, snapshot } from "../../agent/protocol-utils";
import type { Disposable } from "../../agent/protocol-values";
import type { AgentModelSettings } from "../../shared/agent";
import { getEffectiveMainMaxSteps } from "../../shared/agent-step-limits";
import { AgentGateway } from "../agent/gateway";
import { withLogContext } from "../agent/logger";
import type { AgentConfiguration } from "../agent-configuration";
import { createGatewayModelFactory } from "./gateway-model-factory";

export interface PreparedConfiguredModel extends Disposable {
  readonly models: ModelClientFactory;
  readonly selection: ModelSelection;
  readonly connectionFingerprint: string;
  readonly maxSteps: number;
}

/** 只绑定已签发计划的主模型；凭据、搜索和备用模型均不进入通用内核。 */
export async function prepareConfiguredModel(
  runtime: AgentConfiguration["runtime"],
  configuredModelId: string,
  signal: AbortSignal,
): Promise<PreparedConfiguredModel> {
  signal.throwIfAborted();
  let settings: AgentModelSettings | undefined;
  let timeoutMs: number;
  let maxOutputTokens: number;
  let maxSteps: number;
  try {
    // resolveRuntime 用 WeakMap 识别计划；必须传回原对象，不能 JSON 重建。
    const plan = await runtime.loadExecutionPlan(configuredModelId);
    signal.throwIfAborted();
    const resolved = await runtime.resolveRuntime(plan);
    signal.throwIfAborted();
    settings = { ...resolved.primary };
    timeoutMs = resolved.gateway.timeoutMs;
    maxOutputTokens = resolved.gateway.maxOutputTokens;
    maxSteps = getEffectiveMainMaxSteps(plan.stepLimits);
  } catch {
    signal.throwIfAborted();
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
  const callPath =
    settings.provider === "anthropic"
      ? "anthropic"
      : settings.openaiApiMode === "chat-completions"
        ? "chat"
        : "responses";
  const connectionFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        configuredModelId,
        provider: settings.provider,
        model: settings.model,
        configurationId: settings.configurationId ?? null,
        vendorId: settings.vendorId ?? null,
        baseURL: settings.baseURL ?? null,
        callPath,
        supports1MContext: settings.supports1MContext ?? false,
      }),
    )
    .digest("hex");
  const selection: ModelSelection = Object.freeze({
    providerId: "configured-gateway",
    modelId: configuredModelId,
  });
  const lifetime = new AbortController();
  const gateways = new Set<AgentGateway>();
  let disposed = false;
  const delegate = createGatewayModelFactory((requested, bindingSignal) => {
    bindingSignal.throwIfAborted();
    if (disposed || !settings) throw new AgentError("MODEL_FACTORY_CLOSED", "模型工厂已关闭。");
    if (!sameValue(requested, selection))
      throw new AgentError("MODEL_SELECTION_CHANGED", "模型绑定与已准备配置不一致。");
    const gateway = new AgentGateway();
    const legacy = gateway.configure(settings, { timeoutMs, maxOutputTokens });
    gateways.add(gateway);
    return {
      gateway,
      selection: {
        ...legacy,
        ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
        ...(settings.openaiApiMode ? { openaiApiMode: settings.openaiApiMode } : {}),
      },
      // 本入口只承诺文本与工具；旧网关不能提供规范索引的实时增量。
      capabilities: { streaming: false, toolCalls: true, images: false, reasoning: true },
      callPath,
      replayScope: connectionFingerprint,
      async dispose() {
        gateway.clearPrimarySettings();
        gateways.delete(gateway);
      },
    };
  });
  return {
    selection,
    connectionFingerprint,
    maxSteps,
    models: {
      async create(requested, bindingSignal): Promise<ModelBinding> {
        if (disposed) throw new AgentError("MODEL_FACTORY_CLOSED", "模型工厂已关闭。");
        const combined = AbortSignal.any([bindingSignal, lifetime.signal]);
        const binding = await delegate.create(snapshot(requested), combined);
        return {
          dispose: () => binding.dispose(),
          client: {
            get selection() {
              return binding.client.selection;
            },
            get capabilities() {
              return binding.client.capabilities;
            },
            generate: (request, requestSignal) =>
              withLogContext({ console: false }, () =>
                binding.client.generate(request, requestSignal),
              ),
            async *stream(request, requestSignal): AsyncGenerator<ModelStreamEvent> {
              const iterator = binding.client
                .stream(request, requestSignal)
                [Symbol.asyncIterator]();
              try {
                while (true) {
                  const next = await withLogContext({ console: false }, () => iterator.next());
                  if (next.done) return;
                  yield next.value;
                }
              } finally {
                await withLogContext({ console: false }, () => iterator.return?.());
              }
            },
          },
        };
      },
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      for (const gateway of gateways) gateway.clearPrimarySettings();
      gateways.clear();
      settings = undefined;
    },
  };
}
