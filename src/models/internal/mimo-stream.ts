import type { ModelContentDelta, ModelStreamEvent } from "@agent-harness/core/model/model-contract";
import { invalid, MimoModelError, nonempty, object, text } from "./mimo-errors";
import { projectItem, same } from "./mimo-responses";

type Delta = Extract<ModelStreamEvent, { type: "content-delta" }>;
interface Slot {
  type: "text" | "reasoning" | "tool-call";
  value: string;
  emitted: string;
  done: boolean;
  observed: boolean;
  index?: number;
}
interface Item {
  id?: string;
  added?: Record<string, unknown>;
  final?: Record<string, unknown>;
  slots: Map<string, Slot>;
  base?: number;
}

/** 使用 SDK 原始事件，不依赖 SDK 对厂商 reasoning.content 的聚合。 */
export class MimoStreamProjection {
  private readonly items = new Map<number, Item>();
  private readonly ids = new Map<string, number>();
  private terminal?: Record<string, unknown>;

  accept(value: unknown): Delta[] {
    if (this.terminal) return invalid();
    const event = object(value);
    const type = text(event.type);
    if (type === "response.completed") {
      this.terminal = object(event.response);
      if (this.terminal.status !== "completed") return invalid();
      return this.settle();
    }
    if (type === "response.incomplete") {
      const response = object(event.response);
      if (object(response.incomplete_details).reason === "max_output_tokens") {
        throw new MimoModelError("TRUNCATED");
      }
      return invalid();
    }
    if (type === "error" || type === "response.failed") return invalid();
    if (["response.created", "response.in_progress", "response.queued"].includes(type)) return [];
    const relevant =
      type.startsWith("response.output_item.") ||
      type.startsWith("response.content_part.") ||
      type.startsWith("response.output_text.") ||
      type.startsWith("response.reasoning_text.") ||
      type.startsWith("response.reasoning_summary_") ||
      type.startsWith("response.function_call_arguments.");
    if (!relevant) return invalid();
    const outputIndex = this.position(event.output_index);
    let item = this.items.get(outputIndex);
    if (!item) {
      item = { slots: new Map() };
      this.items.set(outputIndex, item);
    }
    if (item.final) return invalid();
    if (event.item_id !== undefined) this.identify(item, outputIndex, event.item_id);
    if (type === "response.output_item.added") {
      if (item.added) return invalid();
      item.added = object(event.item);
      this.identify(item, outputIndex, item.added.id);
      if (!["message", "reasoning", "function_call"].includes(text(item.added.type)))
        return invalid();
      if (item.added.type === "function_call") {
        nonempty(item.added.call_id);
        nonempty(item.added.name);
        this.seed(item, "call", "tool-call", text(item.added.arguments));
      } else {
        this.seedParts(item, item.added, false);
      }
    } else if (type === "response.output_item.done") {
      const final = object(event.item);
      this.identify(item, outputIndex, final.id);
      if (!item.added || final.type !== item.added.type) return invalid();
      if (
        final.type === "function_call" &&
        (final.call_id !== item.added.call_id || final.name !== item.added.name)
      )
        return invalid();
      projectItem(final);
      this.finishItem(item, final);
      item.final = final;
    } else if (
      type === "response.content_part.added" ||
      type === "response.content_part.done" ||
      type === "response.reasoning_summary_part.added" ||
      type === "response.reasoning_summary_part.done"
    ) {
      const summary = type.includes("reasoning_summary");
      const key = `${summary ? "s" : "c"}:${this.position(summary ? event.summary_index : event.content_index)}`;
      const part = object(event.part);
      const kind =
        part.type === "output_text"
          ? "text"
          : part.type === "reasoning_text" || part.type === "summary_text"
            ? "reasoning"
            : invalid();
      if (type.endsWith(".added")) this.seed(item, key, kind, text(part.text));
      else this.finishSlot(item, key, kind, text(part.text));
    } else {
      const call = type.includes("function_call_arguments");
      const summary = type.includes("reasoning_summary");
      const key = call
        ? "call"
        : `${summary ? "s" : "c"}:${this.position(summary ? event.summary_index : event.content_index)}`;
      const kind = call ? "tool-call" : type.includes("output_text") ? "text" : "reasoning";
      const slot = this.slot(item, key, kind);
      if (type.endsWith(".delta")) {
        if (slot.done) return invalid();
        slot.value += text(event.delta);
        slot.observed = true;
      } else if (type.endsWith(".done")) {
        this.finishSlot(item, key, kind, text(call ? event.arguments : event.text));
      } else return invalid();
    }
    return this.flush();
  }

