import Anthropic from "@anthropic-ai/sdk";
import type { ProviderTokenUsage } from "@shared/token-usage";
import type { DriverResolvedConfig } from "./config";
import type { AgentProviderDriver } from "./driver";
import type {
  AgentModelContentBlock,
  AgentModelImageBlock,
  AgentModelMessage,
  AgentModelResponse,
  AgentModelStreamChunk,
  AgentModelToolResultBlock,
  PreparedAgentModelRequest,
  ResolvedAgentModelConfig,
  StopReason,
} from "./types";

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function extractAnthropicUsage(value: unknown): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = tokenCount(usage.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  const cachedInputTokens = tokenCount(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = tokenCount(usage.cache_creation_input_tokens);
  const totalTokens = inputTokens + outputTokens + cachedInputTokens + cacheCreationInputTokens;
  if (totalTokens === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
  };
}

function toStopReason(raw: string | null | undefined): StopReason | undefined {
  if (!raw) return undefined;
  switch (raw) {
    case "end_turn":
      return "end";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    default:
      return "other";
  }
}

function toAnthropicImageBlock(image: AgentModelImageBlock): Anthropic.ImageBlockParam {
  return {
    type: "image",
    source: { type: "base64", media_type: image.mediaType, data: image.data },
  };
}

function toAnthropicToolResultContent(
  result: AgentModelToolResultBlock,
): Anthropic.ToolResultBlockParam["content"] {
  return result.content.map((block) =>
    block.type === "text"
      ? { type: "text" as const, text: block.text }
      : toAnthropicImageBlock(block),
  );
}

function toAnthropicBlock(block: AgentModelContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", thinking: block.thinking, signature: block.signature };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
    case "image":
      return toAnthropicImageBlock(block);
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: toAnthropicToolResultContent(block),
        ...(block.isError ? { is_error: true } : {}),
      };
  }
}

function toAnthropicMessages(messages: AgentModelMessage[]): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(toAnthropicBlock),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractContentBlocks(content: unknown): AgentModelContentBlock[] {
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  return content.map((value): AgentModelContentBlock => {
    if (!isRecord(value) || typeof value.type !== "string") {
      throw new Error("Anthropic returned a malformed content block.");
    }
    switch (value.type) {
      case "text":
        if (typeof value.text === "string") return { type: "text", text: value.text };
        break;
      case "thinking":
        if (typeof value.thinking === "string") {
          return {
            type: "thinking",
            thinking: value.thinking,
            signature: typeof value.signature === "string" ? value.signature : "",
          };
        }
        break;
      case "redacted_thinking":
        if (typeof value.data === "string") {
          return { type: "redacted_thinking", data: value.data };
        }
        break;
      case "tool_use":
        if (
          typeof value.id === "string" &&
          typeof value.name === "string" &&
          isRecord(value.input)
        ) {
          return { type: "tool_use", id: value.id, name: value.name, input: value.input };
        }
        break;
      default:
        throw new Error(`Anthropic returned an unsupported content block: ${value.type}.`);
    }
    throw new Error(`Anthropic returned a malformed ${value.type} content block.`);
  });
}

function createAnthropicClient(config: ResolvedAgentModelConfig): Anthropic {
  return new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeoutMs,
    maxRetries: 0,
  });
}

function buildAnthropicRequest(
  config: DriverResolvedConfig,
  request: PreparedAgentModelRequest,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: config.model,
    max_tokens: request.maxOutputTokens,
    system: request.systemPrompt,
    messages: toAnthropicMessages(request.messages),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
          })),
        }
      : {}),
  };
}

/** Execute one non-streaming Anthropic driver attempt. */
export async function generateWithAnthropic(
  config: DriverResolvedConfig,
  request: PreparedAgentModelRequest,
): Promise<AgentModelResponse> {
  const response = await createAnthropicClient(config).messages.create(
    buildAnthropicRequest(config, request),
    { signal: request.signal },
  );
  const usage = extractAnthropicUsage(response.usage);
  return {
    provider: "anthropic",
    model: config.model,
    content: extractContentBlocks(response.content),
    requestId: response._request_id ?? undefined,
    stopReason: toStopReason(response.stop_reason),
    ...(usage ? { usage } : {}),
  };
}

/** Execute one streaming Anthropic driver attempt. */
export async function* generateStreamWithAnthropic(
  config: DriverResolvedConfig,
  request: PreparedAgentModelRequest,
): AsyncGenerator<AgentModelStreamChunk> {
  const stream = createAnthropicClient(config).messages.stream(
    buildAnthropicRequest(config, request),
    { signal: request.signal },
  );
  for await (const event of stream) {
    if (event.type !== "content_block_delta") continue;
    if (event.delta.type === "text_delta") {
      yield { type: "text_delta", text: event.delta.text, index: event.index };
    } else if (event.delta.type === "thinking_delta") {
      yield { type: "thinking_delta", thinking: event.delta.thinking, index: event.index };
    }
  }

  const finalMessage = await stream.finalMessage();
  const usage = extractAnthropicUsage(finalMessage.usage);
  yield {
    type: "complete",
    content: extractContentBlocks(finalMessage.content),
    stopReason: toStopReason(finalMessage.stop_reason),
    ...(usage ? { usage } : {}),
  };
}

export const anthropicDriver = {
  generate: generateWithAnthropic,
  generateStream: generateStreamWithAnthropic,
} satisfies AgentProviderDriver;
