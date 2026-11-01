import type {
  ModelBinding,
  ModelCallContext,
  ModelResponse,
  ModelSelection,
  ModelStreamEvent,
} from "@agent-harness/core/model/model-contract";
import type { Logger } from "@agent-harness/logs/log-contract";
import OpenAI from "openai";
import type {
  DiscoveredModel,
  MimoTokenPlanCNOptions,
  ModelProvider,
} from "../../model-contract.js";
import type { ModelProviderError } from "../../model-errors.js";
import { mimoError, modelError, object, outputBudget } from "./errors.js";
import {
  MIMO_REASONING_EFFORTS,
  MIMO_TOKEN_PLAN_CN_BASE_URL,
  MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
  mimoCapabilities,
  mimoSupport,
} from "./profile.js";
import { requestBody, responseProjection } from "./responses.js";
import { MimoStreamProjection } from "./stream.js";

interface Owner {
  readonly controller: AbortController;
  readonly pending: Set<Promise<void>>;
  closed: boolean;
}
interface Operation {
  readonly signal: AbortSignal;
  readonly finish: (error?: ModelProviderError, response?: ModelResponse) => void;
  readonly serverId: (value: string | null) => void;
}

function owner(): Owner {
  return { controller: new AbortController(), pending: new Set(), closed: false };
}

async function closeOwner(value: Owner): Promise<void> {
  value.closed = true;
  value.controller.abort(mimoError("CLOSED"));
  await Promise.allSettled([...value.pending]);
}

function validModelId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length >= 1 &&
    id.length <= 256 &&
    id.trim() === id &&
    !/[\s\x00-\x1f\x7f]/u.test(id)
  );
}

