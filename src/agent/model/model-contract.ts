import type { Disposable, JsonObject, JsonValue } from "../protocol-values";

export interface ModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  /** 由适配器定义的值；协议不枚举提供方特定的推理力度级别。 */
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

/** 仅包含适配器可公开的推理内容；私有推理属于重放状态。 */
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

/** 刻意排除业务值、展示载荷与嵌套工具调用。 */
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

/** 对内核不透明。只有适配器决定该状态是否可重用。 */
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

/** 保留内容顺序与重放状态；UI 文本无法重建规范消息。 */
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

/** 工具输入增量是不完整的 JSON 片段，而非已校验的工具调用。 */
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
 * 增量是临时的，按最终助手内容位置索引。成功的流以恰好一个权威的完成响应结束；
 * 持久化该响应，而非重建的增量。取消或失败可能在没有 completed 的情况下终止。
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

/** 凭据与提供方服务由具体工厂捕获，而非请求。 */
export interface ModelClientFactory {
  create(selection: ModelSelection): Promise<ModelClient>;
}

/** 必须拒绝重复的提供方路由；释放仅移除该注册。 */
export interface ModelRegistrar {
  register(providerId: string, factory: ModelClientFactory): Disposable;
}
