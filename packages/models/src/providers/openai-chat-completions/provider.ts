import type {
  ModelBinding,
  ModelCallContext,
  ModelResponse,
  ModelSelection,
  ModelStreamEvent,
} from "@agent-harness/core/model/model-contract";
import OpenAI from "openai";
import type { DiscoveredModel, ModelProvider, OpenAIChatOptions } from "../../model-contract.js";
import type { ModelProviderError } from "../../model-errors.js";
import { chatError, modelError, object, outputBudget } from "./errors.js";
import { requestBody, responseProjection } from "./messages.js";
import { ADAPTER_ID, capabilities, support, validModelId } from "./profile.js";
import { ChatStreamProjection } from "./stream.js";

interface Owner {
  readonly controller: AbortController;
  readonly pending: Set<Promise<void>>;
  closed: boolean;
}
function owner(): Owner {
  return { controller: new AbortController(), pending: new Set(), closed: false };
}
async function closeOwner(value: Owner): Promise<void> {
  value.closed = true;
  value.controller.abort(chatError("CLOSED"));
  await Promise.allSettled([...value.pending]);
}
interface Operation {
  readonly signal: AbortSignal;
  finish(error?: ModelProviderError, response?: ModelResponse): void;
}

export function createOpenAIChat(options: OpenAIChatOptions): ModelProvider {
  const budget = outputBudget(options.maxOutputTokens);
  const fingerprint = options.connectionFingerprint;
  const timeoutMs = options.timeoutMs;
  const logger = options.logger;
  let sdk: OpenAI | undefined = new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
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
    if (provider.closed || binding?.closed || !sdk) throw chatError("CLOSED");
    const timeout = new AbortController();
    const start = performance.now();
    let timer: NodeJS.Timeout;
    const tick = (): void => {
      const remaining = timeoutMs - (performance.now() - start);
      if (remaining <= 0) timeout.abort(chatError("TIMEOUT"));
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
    let finished = false;
    const record = (event: string, extra?: Record<string, unknown>): void => {
      try {
        const log = context
          ? logger?.child({ ...context.identity, requestId: context.requestId, step: context.step })
          : logger;
        log?.info(event, {
          adapterId: ADAPTER_ID,
          operation: selection ? "chat.completions" : "models",
          ...(selection ? { modelId: selection.modelId } : {}),
          ...extra,
        });
      } catch {
        /* 借用的诊断输出不改变请求结果。 */
      }
    };
    record("request.started");
    return {
      signal: combined,
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
            ...(error ? { code: error.code } : { status: response?.finishReason ?? "completed" }),
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
          const page = object(await response.json());
          operation.signal.throwIfAborted();
          if (!Array.isArray(page.data) || page.data.length > 2000)
            throw chatError("INVALID_RESPONSE");
          const seen = new Set<string>();
          const result: DiscoveredModel[] = [];
          for (const value of page.data) {
            const model = object(value);
            if (!validModelId(model.id)) throw chatError("INVALID_RESPONSE");
            if (seen.has(model.id)) continue;
            seen.add(model.id);
            result.push({ id: model.id, supported: true });
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
      if (provider.closed) throw chatError("CLOSED");
      if (signal.aborted) throw chatError("CANCELLED");
      if (selection.providerId !== ADAPTER_ID || !validModelId(selection.modelId))
        throw chatError("CONFIGURATION");
      const supported = support(selection.modelId);
      if (
        !supported.supported ||
        (selection.reasoningEffort !== undefined &&
          !supported.reasoningEfforts.includes(selection.reasoningEffort))
      )
        throw chatError("MODEL_CAPABILITY");
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
              const data = await sdk!.chat.completions.create(body, { signal: operation.signal });
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
            // 网络泵独立于消费端 yield，暂停迭代器不能阻碍超时或 dispose 排空。
            const pump = (async (): Promise<void> => {
              try {
                operation.signal.throwIfAborted();
                const body = requestBody(request, selected, fingerprint, budget);
                const stream = await sdk!.chat.completions.create(
                  { ...body, stream: true, stream_options: { include_usage: true } },
                  { signal: operation.signal },
                );
                const projection = new ChatStreamProjection();
                for await (const chunk of stream) {
                  operation.signal.throwIfAborted();
                  for (const event of projection.accept(chunk)) push(event);
                }
                operation.signal.throwIfAborted();
                const final = projection.finish();
                const result = responseProjection(
                  final.response,
                  selected,
                  fingerprint,
                  final.order,
                );
                for (const event of final.tools) push(event);
                push({ type: "completed", response: result });
                operation.finish(undefined, result);
              } catch (error) {
                failure =
                  error instanceof TypeError && !operation.signal.aborted
                    ? chatError("INCOMPLETE_STREAM")
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
                operation.signal.throwIfAborted();
                if (offset < queue.length) {
                  const event = queue[offset++];
                  if (offset === queue.length) {
                    queue.length = 0;
                    offset = 0;
                  }
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
              consumer.abort(chatError("CANCELLED"));
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
          sdk = undefined;
        })();
      }
      return closing;
    },
  };
}
