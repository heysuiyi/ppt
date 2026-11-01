import type { AgentModelSelection, AgentProvider } from "@shared/agent";
import type { AgentGatewayConfig, AgentSearchConfig } from "@shared/agent-gateway-config";
import type { ProviderTokenUsage } from "@shared/token-usage";

export type AgentResponseContract = "markdown" | "markdown-summary" | "none";

/** Provider-neutral stop reason, normalized at the driver boundary. */
export type StopReason = "end" | "max_tokens" | "tool_use" | "other";

/**
 * 原生 tool-use 的工具声明。inputSchema 为标准 JSON Schema（由 zod 转换而来），
 * 直接透传给 provider 的 tools 字段。
 */
export interface AgentToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Extended thinking block produced by providers that support thinking/reasoning.
 * When an assistant turn includes thinking + tool_use, the provider may require
 * the same blocks (with `signature`) to be round-tripped in the next request.
 * Drivers that produce thinking blocks MUST populate both `thinking` and
 * `signature` fields so the protocol remains provider-neutral.
 */
export type AgentModelTextBlock = { type: "text"; text: string };

export type AgentModelThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/** Base64 image block used in user messages and tool results. */
export interface AgentModelImageBlock {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
}

export interface AgentModelToolUseBlock {
  type: "tool_use";
  /** Provider call ID. A tool_result must reference this exact value. */
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Provider argument JSON could not be parsed; execution must return an error result. */
  parseError?: string;
}

export interface AgentModelToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: Array<AgentModelTextBlock | AgentModelImageBlock>;
  isError?: boolean;
}

/**
 * Provider-neutral model content protocol. It intentionally stays smaller
 * than local messages and tool execution records.
 */
export type AgentModelContentBlock =
  | AgentModelTextBlock
  | AgentModelThinkingBlock
  | AgentModelImageBlock
  | AgentModelToolUseBlock
  | AgentModelToolResultBlock;

/**
 * 单个多轮对话消息。原生 tool-use 路径用它承载 assistant 的 tool_use 与
 * user 的 tool_result，替代把整段 transcript 塞进 prompt 字符串的旧做法。
 */
export interface AgentModelMessage {
  role: "user" | "assistant";
  /** The sole message payload; there are no flattened compatibility fields. */
  content: AgentModelContentBlock[];
}

export interface AgentModelRequest {
  prompt: string;
  systemPrompt?: string;
  /**
   * Output contract for the provider request. Runtime prompts may already
   * include the contract text; Gateway still applies this as a final guard when
   * a specialized call uses a shorter system prompt.
   */
  responseContract?: AgentResponseContract;
  signal?: AbortSignal;
  /** Per-request override; used by output-truncation recovery. */
  maxOutputTokens?: number;
  /**
   * Native tool-use declarations. Tool calls are always returned as
   * `tool_use` content blocks; text JSON tool calls are not supported.
   */
  tools?: AgentToolSchema[];
  /**
   * Canonical multi-turn ContentBlock messages. When omitted, `prompt` is
   * converted to one user text block for specialized one-shot calls.
   */
  messages?: AgentModelMessage[];
}

/** Gateway-prepared request consumed by exactly one provider driver attempt. */
export interface PreparedAgentModelRequest {
  systemPrompt?: string;
  messages: AgentModelMessage[];
  signal?: AbortSignal;
  maxOutputTokens: number;
  tools?: AgentToolSchema[];
}

export interface AgentModelResponse {
  provider: AgentProvider;
  model: string;
  /** Sole model payload. */
  content: AgentModelContentBlock[];
  requestId?: string;
  stopReason?: StopReason;
  /** Provider-reported usage for this exact API request. */
  usage?: ProviderTokenUsage;
}

/**
 * 流式传输的单个chunk
 */
export type AgentModelStreamChunk =
  | { type: "text_delta"; text: string; index?: number }
  | { type: "thinking_delta"; thinking: string; index?: number }
  | {
      type: "complete";
      content: AgentModelContentBlock[];
      stopReason?: StopReason;
      usage?: ProviderTokenUsage;
    };

export interface ResolvedAgentModelConfig extends AgentModelSelection {
  apiKey: string;
  baseURL?: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

export interface AgentModelGateway {
  /** Optional model-gateway runtime parameters (timeout / tokens / fallback). */
  getGatewayConfig?(): AgentGatewayConfig;
  /** Optional search credentials; not part of the model I/O contract. */
  getSearchConfig?(): AgentSearchConfig;

  /** One complete model round-trip; returns neutral content blocks. */
  queryModel(
    request: AgentModelRequest,
    selection?: AgentModelSelection,
  ): Promise<AgentModelResponse>;

  /**
   * Streaming form of queryModel. Yields text/thinking deltas, then a final
   * `complete` chunk with the authoritative content and stopReason.
   */
  queryModelStream(
    request: AgentModelRequest,
    selection?: AgentModelSelection,
  ): AsyncIterable<AgentModelStreamChunk>;
}
