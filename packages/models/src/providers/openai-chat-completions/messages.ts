import type {
  ModelAssistantMessage,
  ModelRequest,
  ModelResponse,
  ModelSelection,
} from "@agent-harness/core/model/model-contract";
import type { JsonObject, JsonValue } from "@agent-harness/core/protocol-values";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { chatError, invalid, nonempty, object, outputBudget, text } from "./errors.js";
import { ADAPTER_ID } from "./profile.js";

type Content = ModelAssistantMessage["content"][number];
export type TextField = "reasoning_content" | "content" | "refusal";
const FORMAT = "openai-chat-completions/assistant";

export function json(value: unknown, depth = 0): JsonValue {
  if (depth > 64) return invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((part) => json(part, depth + 1));
  const record = object(value);
  if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null)
    return invalid();
  const result: Record<string, JsonValue> = Object.create(null);
  for (const [key, part] of Object.entries(record)) result[key] = json(part, depth + 1);
  return result;
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => Object.hasOwn(right, key) && same(left[key], right[key]))
  );
}

export function projectMessage(
  value: unknown,
  order: readonly TextField[] = ["reasoning_content", "content", "refusal"],
  includeTools = true,
): Content[] {
  const message = object(value);
  if (message.role !== "assistant") return invalid();
  if (
    new Set(order).size !== order.length ||
    order.some((field) => !["content", "reasoning_content", "refusal"].includes(field))
  )
    return invalid();
  const content: Content[] = [];
  for (const field of ["reasoning_content", "content", "refusal"] as const) {
    if (message[field] !== undefined && message[field] !== null) {
      text(message[field]);
      if (message[field] && !order.includes(field)) return invalid();
    }
  }
  for (const field of order) {
    if (typeof message[field] === "string" && message[field])
      content.push({
        type: field === "reasoning_content" ? "reasoning" : "text",
        text: message[field],
      });
  }
  if (message.function_call !== undefined && message.function_call !== null) return invalid();
  if (message.audio !== undefined && message.audio !== null) return invalid();
  if (
    message.tool_calls !== undefined &&
    message.tool_calls !== null &&
    !Array.isArray(message.tool_calls)
  )
    return invalid();
  if (includeTools) {
    const ids = new Set<string>();
    for (const value of (message.tool_calls ?? []) as unknown[]) {
      const call = object(value);
      if (call.type !== "function") return invalid();
      const callId = nonempty(call.id);
      if (ids.has(callId)) return invalid();
      ids.add(callId);
      const fn = object(call.function);
      const name = nonempty(fn.name);
      let input: JsonObject;
      try {
        input = json(object(JSON.parse(text(fn.arguments)))) as JsonObject;
      } catch {
        return invalid();
      }
      content.push({ type: "tool-call", callId, name, input });
    }
  }
  return content;
}

export function responseProjection(
  value: unknown,
  selection: ModelSelection,
  fingerprint: string,
  order?: readonly TextField[],
): ModelResponse {
  const response = object(value);
  if (!Array.isArray(response.choices) || response.choices.length !== 1) return invalid();
  const choice = object(response.choices[0]);
  if (
    choice.index !== 0 ||
    !["stop", "tool_calls", "length", "content_filter"].includes(text(choice.finish_reason))
  )
    return invalid();
  const finishReason: ModelResponse["finishReason"] =
    choice.finish_reason === "stop"
      ? "stop"
      : choice.finish_reason === "tool_calls"
        ? "tool-calls"
        : choice.finish_reason === "length"
          ? "length"
          : "other";
  const wire = object(choice.message);
  const content = projectMessage(wire, order, finishReason === "tool-calls");
  if (finishReason === "tool-calls" && !content.some((part) => part.type === "tool-call"))
    return invalid();
  if (
    finishReason !== "length" &&
    finishReason !== "tool-calls" &&
    Array.isArray(wire.tool_calls) &&
    wire.tool_calls.length
  )
    return invalid();
  let usage: ModelResponse["usage"];
  if (response.usage !== undefined && response.usage !== null) {
    const raw = object(response.usage);
    if (
      !Number.isSafeInteger(raw.prompt_tokens) ||
      (raw.prompt_tokens as number) < 0 ||
      !Number.isSafeInteger(raw.completion_tokens) ||
      (raw.completion_tokens as number) < 0
    )
      return invalid();
    usage = {
      inputTokens: raw.prompt_tokens as number,
      outputTokens: raw.completion_tokens as number,
    };
  }
  return {
    message: {
      role: "assistant",
      content,
      ...(finishReason === "length"
        ? {}
        : {
            replayState: {
              providerId: ADAPTER_ID,
              modelId: selection.modelId,
              format: FORMAT,
              version: 1,
              data: {
                wire: json(wire),
                content: json(content),
                order: json(order ?? ["reasoning_content", "content", "refusal"]),
                connectionFingerprint: fingerprint,
                ...(selection.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: selection.reasoningEffort }),
              },
            },
          }),
    },
    finishReason,
    ...(usage ? { usage } : {}),
  };
}

