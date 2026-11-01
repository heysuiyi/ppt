import type {
  ModelBinding,
  ModelCallContext,
  ModelResponse,
  ModelSelection,
  ModelStreamEvent,
} from "@agent-harness/core/model/model-contract";
import Anthropic from "@anthropic-ai/sdk";
import type {
  AnthropicMessagesOptions,
  DiscoveredModel,
  ModelProvider,
} from "../../model-contract.js";
import type { ModelProviderError } from "../../model-errors.js";
import { budget, failure, object, safeError } from "./errors.js";
import { project, requestBody } from "./messages.js";
import { adapterId, capabilities, validModelId } from "./profile.js";
import { decodeEvents, MessagesStream } from "./stream.js";

interface Owner {
  readonly controller: AbortController;
  readonly pending: Set<Promise<void>>;
  closed: boolean;
}
async function close(value: Owner): Promise<void> {
  value.closed = true;
  value.controller.abort(failure("CLOSED"));
  await Promise.allSettled([...value.pending]);
}

export function createAnthropicMessages(options: AnthropicMessagesOptions): ModelProvider {
  const outputBudget = budget(options.maxOutputTokens);
  const timeoutMs = options.timeoutMs;
  const fingerprint = options.connectionFingerprint;
  const logger = options.logger;
  let sdk: Anthropic | undefined = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    timeout: timeoutMs,
    maxRetries: 0,
    logLevel: "off",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const provider: Owner = { controller: new AbortController(), pending: new Set(), closed: false };
  const bindings = new Set<Owner>();
  let closing: Promise<void> | undefined;

  function begin(
    signal: AbortSignal,
    binding?: Owner,
    selection?: ModelSelection,
    context?: ModelCallContext,
  ) {
    if (provider.closed || binding?.closed || !sdk) throw failure("CLOSED");
    const deadline = new AbortController();
    const started = performance.now();
    let timer: NodeJS.Timeout;
    const tick = (): void => {
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0) deadline.abort(failure("TIMEOUT"));
      else timer = setTimeout(tick, Math.min(remaining, 2147483647));
    };
    timer = setTimeout(tick, Math.min(timeoutMs, 2147483647));
    const combined = AbortSignal.any([
      signal,
      provider.controller.signal,
      deadline.signal,
      ...(binding ? [binding.controller.signal] : []),
    ]);
    const pending = Promise.withResolvers<void>();
    provider.pending.add(pending.promise);
    binding?.pending.add(pending.promise);
    let log = logger;
    try {
      if (context)
        log = logger?.child({
          ...context.identity,
          requestId: context.requestId,
          step: context.step,
        });
    } catch {
      /* Diagnostics are borrowed. */
    }
    const record = (event: string, extra?: Record<string, unknown>): void => {
      try {
        log?.info(event, {
          providerId: adapterId,
          operation: selection ? "messages" : "models",
          ...(selection ? { modelId: selection.modelId } : {}),
          ...extra,
        });
      } catch {
        /* Logging must not change results. */
      }
    };
    record("request.started");
    let done = false;
    return {
      signal: combined,
      finish(error?: ModelProviderError, response?: ModelResponse): void {
        if (done) return;
        done = true;
        clearTimeout(timer);
        record(
          error
            ? error.code === "CANCELLED" || error.code === "CLOSED"
              ? "request.cancelled"
              : "request.failed"
            : "request.completed",
          {
            durationMs: Math.max(0, performance.now() - started),
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
    adapterId,
    discovery: {
      async listModels(signal) {
        const operation = begin(signal);
        try {
          const found = new Map<string, DiscoveredModel>();
          const cursors = new Set<string>();
          let after: string | undefined;
          do {
            operation.signal.throwIfAborted();
            const response = await sdk!.models
              .list(
                { limit: 1000, ...(after ? { after_id: after } : {}) },
                { signal: operation.signal },
              )
              .asResponse();
            const page = object(await response.json());
            operation.signal.throwIfAborted();
            if (!Array.isArray(page.data) || typeof page.has_more !== "boolean")
              throw failure("INVALID_RESPONSE");
            for (const item of page.data) {
              const model = object(item);
              if (
                !validModelId(model.id) ||
                (model.display_name !== undefined && typeof model.display_name !== "string")
              )
                throw failure("INVALID_RESPONSE");
              found.set(model.id, {
                id: model.id,
                supported: true,
                ...(typeof model.display_name === "string"
                  ? { displayName: model.display_name }
                  : {}),
              });
            }
            after = undefined;
            if (page.has_more) {
              if (!validModelId(page.last_id) || cursors.has(page.last_id) || !page.data.length)
                throw failure("INVALID_RESPONSE");
              cursors.add(page.last_id);
              after = page.last_id;
            }
          } while (after);
          operation.finish();
          return [...found.values()];
        } catch (error) {
          const safe = safeError(error, operation.signal);
          operation.finish(safe);
          throw safe;
        }
      },
    },
    async create(selection, signal): Promise<ModelBinding> {
      if (provider.closed) throw failure("CLOSED");
      if (signal.aborted) throw failure("CANCELLED");
      if (
        selection.providerId !== adapterId ||
        !validModelId(selection.modelId) ||
        selection.reasoningEffort !== undefined
      )
        throw failure("CONFIGURATION");
      const selected = Object.freeze({ providerId: adapterId, modelId: selection.modelId });
      const binding: Owner = {
        controller: new AbortController(),
        pending: new Set(),
        closed: false,
      };
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
              const response = await sdk!.messages.create(
                requestBody(request, selected, fingerprint, outputBudget),
                { signal: operation.signal },
              );
              operation.signal.throwIfAborted();
              const result = project(response, selected, fingerprint);
              operation.finish(undefined, result);
              return result;
            } catch (error) {
              const safe = safeError(error, operation.signal);
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
            let problem: ModelProviderError | undefined;
            let notify: (() => void) | undefined;
            const push = (event: ModelStreamEvent): void => {
              queue.push(event);
              notify?.();
              notify = undefined;
            };
            // The pump owns network consumption even when the observer pauses at yield.
            const pump = (async (): Promise<void> => {
              try {
                operation.signal.throwIfAborted();
                const response = await sdk!.messages
                  .create(
                    { ...requestBody(request, selected, fingerprint, outputBudget), stream: true },
                    { signal: operation.signal },
                  )
                  .asResponse();
                const projection = new MessagesStream();
                for await (const event of decodeEvents(response, operation.signal)) {
                  operation.signal.throwIfAborted();
                  for (const delta of projection.accept(event)) push(delta);
                }
                operation.signal.throwIfAborted();
                const result = project(projection.finish(), selected, fingerprint);
                push({ type: "completed", response: result });
                operation.finish(undefined, result);
              } catch (error) {
                problem =
                  error instanceof TypeError && !operation.signal.aborted
                    ? failure("INCOMPLETE_STREAM")
                    : safeError(error, operation.signal);
                operation.finish(problem);
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
                    offset = 0;
                    queue.length = 0;
                  }
                  yield event;
                } else if (ended) {
                  if (problem) throw problem;
                  break;
                } else {
                  const wake = Promise.withResolvers<void>();
                  notify = wake.resolve;
                  await wake.promise;
                }
              }
            } catch (error) {
              throw safeError(error, operation.signal);
            } finally {
              consumer.abort(failure("CANCELLED"));
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
      closing ??= (async () => {
        await Promise.all([close(provider), ...[...bindings].map(close)]);
        bindings.clear();
        sdk = undefined;
      })();
      return closing;
    },
  };
}
