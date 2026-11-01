import type {
  ModelAssistantMessage,
  ModelRequest,
  ModelResponse,
  ModelSelection,
  ModelToolContent,
} from "@agent-harness/core/model/model-contract";
import type { JsonObject, JsonValue } from "@agent-harness/core/protocol-values";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { error, invalid, nonempty, object, outputBudget, text } from "./errors.js";
import { ADAPTER_ID } from "./profile.js";

type Content = ModelAssistantMessage["content"][number];
const REPLAY_FORMAT = "openai-responses/output";
export function json(value: unknown, depth = 0): JsonValue {
  if (depth > 64) return invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((part) => json(part, depth + 1));
  const raw = object(value);
  if (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
    return invalid();
  const result: Record<string, JsonValue> = Object.create(null);
  for (const [key, part] of Object.entries(raw)) result[key] = json(part, depth + 1);
  return result;
}
export function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left))
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((part, index) => same(part, right[index]))
    );
  if (Array.isArray(right)) return false;
  const a = Object.keys(left);
  return (
    a.length === Object.keys(right).length &&
    a.every(
      (key) =>
        Object.hasOwn(right, key) &&
        same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}
export function projectItem(value: unknown): Content[] {
  const item = object(value);
  if (item.status !== undefined && item.status !== "completed") return invalid();
  if (item.type === "function_call") {
    let input: JsonObject;
    try {
      input = json(object(JSON.parse(text(item.arguments)))) as JsonObject;
    } catch {
      return invalid();
    }
    return [
      { type: "tool-call", callId: nonempty(item.call_id), name: nonempty(item.name), input },
    ];
  }
  if (item.type === "message") {
    if (item.role !== "assistant" || !Array.isArray(item.content)) return invalid();
    return item.content.map((value): Content => {
      const part = object(value);
      if (part.type === "output_text") return { type: "text", text: text(part.text) };
      if (part.type === "refusal") return { type: "text", text: text(part.refusal) };
      return invalid();
    });
  }
  if (item.type === "reasoning") {
    const result: Content[] = [];
    for (const [key, type] of [
      ["summary", "summary_text"],
      ["content", "reasoning_text"],
    ] as const) {
      if (item[key] === undefined) continue;
      if (!Array.isArray(item[key])) return invalid();
      for (const value of item[key]) {
        const part = object(value);
        if (part.type !== type) return invalid();
        result.push({ type: "reasoning", text: text(part.text) });
      }
    }
    if (
      item.summary === undefined &&
      item.content === undefined &&
      typeof item.encrypted_content !== "string"
    )
      return invalid();
    if (item.encrypted_content !== undefined && item.encrypted_content !== null)
      text(item.encrypted_content);
    return result;
  }
  return invalid();
}
function projectOutput(value: unknown): { output: JsonValue[]; content: Content[] } {
  if (!Array.isArray(value)) return invalid();
  const ids = new Set<string>();
  const callIds = new Set<string>();
  const content: Content[] = [];
  const output = value.map((value) => {
    const item = object(value);
    if (item.id !== undefined) {
      const id = nonempty(item.id);
      if (ids.has(id)) return invalid();
      ids.add(id);
    }
    for (const part of projectItem(item)) {
      if (part.type === "tool-call") {
        if (callIds.has(part.callId)) return invalid();
        callIds.add(part.callId);
      }
      content.push(part);
    }
    return json(item);
  });
  return { output, content };
}
export function responseProjection(
  value: unknown,
  selection: ModelSelection,
  connectionFingerprint: string,
): ModelResponse {
  const response = object(value);
  const length =
    response.status === "incomplete" &&
    object(response.incomplete_details).reason === "max_output_tokens";
  if (!length && response.status !== "completed") return invalid();
  let usage: ModelResponse["usage"];
  if (response.usage !== undefined && response.usage !== null) {
    const raw = object(response.usage);
    if (
      !Number.isSafeInteger(raw.input_tokens) ||
      (raw.input_tokens as number) < 0 ||
      !Number.isSafeInteger(raw.output_tokens) ||
      (raw.output_tokens as number) < 0
    )
      return invalid();
    usage = { inputTokens: raw.input_tokens as number, outputTokens: raw.output_tokens as number };
  }
  // 不完整函数参数永远不能成为可执行工具，也不能生成可续传的私有历史。
  if (length)
    return {
      message: { role: "assistant", content: [] },
      finishReason: "length",
      ...(usage ? { usage } : {}),
    };
  const { output, content } = projectOutput(response.output);
  return {
    message: {
      role: "assistant",
      content,
      replayState: {
        providerId: ADAPTER_ID,
        modelId: selection.modelId,
        format: REPLAY_FORMAT,
        version: 1,
        data: {
          output,
          content: json(content),
          connectionFingerprint,
          ...(selection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: selection.reasoningEffort }),
        },
      },
    },
    finishReason: content.some((part) => part.type === "tool-call") ? "tool-calls" : "stop",
    ...(usage ? { usage } : {}),
  };
}
function replay(
  message: ModelAssistantMessage,
  selection: ModelSelection,
  fingerprint: string,
): JsonValue[] {
  try {
    const state = message.replayState;
    if (
      !state ||
      state.providerId !== ADAPTER_ID ||
      state.modelId !== selection.modelId ||
      state.format !== REPLAY_FORMAT ||
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
    const projected = projectOutput(data.output);
    if (!same(projected.content, message.content) || !same(data.content, message.content))
      throw new Error();
    return projected.output;
  } catch {
    throw error("REPLAY_INCOMPATIBLE");
  }
}
function inputPart(part: ModelToolContent): JsonValue {
  if (part.type === "text") return { type: "input_text", text: part.text };
  return {
    type: "input_image",
    detail: "auto",
    image_url:
      part.source.type === "url"
        ? part.source.url
        : `data:${part.source.mediaType};base64,${part.source.data}`,
  };
}
export function requestBody(
  request: ModelRequest,
  selection: ModelSelection,
  fingerprint: string,
  defaultBudget: number,
): ResponseCreateParamsNonStreaming {
  const input: JsonValue[] = [];
  for (const message of request.messages) {
    if (message.role === "assistant") {
      if (message.replayState !== undefined) {
        input.push(...replay(message, selection, fingerprint));
        continue;
      }
      // 无私有状态的普通助手历史仍可跨适配器使用；不可伪造私有推理。
      for (const part of message.content) {
        if (part.type === "reasoning") throw error("REPLAY_INCOMPATIBLE");
        if (part.type === "tool-call")
          input.push({
            type: "function_call",
            call_id: part.callId,
            name: part.name,
            arguments: JSON.stringify(part.input),
          });
        else input.push({ role: "assistant", content: [{ type: "input_text", text: part.text }] });
      }
    } else if (message.role === "tool") {
      for (const result of message.content) {
        const output = result.content.map(inputPart);
        if (result.isError) output.unshift({ type: "input_text", text: "[tool_error]" });
        input.push({ type: "function_call_output", call_id: result.callId, output });
      }
    } else input.push({ role: message.role, content: message.content.map(inputPart) });
  }
  const body = {
    model: selection.modelId,
    input,
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: outputBudget(request.maxOutputTokens ?? defaultBudget),
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: selection.reasoningEffort } }),
    ...(request.tools?.length
      ? {
          tool_choice: "auto",
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: false,
          })),
        }
      : {}),
  };
  return body as unknown as ResponseCreateParamsNonStreaming;
}
