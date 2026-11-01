import type { ModelStreamEvent } from "@agent-harness/core/model/model-contract";
import { chatError, invalid, nonempty, object, text } from "./errors.js";
import type { TextField } from "./messages.js";

type Delta = Extract<ModelStreamEvent, { type: "content-delta" }>;
interface Tool {
  id: string;
  name: string;
  arguments: string;
}

/** Chat 没有权威 message 事件：只有带 finish_reason 的 choice 可封闭已收集的片段。 */
export class ChatStreamProjection {
  private readonly fields = new Map<TextField, string>();
  private readonly tools = new Map<number, Tool>();
  private terminal?: string;
  private usage?: unknown;
  private seen = false;

  accept(value: unknown): Delta[] {
    const chunk = object(value);
    if (chunk.error !== undefined || !Array.isArray(chunk.choices)) return invalid();
    if (chunk.usage !== undefined && chunk.usage !== null) {
      if (this.usage !== undefined) return invalid();
      this.usage = chunk.usage;
    }
    if (chunk.choices.length === 0) {
      if (!this.terminal || chunk.usage === undefined || chunk.usage === null) return invalid();
      return [];
    }
    if (chunk.choices.length !== 1 || this.terminal) return invalid();
    const choice = object(chunk.choices[0]);
    if (choice.index !== 0) return invalid();
    const delta = object(choice.delta);
    if (delta.role !== undefined && delta.role !== "assistant") return invalid();
    if (delta.function_call !== undefined || delta.audio !== undefined) return invalid();
    this.seen = true;
    const events: Delta[] = [];
    for (const field of Object.keys(delta)) {
      if (field !== "content" && field !== "reasoning_content" && field !== "refusal") {
        if (field !== "role" && field !== "tool_calls") return invalid();
        continue;
      }
      if (delta[field] === null) continue;
      const part = text(delta[field]);
      if (!part) continue;
      if (!this.fields.has(field)) this.fields.set(field, "");
      const index = [...this.fields.keys()].indexOf(field);
      this.fields.set(field, this.fields.get(field)! + part);
      events.push({
        type: "content-delta",
        index,
        delta: { type: field === "reasoning_content" ? "reasoning" : "text", text: part },
      });
    }
    if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
      if (!Array.isArray(delta.tool_calls)) return invalid();
      for (const value of delta.tool_calls) {
        const call = object(value);
        const index = call.index;
        if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) > 100000)
          return invalid();
        let tool = this.tools.get(index as number);
        if (!tool) {
          tool = { id: "", name: "", arguments: "" };
          this.tools.set(index as number, tool);
        }
        if (call.type !== undefined && call.type !== "function") return invalid();
        if (call.id !== undefined) tool.id += text(call.id);
        if (call.function !== undefined) {
          const fn = object(call.function);
          if (fn.name !== undefined) tool.name += text(fn.name);
          if (fn.arguments !== undefined) tool.arguments += text(fn.arguments);
        }
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      this.terminal = nonempty(choice.finish_reason);
      if (this.terminal === "length") throw chatError("TRUNCATED");
    }
    return events;
  }

  finish(): { response: unknown; order: TextField[]; tools: Delta[] } {
    if (!this.seen || !this.terminal) throw chatError("INCOMPLETE_STREAM");
    const toolCalls: unknown[] = [];
    const events: Delta[] = [];
    for (let index = 0; index < this.tools.size; index++) {
      const tool = this.tools.get(index);
      if (!tool) return invalid();
      nonempty(tool.id);
      nonempty(tool.name);
      toolCalls.push({
        id: tool.id,
        type: "function",
        function: { name: tool.name, arguments: tool.arguments },
      });
      events.push({
        type: "content-delta",
        index: this.fields.size + index,
        delta: { type: "tool-call", callId: tool.id, name: tool.name, inputDelta: tool.arguments },
      });
    }
    return {
      response: {
        choices: [
          {
            index: 0,
            finish_reason: this.terminal,
            message: {
              role: "assistant",
              content: null,
              ...Object.fromEntries(this.fields),
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            },
          },
        ],
        ...(this.usage === undefined ? {} : { usage: this.usage }),
      },
      order: [...this.fields.keys()],
      tools: events,
    };
  }
}
