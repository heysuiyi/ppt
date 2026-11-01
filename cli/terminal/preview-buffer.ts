import { Buffer } from "node:buffer";
import type { RunIdentity } from "@agent-harness/core/protocol-values";
import type { RuntimeEvent } from "@agent-harness/core/session/session-events";
import type { TerminalTextPreview } from "./terminal-contract.js";

const MAX_BYTES = 64 * 1024;

export interface TerminalPreviewBuffer {
  update(event: RuntimeEvent): readonly TerminalTextPreview[];
  clear(): void;
  readonly previews: readonly TerminalTextPreview[];
}

function matches(left: RunIdentity, right: RunIdentity): boolean {
  return (
    left.agentId === right.agentId &&
    left.threadId === right.threadId &&
    left.queryId === right.queryId &&
    left.runId === right.runId
  );
}

function utf8Tail(text: string, budget: number): string {
  if (budget <= 0) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= budget) return text;
  let start = bytes.length - budget;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

export function createPreviewBuffer(identity: RunIdentity): TerminalPreviewBuffer {
  const run = Object.freeze({
    agentId: identity.agentId,
    threadId: identity.threadId,
    queryId: identity.queryId,
    runId: identity.runId,
  });
  let previews: readonly TerminalTextPreview[] = Object.freeze([]);
  const previewRequests = new Set<string>();
  let truncated = false;
  const clear = () => {
    previews = Object.freeze([]);
    previewRequests.clear();
    truncated = false;
  };
  return {
    get previews() {
      return previews;
    },
    clear,
    update(event) {
      if (!matches(run, event.identity)) return previews;
      if (event.kind === "fact") {
        if (
          event.type === "run.completed" ||
          event.type === "run.waiting" ||
          event.type === "run.failed" ||
          event.type === "run.cancelled" ||
          event.type === "run.interrupted"
        )
          clear();
        return previews;
      }
      if (
        (event.delta.type !== "text" && event.delta.type !== "reasoning") ||
        event.delta.text.length === 0
      )
        return previews;
      const requestKey = JSON.stringify([event.step, event.requestId]);
      if (event.type === "model.preview") previewRequests.add(requestKey);
      else if (event.delta.type === "text" && previewRequests.has(requestKey)) return previews;
      const position =
        event.type === "model.preview"
          ? { previewId: event.previewId }
          : { contentIndex: event.contentIndex };
      const next = Array.from(previews);
      const index = next.findIndex(
        (item) =>
          item.step === event.step &&
          item.requestId === event.requestId &&
          (event.type === "model.preview"
            ? item.previewId === event.previewId
            : item.contentIndex === event.contentIndex),
      );
      const text = (index >= 0 ? next[index]!.text : "") + event.delta.text;
      const preview: TerminalTextPreview = {
        identity: run,
        step: event.step,
        requestId: event.requestId,
        ...position,
        text,
        truncated,
        ...(event.delta.type === "reasoning" ? { reasoning: true } : {}),
      };
      if (index >= 0) next[index] = preview;
      else next.push(preview);
      let bytes = next.reduce((total, item) => total + Buffer.byteLength(item.text, "utf8"), 0);
      while (bytes > MAX_BYTES && next.length > 0) {
        truncated = true;
        const first = next[0]!;
        const size = Buffer.byteLength(first.text, "utf8");
        const keep = Math.max(0, size - (bytes - MAX_BYTES));
        if (keep === 0) {
          next.shift();
          bytes -= size;
        } else {
          const tail = utf8Tail(first.text, keep);
          next[0] = {
            ...first,
            text: tail,
            truncated: true,
          };
          bytes -= size - Buffer.byteLength(tail, "utf8");
        }
      }
      previews = Object.freeze(
        next.map((item) =>
          Object.freeze({
            ...item,
            text: item.text,
            truncated,
          }),
        ),
      );
      return previews;
    },
  };
}