function replay(
  message: ModelAssistantMessage,
  selection: ModelSelection,
  fingerprint: string,
): JsonValue {
  try {
    const state = message.replayState;
    if (
      !state ||
      state.providerId !== ADAPTER_ID ||
      state.modelId !== selection.modelId ||
      state.format !== FORMAT ||
      state.version !== 1
    )
      throw new Error();
    const data = object(state.data);
    if (
      data.connectionFingerprint !== fingerprint ||
      data.reasoningEffort !== selection.reasoningEffort ||
      (selection.reasoningEffort === undefined && Object.hasOwn(data, "reasoningEffort"))
    )
      throw new Error();
    if (
      !Array.isArray(data.order) ||
      !same(projectMessage(data.wire, data.order as TextField[]), message.content) ||
      !same(data.content, message.content)
    )
      throw new Error();
    return json(data.wire);
  } catch {
    throw chatError("REPLAY_INCOMPATIBLE");
  }
}

export function requestBody(
  request: ModelRequest,
  selection: ModelSelection,
  fingerprint: string,
  budget: number,
): ChatCompletionCreateParamsNonStreaming {
  const messages: JsonValue[] = [];
  for (const message of request.messages) {
    if (message.role === "assistant") {
      if (message.replayState !== undefined) {
        messages.push(replay(message, selection, fingerprint));
        continue;
      }
      const calls = message.content.filter((part) => part.type === "tool-call");
      const reasoning = message.content.filter((part) => part.type === "reasoning");
      messages.push({
        role: "assistant",
        content: message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
        ...(reasoning.length
          ? { reasoning_content: reasoning.map((part) => part.text).join("\n") }
          : {}),
        ...(calls.length
          ? {
              tool_calls: calls.map((call) => ({
                id: call.callId,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
          : {}),
      });
    } else if (message.role === "tool") {
      for (const result of message.content) {
        messages.push({
          role: "tool",
          tool_call_id: result.callId,
          content: [
            ...(result.isError ? ["[tool_error]"] : []),
            ...result.content.filter((part) => part.type === "text").map((part) => part.text),
          ].join("\n"),
        });
      }
      // Chat 的 tool 消息只允许文本；图像必须作为随后 user 消息的视觉输入。
      for (const result of message.content) {
        const images = result.content.filter((part) => part.type === "image");
        if (images.length)
          messages.push({
            role: "user",
            content: [
              { type: "text", text: `Images from tool result ${result.callId}:` },
              ...images.map(imagePart),
            ],
          });
      }
    } else if (message.role === "system") {
      messages.push({
        role: "system",
        content: message.content.map((part) => part.text).join("\n"),
      });
    } else {
      messages.push({
        role: "user",
        content: message.content.map((part) =>
          part.type === "image" ? imagePart(part) : { type: "text", text: part.text },
        ),
      });
    }
  }
  return {
    model: selection.modelId,
    messages,
    // max_tokens 仍是兼容端点的共同参数；官方 reasoning 模型使用替代参数。
    ...(/^(?:o[134](?:-|$)|gpt-5(?:[.-]|$))/u.test(selection.modelId)
      ? { max_completion_tokens: outputBudget(request.maxOutputTokens ?? budget) }
      : { max_tokens: outputBudget(request.maxOutputTokens ?? budget) }),
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoning_effort: selection.reasoningEffort }),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
              strict: false,
            },
          })),
        }
      : {}),
  } as unknown as ChatCompletionCreateParamsNonStreaming;
}
function imagePart(part: {
  readonly source:
    | { readonly type: "url"; readonly url: string }
    | { readonly type: "base64"; readonly mediaType: string; readonly data: string };
}): JsonValue {
  return {
    type: "image_url",
    image_url: {
      url:
        part.source.type === "url"
          ? part.source.url
          : `data:${part.source.mediaType};base64,${part.source.data}`,
    },
  };
}
