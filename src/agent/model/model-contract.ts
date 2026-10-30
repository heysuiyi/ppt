import type { Disposable, JsonObject, JsonValue } from "../protocol-values";

export interface ModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  /** Adapter-defined value; the protocol does not enumerate provider-specific effort levels. */
  readonly reasoningEffort?: string;
}

export interface ModelTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ModelImageContent {
  readonly type: "image";
  readonly source:
    | { readonly type: "url"; readonly url: string }
    | { readonly type: "base64"; readonly mediaType: string; readonly data: string };
}

/** Only reasoning that the adapter can expose; private reasoning belongs in replay state. */
export interface ModelReasoningContent {
  readonly type: "reasoning";
  readonly text: string;
}

export interface ModelToolCallContent {
  readonly type: "tool-call";
  readonly callId: string;
  readonly name: string;
  readonly input: JsonObject;
}

/** Deliberately excludes business values, presentation payloads and nested tool calls. */
export type ModelToolContent = ModelTextContent | ModelImageContent;

export interface ModelToolResultContent {
  readonly type: "tool-result";
  readonly callId: string;
  readonly content: readonly ModelToolContent[];
  readonly isError?: boolean;
}

export type ModelContent =
  | ModelTextContent
  | ModelImageContent
  | ModelReasoningContent
  | ModelToolCallContent
  | ModelToolResultContent;

/** Opaque to the kernel. Only the adapter decides whether this state is reusable. */
export interface ModelReplayState {
  readonly providerId: string;
  readonly modelId: string;
  readonly format: string;
  readonly version: number;
  readonly data: JsonValue;
}

export interface ModelAssistantMessage {
  readonly role: "assistant";
  readonly content: readonly (ModelTextContent | ModelReasoningContent | ModelToolCallContent)[];
  readonly replayState?: ModelReplayState;
}

/** Preserve content order and replay state; UI text cannot reconstruct canonical messages. */
export type ModelMessage =
  | { readonly role: "system"; readonly content: readonly ModelTextContent[] }
  | { readonly role: "user"; readonly content: readonly ModelToolContent[] }
  | ModelAssistantMessage
  | { readonly role: "tool"; readonly content: readonly ModelToolResultContent[] };

export interface ModelToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolSchema[];
  readonly maxOutputTokens?: number;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelResponse {
  readonly message: ModelAssistantMessage;
  readonly finishReason: "stop" | "tool-calls" | "length" | "other";
  readonly usage?: ModelUsage;
}

/** Tool input deltas are incomplete JSON fragments, not validated tool calls. */
export type ModelContentDelta =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly inputDelta: string;
    };

/**
 * Deltas are provisional and indexed by final assistant content position. A successful
 * stream ends with exactly one authoritative completed response; persist that response,
 * not reconstructed deltas. Cancellation or failure can terminate without completed.
 */
export type ModelStreamEvent =
  | { readonly type: "content-delta"; readonly index: number; readonly delta: ModelContentDelta }
  | { readonly type: "completed"; readonly response: ModelResponse };

export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly toolCalls: boolean;
  readonly images: boolean;
  readonly reasoning: boolean;
}

export interface ModelClient {
  readonly selection: ModelSelection;
  readonly capabilities: ModelCapabilities;
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

/** Credentials and provider services are captured by the concrete factory, not requests. */
export interface ModelClientFactory {
  create(selection: ModelSelection): Promise<ModelClient>;
}

/** Duplicate provider routes must be rejected; disposal removes only this registration. */
export interface ModelRegistrar {
  register(providerId: string, factory: ModelClientFactory): Disposable;
}
