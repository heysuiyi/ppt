import type { ConversationDatabase } from "../../../conversation-database";
import { createModuleLogger, diagnosticValuePreview } from "../../logger";

const logger = createModuleLogger("agent-runtime-events");

export interface AgentRendererEvent {
  type: string;
  message: string;
  [key: string]: unknown;
}

export interface AgentEventEnvelope<TPayload = Record<string, unknown>> {
  runId?: string;
  threadId: string;
  timestamp: string;
  namespace:
    | "runtime"
    | "model"
    | "tool"
    | "background"
    | "presentation"
    | "teammate"
    | "stream"
    | "audit";
  type: string;
  payload: TPayload;
}

/** Isolates renderer and audit projections from authoritative Runtime state. */
export class AgentEventPorts {
  private readonly startedToolCalls = new Set<string>();
  private readonly terminalToolCalls = new Set<string>();
  private readonly requestedToolCallAt = new Map<string, number>();
  private readonly startedToolCallAt = new Map<string, number>();

  constructor(
    private readonly input: {
      threadId: string;
      runId?: string;
      onProgress?: (event: AgentRendererEvent) => void;
      conversationDatabase?: ConversationDatabase;
      appendTranscript(entry: Record<string, unknown>): void;
    },
  ) {}

  renderer(event: AgentRendererEvent): void {
    if (event.type === "tool-state" && typeof event.toolCallId === "string") {
      const terminal = event.status !== "running";
      if (this.terminalToolCalls.has(event.toolCallId)) return;
      if (terminal) {
        this.terminalToolCalls.add(event.toolCallId);
        const startedAt =
          this.startedToolCallAt.get(event.toolCallId) ??
          this.requestedToolCallAt.get(event.toolCallId);
        const level =
          event.status === "failed" || event.status === "invalid-input" ? "warn" : "info";
        logger[level]("tool.execution.finished", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: event.status,
          ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }),
          ...(typeof event.error === "string" ? { error: event.error } : {}),
          ...(typeof event.message === "string" ? { message: event.message } : {}),
        });
        this.startedToolCallAt.delete(event.toolCallId);
        this.requestedToolCallAt.delete(event.toolCallId);
      } else {
        if (this.startedToolCalls.has(event.toolCallId)) return;
        this.startedToolCalls.add(event.toolCallId);
        this.startedToolCallAt.set(event.toolCallId, Date.now());
        logger.info("tool.execution.started", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(typeof event.message === "string" ? { message: event.message } : {}),
        });
      }
    }
    try {
      this.input.onProgress?.(event);
    } catch (error) {
      // Renderer delivery is observational and cannot alter Runtime facts.
      logger.warn("runtime.progress.listener-failed", { eventType: event.type, error });
    }
  }

  audit(
    kind: Parameters<ConversationDatabase["appendRuntimeEvent"]>[1],
    payload: Record<string, unknown>,
    visibility: Parameters<ConversationDatabase["appendRuntimeEvent"]>[3] = "user_visible",
  ): void {
    this.logAuditEvent(kind, payload, visibility);
    if (!this.input.runId || !this.input.conversationDatabase) return;
    try {
      this.input.conversationDatabase.appendRuntimeEvent(
        this.input.runId,
        kind,
        payload,
        visibility,
      );
    } catch (error) {
      logger.warn("runtime.audit.persist-failed", { eventKind: kind, visibility, error });
      try {
        this.input.appendTranscript({
          role: "system",
          kind: "runtime_event_error",
          eventKind: kind,
          content: error instanceof Error ? error.message : String(error),
        });
      } catch (transcriptError) {
        logger.warn("runtime.audit.transcript-failed", {
          eventKind: kind,
          error: transcriptError,
        });
      }
    }
  }

  private logAuditEvent(
    kind: Parameters<ConversationDatabase["appendRuntimeEvent"]>[1],
    payload: Record<string, unknown>,
    visibility: Parameters<ConversationDatabase["appendRuntimeEvent"]>[3],
  ): void {
    if (kind === "tool_call") {
      const toolCallId = typeof payload.toolUseId === "string" ? payload.toolUseId : undefined;
      if (toolCallId) this.requestedToolCallAt.set(toolCallId, Date.now());
      const input = diagnosticValuePreview(payload.input, 512);
      logger.info("tool.call.requested", {
        toolCallId,
        toolName: payload.toolName,
        parseError: payload.parseError,
        inputType: input.valueType,
        inputKeys: input.keys,
        inputLength: input.serializedLength,
        inputPreview: input.preview,
        inputTruncated: input.truncated,
        visibility,
      });
      logger.debug("tool.call.input", {
        toolCallId,
        toolName: payload.toolName,
        input: diagnosticValuePreview(payload.input, 8 * 1024),
      });
      return;
    }
    if (kind !== "tool_result") return;
    const content = Array.isArray(payload.content) ? payload.content : [];
    const textLength = content.reduce((total, block) => {
      if (!block || typeof block !== "object" || !("text" in block)) return total;
      return total + (typeof block.text === "string" ? block.text.length : 0);
    }, 0);
    const imageCount = content.filter(
      (block) =>
        Boolean(block) && typeof block === "object" && "type" in block && block.type === "image",
    ).length;
    const result = diagnosticValuePreview(content, 512);
    logger.info("tool.result.delivered", {
      toolCallId: payload.toolUseId,
      toolName: payload.toolName,
      isError: payload.isError === true,
      contentBlockCount: content.length,
      textLength,
      imageCount,
      resultLength: result.serializedLength,
      resultPreview: result.preview,
      resultTruncated: result.truncated,
      visibility,
    });
    logger.debug("tool.call.output", {
      toolCallId: payload.toolUseId,
      toolName: payload.toolName,
      isError: payload.isError === true,
      result: diagnosticValuePreview(content, 8 * 1024),
    });
  }

  envelope<TPayload extends Record<string, unknown>>(
    namespace: AgentEventEnvelope<TPayload>["namespace"],
    type: string,
    payload: TPayload,
  ): AgentEventEnvelope<TPayload> {
    return {
      runId: this.input.runId,
      threadId: this.input.threadId,
      timestamp: new Date().toISOString(),
      namespace,
      type,
      payload,
    };
  }
}
