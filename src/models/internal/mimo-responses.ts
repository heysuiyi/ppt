import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type {
  ModelAssistantMessage,
  ModelRequest,
  ModelResponse,
  ModelSelection,
} from "../../agent/model/model-contract";
import type { JsonObject, JsonValue } from "../../agent/protocol-values";
import { MIMO_TOKEN_PLAN_CN_PROVIDER_ID } from "../mimo-token-plan-cn-contract";
import { invalid, MimoModelError, nonempty, object, outputBudget, text } from "./mimo-errors";

export const REPLAY_FORMAT = "mimo-token-plan-cn/responses-output";
export const REPLAY_VERSION = 1;
type Content = ModelAssistantMessage["content"][number];

/** 只复制 JSON 值，不把 SDK 包装对象、undefined 或原型带入重放状态。 */
export function json(value: unknown, depth = 0): JsonValue {
  if (depth > 64) return invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((part) => json(part, depth + 1));
  const record = object(value);
  if (
    Object.getPrototypeOf(record) !== Object.prototype &&
    Object.getPrototypeOf(record) !== null
  ) {
    return invalid();
  }
  const result: Record<string, JsonValue> = Object.create(null);
  for (const [key, part] of Object.entries(record)) result[key] = json(part, depth + 1);
  return result;
}

export function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((v, i) => same(v, right[i]))
    );
  }
  if (Array.isArray(right)) return false;
  const a = Object.keys(left);
  const b = Object.keys(right);
  return (
    a.length === b.length &&
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
    const callId = nonempty(item.call_id);
    const name = nonempty(item.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text(item.arguments));
    } catch {
      return invalid();
    }
    const input = json(object(parsed)) as JsonObject;
    return [{ type: "tool-call", callId, name, input }];
  }
  if (item.type === "message") {
    if (item.role !== "assistant" || !Array.isArray(item.content)) return invalid();
    return item.content.map<Content>((value) => {
      const part = object(value);
      if (part.type !== "output_text") return invalid();
      return { type: "text", text: text(part.text) };
    });
  }
  if (item.type === "reasoning") {
    const result: Content[] = [];
    // 两类协议明示的可公开文本均保留；私有字段仅留在原始重放项中。
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
      item.content === undefined &&
      item.summary === undefined &&
      typeof item.encrypted_content !== "string"
    ) {
      return invalid();
    }
    if (item.encrypted_content !== undefined) text(item.encrypted_content);
    return result;
  }
  return invalid();
}

export function projectOutput(value: unknown): { output: JsonValue[]; content: Content[] } {
  if (!Array.isArray(value)) return invalid();
  const ids = new Set<string>();
  const itemIds = new Set<string>();
  const content: Content[] = [];
  const output = value.map((value) => {
    const item = object(value);
    if (item.id !== undefined) {
      const id = nonempty(item.id);
      if (itemIds.has(id)) return invalid();
      itemIds.add(id);
    }
    for (const part of projectItem(item)) {
      if (part.type === "tool-call") {
        if (ids.has(part.callId)) return invalid();
        ids.add(part.callId);
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
  let finishReason: ModelResponse["finishReason"];
  if (response.status === "completed") finishReason = "stop";
  else if (
    response.status === "incomplete" &&
    object(response.incomplete_details).reason === "max_output_tokens"
  ) {
    // 截断不允许产生可执行调用或可恢复的助手历史。
    return { message: { role: "assistant", content: [] }, finishReason: "length" };
  } else return invalid();
  const { output, content } = projectOutput(response.output);
  if (content.some((part) => part.type === "tool-call")) finishReason = "tool-calls";
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
  return {
    message: {
      role: "assistant",
      content,
      replayState: {
        providerId: MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
        modelId: selection.modelId,
        format: REPLAY_FORMAT,
        version: REPLAY_VERSION,
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
    finishReason,
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
      state.providerId !== MIMO_TOKEN_PLAN_CN_PROVIDER_ID ||
      state.modelId !== selection.modelId ||
      state.format !== REPLAY_FORMAT ||
      state.version !== REPLAY_VERSION
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
    throw new MimoModelError("REPLAY_INCOMPATIBLE");
  }
}

export function requestBody(
  request: ModelRequest,
  selection: ModelSelection,
  fingerprint: string,
  defaultBudget: number,
): ResponseCreateParamsNonStreaming {
  const input: JsonValue[] = [];
  for (const message of request.messages) {
    if (message.role === "assistant" && message.replayState !== undefined) {
      input.push(...replay(message, selection, fingerprint));
      continue;
    }
    if (message.role === "tool") {
      for (const result of message.content) {
        const parts = result.content.map((part) => {
          if (part.type !== "text") throw new MimoModelError("MODEL_CAPABILITY");
          return { type: "input_text", text: part.text };
        });
        // 用明示的错误标记表达本地工具失败，不改写或拼接原始文本片段。
        if (result.isError) parts.unshift({ type: "input_text", text: "[tool_error]" });
        input.push({ type: "function_call_output", call_id: result.callId, output: parts });
      }
      continue;
    }
    const content = message.content.map((part) => {
      if (part.type === "image") throw new MimoModelError("MODEL_CAPABILITY");
      if (part.type !== "text") throw new MimoModelError("REPLAY_INCOMPATIBLE");
      return { type: "input_text", text: part.text };
    });
    input.push({ role: message.role, content });
  }
  const body = {
    model: selection.modelId,
    input,
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
  // SDK 的 effort 联合比厂商协议窄；仅在已校验边界转换，不扩展公开端点。
  return body as unknown as ResponseCreateParamsNonStreaming;
}
