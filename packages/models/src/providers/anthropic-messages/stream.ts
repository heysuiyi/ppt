import type { ModelStreamEvent } from "@agent-harness/core/model/model-contract";
import { Stream } from "@anthropic-ai/sdk/core/streaming";
import { failure, object, text } from "./errors.js";

/**
 * SDK HTTP handling and SSE framing are retained, but JSON is decoded here:
 * SDK defaultParseResponse omits the client when constructing its SSE parser,
 * which makes malformed JSON print the raw event through global console.error.
 */
export async function* decodeEvents(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<unknown> {
  if (!response.body) throw failure("INCOMPLETE_STREAM");
  try {
    for await (const event of Stream.rawEvents(response)) {
      signal.throwIfAborted();
      if (event.event === "ping") continue;
      let value: Record<string, unknown>;
      try {
        value = object(JSON.parse(event.data) as unknown);
      } catch {
        throw failure("INVALID_RESPONSE");
      }
      if (event.event !== value.type) throw failure("INVALID_RESPONSE");
      if (event.event === "error") {
        const error = object(value.error);
        switch (error.type) {
          case "overloaded_error":
          case "api_error":
            throw failure("SERVICE_UNAVAILABLE");
          case "rate_limit_error":
            throw failure("RATE_LIMIT_OR_QUOTA");
          case "authentication_error":
            throw failure("AUTHENTICATION");
          case "permission_error":
            throw failure("ACCESS_DENIED");
          case "billing_error":
            throw failure("PAYMENT_REQUIRED");
          case "timeout_error":
            throw failure("TIMEOUT");
          default:
            throw failure("INVALID_RESPONSE");
        }
      }
      yield value;
    }
  } finally {
    // Early projection failure must also release the underlying response body.
    await response.body.cancel().catch(() => {});
  }
}

interface PendingBlock {
  readonly value: Record<string, unknown>;
  readonly visibleIndex: number;
  inputJSON: string;
  stopped: boolean;
}

/** message_stop, not transport EOF or message_delta, authorizes the final response. */
export class MessagesStream {
  private message: Record<string, unknown> | undefined;
  private readonly content: PendingBlock[] = [];
  private visibleCount = 0;
  private active = -1;
  private sawDelta = false;
  private stopped = false;

  accept(value: unknown): ModelStreamEvent[] {
    const event = object(value);
    if (event.type === "ping") return [];
    if (this.stopped) throw failure("INVALID_RESPONSE");
    if (event.type === "message_start") {
      if (this.message) throw failure("INVALID_RESPONSE");
      const message = object(event.message);
      if (
        message.type !== "message" ||
        message.role !== "assistant" ||
        !Array.isArray(message.content) ||
        message.content.length ||
        message.stop_reason !== null
      )
        throw failure("INVALID_RESPONSE");
      text(message.id, true);
      text(message.model, true);
      this.message = { ...message, usage: { ...object(message.usage) } };
      return [];
    }
    if (!this.message) throw failure("INVALID_RESPONSE");
    if (event.type === "content_block_start") {
      if (this.sawDelta || this.active !== -1 || event.index !== this.content.length)
        throw failure("INVALID_RESPONSE");
      const block = { ...object(event.content_block) };
      const index = this.visibleCount;
      switch (block.type) {
        case "text":
          text(block.text);
          break;
        case "thinking":
          text(block.thinking);
          text(block.signature);
          break;
        case "redacted_thinking":
          text(block.data, true);
          break;
        case "tool_use":
          text(block.id, true);
          text(block.name, true);
          if (Object.keys(object(block.input)).length) throw failure("INVALID_RESPONSE");
          break;
        default:
          throw failure("INVALID_RESPONSE");
      }
      if (block.type !== "redacted_thinking") this.visibleCount++;
      this.active = this.content.length;
      this.content.push({ value: block, visibleIndex: index, inputJSON: "", stopped: false });
      if (block.type === "text" && block.text)
        return [{ type: "content-delta", index, delta: { type: "text", text: text(block.text) } }];
      if (block.type === "thinking" && block.thinking)
        return [
          {
            type: "content-delta",
            index,
            delta: { type: "reasoning", text: text(block.thinking) },
          },
        ];
      return [];
    }
    if (event.type === "content_block_delta" || event.type === "content_block_stop") {
      if (this.sawDelta || this.active === -1 || event.index !== this.active)
        throw failure("INVALID_RESPONSE");
      const pending = this.content[this.active];
      const block = pending.value;
      if (event.type === "content_block_stop") {
        pending.stopped = true;
        this.active = -1;
        return [];
      }
      const delta = object(event.delta);
      const index = pending.visibleIndex;
      if (delta.type === "text_delta" && block.type === "text") {
        const part = text(delta.text);
        block.text = text(block.text) + part;
        return [{ type: "content-delta", index, delta: { type: "text", text: part } }];
      }
      if (delta.type === "thinking_delta" && block.type === "thinking") {
        const part = text(delta.thinking);
        block.thinking = text(block.thinking) + part;
        return [{ type: "content-delta", index, delta: { type: "reasoning", text: part } }];
      }
      if (delta.type === "signature_delta" && block.type === "thinking") {
        block.signature = text(block.signature) + text(delta.signature);
        return [];
      }
      if (delta.type === "input_json_delta" && block.type === "tool_use") {
        const part = text(delta.partial_json);
        pending.inputJSON += part;
        return [
          {
            type: "content-delta",
            index,
            delta: {
              type: "tool-call",
              callId: text(block.id),
              name: text(block.name),
              inputDelta: part,
            },
          },
        ];
      }
      throw failure("INVALID_RESPONSE");
    }
    if (event.type === "message_delta") {
      if (this.active !== -1) throw failure("INVALID_RESPONSE");
      const delta = object(event.delta);
      if (delta.stop_reason !== undefined && delta.stop_reason !== null)
        this.message.stop_reason = text(delta.stop_reason, true);
      this.message.usage = { ...object(this.message.usage), ...object(event.usage) };
      this.sawDelta = true;
      return [];
    }
    if (event.type === "message_stop") {
      if (!this.sawDelta || this.active !== -1 || typeof this.message.stop_reason !== "string")
        throw failure("INVALID_RESPONSE");
      this.stopped = true;
      return [];
    }
    // Unknown events cannot silently change an authoritative content projection.
    throw failure("INVALID_RESPONSE");
  }

  finish(): unknown {
    if (!this.stopped || !this.message || this.content.some((block) => !block.stopped))
      throw failure("INCOMPLETE_STREAM");
    const stop = this.message.stop_reason;
    if (
      stop === "max_tokens" ||
      stop === "model_context_window_exceeded" ||
      stop === "context_window_exceeded"
    )
      throw failure("TRUNCATED");
    const content = this.content.map((pending) => {
      const block = pending.value;
      if (block.type !== "tool_use" || !pending.inputJSON) return block;
      try {
        return { ...block, input: JSON.parse(pending.inputJSON) as unknown };
      } catch {
        throw failure("INVALID_RESPONSE");
      }
    });
    return { ...this.message, content };
  }
}
