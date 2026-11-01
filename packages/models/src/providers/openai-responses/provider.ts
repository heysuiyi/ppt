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
  ModelProvider,
  OpenAIResponsesOptions,
} from "../../model-contract.js";
import type { ModelProviderError } from "../../model-errors.js";
import { error, object, outputBudget, safeError } from "./errors.js";
import { ADAPTER_ID, capabilities, REASONING_EFFORTS, support, validModelId } from "./profile.js";
import { requestBody, responseProjection } from "./responses.js";
import { ResponsesStreamProjection } from "./stream.js";

interface Owner {
  readonly controller: AbortController;
  readonly pending: Set<Promise<void>>;
  closed: boolean;
}
interface Operation {
  readonly signal: AbortSignal;
  readonly serverId: (value: string | null) => void;
  readonly finish: (failure?: ModelProviderError, response?: ModelResponse) => void;
}
function owner(): Owner {
  return { controller: new AbortController(), pending: new Set(), closed: false };
}
async function close(value: Owner): Promise<void> {
  value.closed = true;
  value.controller.abort(error("CLOSED"));
  await Promise.allSettled([...value.pending]);
}

export function createOpenAIResponses(options: OpenAIResponsesOptions): ModelProvider {
  const budget = outputBudget(options.maxOutputTokens);
  const timeoutMs = options.timeoutMs;
  const fingerprint = options.connectionFingerprint;
  const logger = options.logger;
  // SDK 原生日志可能包含正文、凭据或错误对象，诊断只能经过本适配器的静态边界。
  let sdk: OpenAI | undefined = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
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
    if (provider.closed || binding?.closed || !sdk) throw error("CLOSED");
    const timeout = new AbortController();
    const started = performance.now();
    let timer: NodeJS.Timeout;
    const tick = (): void => {
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) timeout.abort(error("TIMEOUT"));
      else timer = setTimeout(tick, Math.min(remaining, 2147483647));
    };
    timer = setTimeout(tick, Math.min(timeoutMs, 2147483647));
    const combined = AbortSignal.any([
      signal,
      provider.controller.signal,
      timeout.signal,
      ...(binding ? [binding.controller.signal] : []),
    ]);
    const pending = Promise.withResolvers<void>();
    provider.pending.add(pending.promise);
    binding?.pending.add(pending.promise);
    let log: Logger | undefined;
    try {
      log = context
        ? logger?.child({ ...context.identity, requestId: context.requestId, step: context.step })
        : logger;
    } catch {
      /* 日志失败不能改变调用语义。 */
    }
    const metadata = {
      providerId: ADAPTER_ID,
      ...(selection
        ? { modelId: selection.modelId, reasoningEffort: selection.reasoningEffort }
        : {}),
      operation: selection ? "responses" : "models",
    };
    const record = (event: string, extra?: Record<string, unknown>): void => {
      try {
        log?.info(event, { ...metadata, ...extra });
      } catch {
        /* 借用的日志不影响调用。 */
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
      finish(failure, response) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        record(
          failure
            ? failure.code === "CANCELLED" || failure.code === "CLOSED"
              ? "request.cancelled"
              : "request.failed"
            : "request.completed",
          {
            durationMs: Math.max(0, performance.now() - started),
            ...(serverRequestId ? { serverRequestId } : {}),
            ...(failure
              ? { code: failure.code }
              : { status: response?.finishReason ?? "completed" }),
            ...(response?.usage
              ? {
                  inputTokens: response.usage.inputTokens,
                  outputTokens: response.usage.outputTokens,
                }
              : {}),
          },
        );
        provider.pending.delete(pending.promise);
        binding?.pending.delete(pending.promise);
        pending.resolve();
      },
    };
  }
  return {
    adapterId: ADAPTER_ID,
    discovery: {
      async listModels(signal) {
        const operation = begin(signal);
        try {
          operation.signal.throwIfAborted();
          const response = await sdk!.models.list({ signal: operation.signal }).asResponse();
          operation.serverId(response.headers.get("x-request-id"));
          const raw = object(await response.json());
          operation.signal.throwIfAborted();
          if (!Array.isArray(raw.data) || raw.data.length > 2000) throw error("INVALID_RESPONSE");
          const seen = new Set<string>();
          const result: DiscoveredModel[] = [];
          for (const value of raw.data) {
            const model = object(value);
            if (!validModelId(model.id)) throw error("INVALID_RESPONSE");
            if (seen.has(model.id)) continue;
            seen.add(model.id);
            const supported = support(model.id);
            result.push({
              id: model.id,
              supported: supported.supported,
              ...(supported.supported ? {} : { unsupportedReason: supported.unsupportedReason }),
            });
          }
          operation.finish();
          return result;
        } catch (value) {
          const safe = safeError(value, operation.signal);
          operation.finish(safe);
          throw safe;
        }
      },
    },
    async create(selection, signal): Promise<ModelBinding> {
      if (provider.closed) throw error("CLOSED");
      if (signal.aborted) throw error("CANCELLED");
      if (
        selection.providerId !== ADAPTER_ID ||
        !validModelId(selection.modelId) ||
        (selection.reasoningEffort !== undefined &&
          !REASONING_EFFORTS.some((effort) => effort === selection.reasoningEffort))
      )
        throw error("CONFIGURATION");
      const selected: ModelSelection = Object.freeze({
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
          capabilities,
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
            } catch (value) {
              const safe = safeError(value, operation.signal);
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
            // 网络泵不依赖消费者继续 next()，暂停迭代时 dispose 仍能取消和排空网络请求。
            const pump = (async (): Promise<void> => {
              try {
                operation.signal.throwIfAborted();
                const body = requestBody(request, selected, fingerprint, budget);
                const { data: stream, response } = await sdk!.responses
                  .create({ ...body, stream: true }, { signal: operation.signal })
                  .withResponse();
                operation.serverId(response.headers.get("x-request-id"));
                const projection = new ResponsesStreamProjection();
                for await (const event of stream) {
                  operation.signal.throwIfAborted();
                  for (const delta of projection.accept(event)) push(delta);
                }
                operation.signal.throwIfAborted();
                const result = responseProjection(projection.finish(), selected, fingerprint);
                push({ type: "completed", response: result });
                operation.finish(undefined, result);
              } catch (value) {
                failure =
                  value instanceof TypeError && !operation.signal.aborted
                    ? error("INCOMPLETE_STREAM")
                    : safeError(value, operation.signal);
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
                  operation.signal.throwIfAborted();
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
            } catch (value) {
              throw safeError(value, operation.signal);
            } finally {
              consumer.abort(error("CANCELLED"));
              await pump;
            }
          },
        },
        dispose() {
          disposing ??= close(binding).finally(() => {
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
          await Promise.all([close(provider), ...[...bindings].map(close)]);
          bindings.clear();
          sdk = undefined;
        })();
      }
      return closing;
    },
  };
}