/** 固定中国 Token Plan 地址；凭据与 SDK 生命周期由该实例拥有。 */
export function createMimoTokenPlanCN(options: MimoTokenPlanCNOptions): ModelProvider {
  if (
    typeof options.apiKey !== "string" ||
    !options.apiKey.trim() ||
    typeof options.connectionFingerprint !== "string" ||
    !options.connectionFingerprint.trim() ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0
  ) {
    throw mimoError("CONFIGURATION");
  }
  const budget = outputBudget(options.maxOutputTokens);
  const timeoutMs = options.timeoutMs;
  const fingerprint = options.connectionFingerprint;
  const logger = options.logger;
  // 禁止 SDK 自行输出正文或原生异常，包括畸形 SSE 的解析日志。
  let sdk: OpenAI | undefined = new OpenAI({
    apiKey: options.apiKey,
    baseURL: MIMO_TOKEN_PLAN_CN_BASE_URL,
    timeout: timeoutMs,
    maxRetries: 0,
    logLevel: "off",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const provider = owner();
  const bindings = new Set<Owner>();
  let closing: Promise<void> | undefined;

  function begin(
    signal: AbortSignal,
    binding?: Owner,
    selection?: ModelSelection,
    context?: ModelCallContext,
  ): Operation {
    if (provider.closed || binding?.closed || !sdk) throw mimoError("CLOSED");
    const timerController = new AbortController();
    const start = performance.now();
    let timer: NodeJS.Timeout;
    const tick = (): void => {
      const remaining = timeoutMs - (performance.now() - start);
      if (remaining <= 0) timerController.abort(mimoError("TIMEOUT"));
      else timer = setTimeout(tick, Math.min(remaining, 2147483647));
    };
    timer = setTimeout(tick, Math.min(timeoutMs, 2147483647));
    const combined = AbortSignal.any([
      signal,
      provider.controller.signal,
      timerController.signal,
      ...(binding ? [binding.controller.signal] : []),
    ]);
    const { promise: pending, resolve: complete } = Promise.withResolvers<void>();
    provider.pending.add(pending);
    binding?.pending.add(pending);
    let log: Logger | undefined;
    try {
      log = context
        ? logger?.child({ ...context.identity, requestId: context.requestId, step: context.step })
        : logger;
    } catch {
      /* 借用的诊断输出失败不能改变模型调用。 */
    }
    const data = {
      providerId: MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
      ...(selection
        ? { modelId: selection.modelId, reasoningEffort: selection.reasoningEffort }
        : {}),
      operation: selection ? "responses" : "models",
    };
    const record = (event: string, extra?: Record<string, unknown>): void => {
      try {
        log?.info(event, { ...data, ...extra });
      } catch {
        /* 诊断不影响请求结果。 */
      }
    };
    record("request.started");
    let serverRequestId: string | undefined;
    let finished = false;
    return {
      signal: combined,
      serverId(value) {
        if (value && /^req[-_a-zA-Z0-9]{1,120}$/u.test(value)) serverRequestId = value;
      },
      finish(error, response) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        record(
          error
            ? error.code === "CANCELLED" || error.code === "CLOSED"
              ? "request.cancelled"
              : "request.failed"
            : "request.completed",
          {
            durationMs: Math.max(0, performance.now() - start),
            ...(serverRequestId ? { serverRequestId } : {}),
            ...(error ? { code: error.code } : { status: response?.finishReason ?? "completed" }),
            ...(response?.usage
              ? {
                  inputTokens: response.usage.inputTokens,
                  outputTokens: response.usage.outputTokens,
                }
              : {}),
          },
        );
        provider.pending.delete(pending);
        binding?.pending.delete(pending);
        complete();
      },
    };
  }

  return {
    adapterId: MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
    discovery: {
      async listModels(signal) {
        const operation = begin(signal);
        try {
          operation.signal.throwIfAborted();
          // Page 会把缺失 data 归一化为空数组；在 SDK 原始响应边界校验厂商协议。
          const response = await sdk!.models.list({ signal: operation.signal }).asResponse();
          operation.serverId(response.headers.get("x-request-id"));
          const page = object(await response.json());
          operation.signal.throwIfAborted();
          if (!Array.isArray(page.data) || page.data.length > 2000)
            throw mimoError("INVALID_RESPONSE");
          const ids = new Set<string>();
          const result: DiscoveredModel[] = [];
          for (const value of page.data) {
            const model = object(value);
            if (!validModelId(model.id)) throw mimoError("INVALID_RESPONSE");
            if (ids.has(model.id)) continue;
            ids.add(model.id);
            const support = mimoSupport(model.id);
            result.push({
              id: model.id,
              supported: support.supported,
              ...(support.supported ? {} : { unsupportedReason: support.unsupportedReason }),
            });
          }
          operation.finish();
          return result;
        } catch (error) {
          const safe = modelError(error, operation.signal);
          operation.finish(safe);
          throw safe;
        }
      },
    },
    async create(selection, signal): Promise<ModelBinding> {
      if (provider.closed) throw mimoError("CLOSED");
      if (signal.aborted) throw mimoError("CANCELLED");
      if (
        selection.providerId !== MIMO_TOKEN_PLAN_CN_PROVIDER_ID ||
        !validModelId(selection.modelId) ||
        (selection.reasoningEffort !== undefined &&
          !MIMO_REASONING_EFFORTS.some((effort) => effort === selection.reasoningEffort))
      ) {
        throw mimoError("CONFIGURATION");
      }
      if (!mimoSupport(selection.modelId).supported) throw mimoError("MODEL_CAPABILITY");
      const selected = Object.freeze({
        providerId: selection.providerId,
        modelId: selection.modelId,
        ...(selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort }),
      });
      const binding = owner();
      bindings.add(binding);
      const lifetime = AbortSignal.any([signal, binding.controller.signal]);
      let disposing: Promise<void> | undefined;
      return {
        client: {
          selection: selected,
          capabilities: mimoCapabilities,
          async generate(request, requestSignal, context) {
            const operation = begin(
              AbortSignal.any([requestSignal, lifetime]),
              binding,
              selected,
              context,
            );
            try {
              operation.signal.throwIfAborted();
              const body = requestBody(request, selected, fingerprint, budget);
              const { data, response } = await sdk!.responses
                .create(body, { signal: operation.signal })
                .withResponse();
              operation.serverId(response.headers.get("x-request-id"));
              operation.signal.throwIfAborted();
              const result = responseProjection(data, selected, fingerprint);
              operation.finish(undefined, result);
              return result;
            } catch (error) {
              const safe = modelError(error, operation.signal);
              operation.finish(safe);
              throw safe;
            }
          },
          async *stream(request, requestSignal, context): AsyncGenerator<ModelStreamEvent> {
            const consumer = new AbortController();
            const operation = begin(
              AbortSignal.any([requestSignal, lifetime, consumer.signal]),
              binding,
              selected,
              context,
            );
            const queue: ModelStreamEvent[] = [];
            let offset = 0;
            let ended = false;
            let failure: ModelProviderError | undefined;
            let notify: (() => void) | undefined;
            const push = (event: ModelStreamEvent): void => {
              queue.push(event);
              notify?.();
              notify = undefined;
            };
            // 网络泵独立于消费者的 yield：关闭可以取消并排空暂停中的迭代器。
            const pump = (async (): Promise<void> => {
              try {
                operation.signal.throwIfAborted();
                const body = requestBody(request, selected, fingerprint, budget);
                const { data: stream, response } = await sdk!.responses
                  .create({ ...body, stream: true }, { signal: operation.signal })
                  .withResponse();
                operation.serverId(response.headers.get("x-request-id"));
                const projection = new MimoStreamProjection();
                for await (const event of stream) {
                  operation.signal.throwIfAborted();
                  for (const delta of projection.accept(event)) push(delta);
                }
                operation.signal.throwIfAborted();
                const result = responseProjection(projection.finish(), selected, fingerprint);
                push({ type: "completed", response: result });
                operation.finish(undefined, result);
              } catch (error) {
                failure =
                  error instanceof TypeError && !operation.signal.aborted
                    ? mimoError("INCOMPLETE_STREAM")
                    : modelError(error, operation.signal);
                operation.finish(failure);
              } finally {
                ended = true;
                notify?.();
                notify = undefined;
              }
            })();
            try {
              while (true) {
                if (offset < queue.length) {
                  const event = queue[offset++];
                  if (offset === queue.length) {
                    queue.length = 0;
                    offset = 0;
                  }
                  if (event.type === "completed") operation.signal.throwIfAborted();
                  yield event;
                } else if (ended) {
                  if (failure) throw failure;
                  break;
                } else {
                  const wake = Promise.withResolvers<void>();
                  notify = wake.resolve;
                  await wake.promise;
                }
              }
            } catch (error) {
              throw modelError(error, operation.signal);
            } finally {
              consumer.abort(mimoError("CANCELLED"));
              await pump;
            }
          },
        },
        dispose() {
          disposing ??= closeOwner(binding).finally(() => {
            bindings.delete(binding);
          });
          return disposing;
        },
      };
    },
    dispose() {
      if (!closing) {
        provider.closed = true;
        closing = (async () => {
          await Promise.all([closeOwner(provider), ...[...bindings].map(closeOwner)]);
          bindings.clear();
          // 释放本实例所持 SDK/凭据；不承诺擦除 JS 堆中的全部字符串副本。
          sdk = undefined;
        })();
      }
      return closing;
    },
  };
}
