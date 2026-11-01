import { isDeepStrictEqual } from "node:util";
import type {
  ModelAssistantMessage,
  ModelImageContent,
  ModelRequest,
  ModelResponse,
  ModelSelection,
} from "@agent-harness/core/model/model-contract";
import type { JsonObject, JsonValue } from "@agent-harness/core/protocol-values";
import type Anthropic from "@anthropic-ai/sdk";
import { budget, failure, object, text } from "./errors.js";
import { adapterId } from "./profile.js";

export type ReplayBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: JsonObject };

function json(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || !value || seen.has(value)) throw failure("INVALID_RESPONSE");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => json(item, seen));
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(result, key, {
        value: json(item, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function blocks(value: unknown): ReplayBlock[] {
  if (!Array.isArray(value)) throw failure("INVALID_RESPONSE");
  const ids = new Set<string>();
  return value.map((item): ReplayBlock => {
    const block = object(item);
    switch (block.type) {
      case "text":
        return { type: "text", text: text(block.text) };
      case "thinking":
        return {
          type: "thinking",
          thinking: text(block.thinking),
          signature: text(block.signature, true),
        };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: text(block.data, true) };
      case "tool_use": {
        const id = text(block.id, true);
        if (ids.has(id)) throw failure("INVALID_RESPONSE");
        ids.add(id);
        return {
          type: "tool_use",
          id,
          name: text(block.name, true),
          input: json(object(block.input)) as JsonObject,
        };
      }
      default:
        throw failure("INVALID_RESPONSE");
    }
  });
}

function visible(content: readonly ReplayBlock[]): ModelAssistantMessage["content"] {
  return content.flatMap((block): ModelAssistantMessage["content"][number][] => {
    switch (block.type) {
      case "text":
        return [{ type: "text", text: block.text }];
      case "thinking":
        return [{ type: "reasoning", text: block.thinking }];
      case "redacted_thinking":
        return [];
      case "tool_use":
        return [{ type: "tool-call", callId: block.id, name: block.name, input: block.input }];
    }
  });
}

export function project(
  value: unknown,
  selection: ModelSelection,
  fingerprint: string,
): ModelResponse {
  const response = object(value);
  if (response.type !== "message" || response.role !== "assistant")
    throw failure("INVALID_RESPONSE");
  text(response.id, true);
  text(response.model, true);
  const stop = text(response.stop_reason, true);
  if (stop === "max_tokens" || stop === "model_context_window_exceeded") throw failure("TRUNCATED");
  if (
    ![
      "end_turn",
      "stop_sequence",
      "tool_use",
      "pause_turn",
      "refusal",
      "context_window_exceeded",
    ].includes(stop)
  )
    throw failure("INVALID_RESPONSE");
  if (stop === "context_window_exceeded") throw failure("TRUNCATED");
  const content = blocks(response.content);
  const hasTools = content.some((block) => block.type === "tool_use");
  if (hasTools !== (stop === "tool_use")) throw failure("INVALID_RESPONSE");
  const usage = object(response.usage);
  const count = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw failure("INVALID_RESPONSE");
    return value;
  };
  const inputTokens =
    count(usage.input_tokens) +
    count(usage.cache_read_input_tokens ?? 0) +
    count(usage.cache_creation_input_tokens ?? 0);
  if (!Number.isSafeInteger(inputTokens)) throw failure("INVALID_RESPONSE");
  return {
    message: {
      role: "assistant",
      content: visible(content),
      replayState: {
        providerId: adapterId,
        modelId: selection.modelId,
        format: "anthropic-messages-content",
        version: 1,
        data: {
          connectionFingerprint: fingerprint,
          reasoningEffort: selection.reasoningEffort ?? null,
          content,
        },
      },
    },
    finishReason:
      stop === "tool_use"
        ? "tool-calls"
        : stop === "end_turn" || stop === "stop_sequence"
          ? "stop"
          : "other",
    usage: { inputTokens, outputTokens: count(usage.output_tokens) },
  };
}

function image(block: ModelImageContent): Anthropic.ImageBlockParam {
  if (block.source.type === "url")
    return { type: "image", source: { type: "url", url: block.source.url } };
  const media = block.source.mediaType;
  if (
    media !== "image/jpeg" &&
    media !== "image/png" &&
    media !== "image/gif" &&
    media !== "image/webp"
  )
    throw failure("MODEL_CAPABILITY");
  return { type: "image", source: { type: "base64", media_type: media, data: block.source.data } };
}

function assistant(
  message: ModelAssistantMessage,
  selection: ModelSelection,
  fingerprint: string,
): ReplayBlock[] {
  if (message.replayState) {
    try {
      const state = message.replayState;
      const data = object(state.data);
      if (
        state.providerId !== adapterId ||
        state.modelId !== selection.modelId ||
        state.format !== "anthropic-messages-content" ||
        state.version !== 1 ||
        data.connectionFingerprint !== fingerprint ||
        data.reasoningEffort !== (selection.reasoningEffort ?? null)
      )
        throw failure("REPLAY_INCOMPATIBLE");
      const content = blocks(data.content);
      if (!isDeepStrictEqual(visible(content), message.content))
        throw failure("REPLAY_INCOMPATIBLE");
      return content;
    } catch {
      throw failure("REPLAY_INCOMPATIBLE");
    }
  }
  return message.content.map((block): ReplayBlock => {
    if (block.type === "reasoning") throw failure("REPLAY_INCOMPATIBLE");
    return block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "tool_use", id: block.callId, name: block.name, input: block.input };
  });
}

export function requestBody(
  request: ModelRequest,
  selection: ModelSelection,
  fingerprint: string,
  defaultBudget: number,
): Anthropic.MessageCreateParamsNonStreaming {
  const system: Anthropic.TextBlockParam[] = [];
  const messages: Anthropic.MessageParam[] = [];
  let started = false;
  for (const message of request.messages) {
    if (message.role === "system") {
      // Moving an in-conversation system turn to the front would change its authority.
      if (started) throw failure("MODEL_CAPABILITY");
      system.push(...message.content.map((block) => ({ type: "text" as const, text: block.text })));
      continue;
    }
    started = true;
    if (message.role === "assistant")
      messages.push({ role: "assistant", content: assistant(message, selection, fingerprint) });
    else if (message.role === "user")
      messages.push({
        role: "user",
        content: message.content.map((block) =>
          block.type === "image" ? image(block) : { type: "text", text: block.text },
        ),
      });
    else
      messages.push({
        role: "user",
        content: message.content.map((block) => ({
          type: "tool_result",
          tool_use_id: block.callId,
          content: block.content.map((item) =>
            item.type === "image" ? image(item) : { type: "text" as const, text: item.text },
          ),
          ...(block.isError === undefined ? {} : { is_error: block.isError }),
        })),
      });
  }
  if (!messages.length) throw failure("CONFIGURATION");
  return {
    model: selection.modelId,
    max_tokens: budget(request.maxOutputTokens ?? defaultBudget),
    messages,
    ...(system.length ? { system } : {}),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
          })),
        }
      : {}),
  };
}