  finish(): Record<string, unknown> {
    if (!this.terminal) throw new MimoModelError("INCOMPLETE_STREAM");
    return this.terminal;
  }

  private position(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100000)
      return invalid();
    return value as number;
  }

  private identify(item: Item, index: number, value: unknown): void {
    const id = nonempty(value);
    if (
      (item.id !== undefined && item.id !== id) ||
      (this.ids.has(id) && this.ids.get(id) !== index)
    ) {
      invalid();
    }
    item.id = id;
    this.ids.set(id, index);
  }

  private slot(item: Item, key: string, type: Slot["type"]): Slot {
    let slot = item.slots.get(key);
    if (!slot) {
      slot = { type, value: "", emitted: "", done: false, observed: false };
      item.slots.set(key, slot);
    } else if (slot.type !== type) return invalid();
    return slot;
  }

  private seed(item: Item, key: string, type: Slot["type"], value: string): void {
    const slot = this.slot(item, key, type);
    if (slot.done || (value && slot.observed)) invalid();
    if (value) {
      slot.value = value;
      slot.observed = true;
    }
  }

  private finishSlot(item: Item, key: string, type: Slot["type"], value: string): void {
    const slot = this.slot(item, key, type);
    if (slot.observed && slot.value !== value) invalid();
    slot.value = value;
    slot.observed = true;
    slot.done = true;
  }

  private seedParts(item: Item, raw: Record<string, unknown>, done: boolean): string[] {
    const keys: string[] = [];
    for (const field of raw.type === "reasoning" ? ["summary", "content"] : ["content"]) {
      const parts = raw[field];
      if (parts === undefined) continue;
      if (!Array.isArray(parts)) return invalid();
      parts.forEach((value, i) => {
        const part = object(value);
        const kind =
          part.type === "output_text"
            ? "text"
            : part.type === "reasoning_text" || part.type === "summary_text"
              ? "reasoning"
              : invalid();
        const key = `${field === "summary" ? "s" : "c"}:${i}`;
        keys.push(key);
        if (done) this.finishSlot(item, key, kind, text(part.text));
        else this.seed(item, key, kind, text(part.text));
      });
    }
    return keys;
  }

  private finishItem(item: Item, final: Record<string, unknown>): void {
    let keys: string[];
    if (final.type === "function_call") {
      keys = ["call"];
      this.finishSlot(item, "call", "tool-call", text(final.arguments));
    } else keys = this.seedParts(item, final, true);
    if (keys.length !== item.slots.size || keys.some((key) => !item.slots.has(key))) invalid();
  }

  private ordered(item: Item): Slot[] {
    if (item.added?.type === "function_call") return [this.slot(item, "call", "tool-call")];
    return [...item.slots.entries()]
      .sort(([a], [b]) => {
        const [af, ai] = a.split(":");
        const [bf, bi] = b.split(":");
        return af === bf ? Number(ai) - Number(bi) : af === "s" ? -1 : 1;
      })
      .map(([, slot]) => slot);
  }

  private flush(): Delta[] {
    const result: Delta[] = [];
    let base = 0;
    for (let i = 0; i < this.items.size; i++) {
      const item = this.items.get(i);
      if (!item?.added) break;
      item.base = base;
      // reasoning 可同时携带 summary/content，结构确定前不猜其规范顺序。
      if (item.added.type === "reasoning" && !item.final) break;
      const slots = this.ordered(item);
      for (let j = 0; j < slots.length; j++) {
        const slot = slots[j];
        if (!item.final && item.added.type !== "function_call" && !item.slots.has(`c:${j}`)) break;
        const index = base + j;
        if (slot.index !== undefined && slot.index !== index) return invalid();
        slot.index = index;
        if (!slot.value.startsWith(slot.emitted)) return invalid();
        const suffix = slot.value.slice(slot.emitted.length);
        if (suffix) {
          let delta: ModelContentDelta;
          if (slot.type === "tool-call") {
            delta = {
              type: "tool-call",
              callId: nonempty(item.added.call_id),
              name: nonempty(item.added.name),
              inputDelta: suffix,
            };
          } else delta = { type: slot.type, text: suffix };
          result.push({ type: "content-delta", index, delta });
          slot.emitted = slot.value;
        }
        if (!slot.done) break;
      }
      if (!item.final) break;
      base += slots.length;
    }
    return result;
  }

  private settle(): Delta[] {
    if (!Array.isArray(this.terminal?.output) || this.terminal.output.length !== this.items.size)
      return invalid();
    for (let i = 0; i < this.terminal.output.length; i++) {
      const item = this.items.get(i);
      if (!item?.final || !same(item.final, this.terminal.output[i])) return invalid();
    }
    return this.flush();
  }
}
