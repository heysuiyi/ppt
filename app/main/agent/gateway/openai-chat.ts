import type OpenAI from "openai";
import type { DriverResolvedConfig } from "./config";
import {
  completeChunkFromResponse,
  type OpenAIClient,
  type OpenAIModeDriver,
  openAIUsageProperty,
  parseToolArguments,
  textFromBlocks,
  toolResultText,
} from "./openai-common";
import type {
  AgentModelContentBlock,
  AgentModelImageBlock,
  AgentModelMessage,
  AgentModelResponse,
  AgentModelStreamChunk,
  AgentModelThinkingBlock,
  AgentModelToolResultBlock,
  AgentModelToolUseBlock,
  PreparedAgentModelRequest,
  StopReason,
} from "./types";

/** Stable signature for Chat Completions `reasoning_content` round-trips. */
const CHAT_REASONING_SIGNATURE = "chat-reasoning";

type ChatDeltaWithReasoning = {
  content?: string | null;
  reasoning_content?: string | null;
};

type ChatMessageWithReasoning = OpenAI.Chat.Completions.ChatCompletionMessage & {
  reasoning_content?: string | null;
};

type ChatAssistantMessageWithReasoning =
  OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & {
    reasoning_content?: string;
  };

type ChatRequestParams = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  "stream"
> & {
  thinking?: { type: "enabled" | "disabled" };
};

function toStopReasonFromChat(finishReason?: string | null): StopReason | undefined {
  if (!finishReason) return undefined;
  switch (finishReason) {
    case "stop":
      return "end";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "other";
  }
}

/**
 * Chat Completions multimodal `image_url` parts are rejected by several
 * OpenAI-compatible providers (observed: MiMo returns opaque HTTP 500 after
 * PreviewSvgPage thumbnails). Keep a text stub so tool-result history stays
 * coherent; Responses API retains real image parts for official vision models.
 */
function imagePlaceholderText(block: AgentModelImageBlock): string {
  return `[Image omitted for Chat Completions compatibility: ${block.mediaType}, ${block.data.length} base64 characters]`;
}

function toOpenAIUserContent(
  blocks: AgentModelContentBlock[],
): OpenAI.Chat.Completions.ChatCompletionContentPart[] | string {
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text.trim()) {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      parts.push({ type: "text", text: imagePlaceholderText(block) });
    }
  }
  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

/** MiMo (and similar) deep-thinking must be opted in via `thinking.type=enabled`. */
function wantsCompatibleThinking(config: DriverResolvedConfig): boolean {
  const model = config.model.trim().toLowerCase();
  if (model.includes("mimo")) return true;
  if (!config.baseURL) return false;
  try {
    const hostname = new URL(config.baseURL).hostname.toLowerCase();
    return (
      hostname === "xiaomimimo.com" ||
      hostname.endsWith(".xiaomimimo.com") ||
      hostname === "mimo.mi" ||
      hostname.endsWith(".mimo.mi")
    );
  } catch {
    return false;
  }
}

function reasoningFromBlocks(blocks: AgentModelContentBlock[]): string | undefined {
  const parts = blocks
    .filter(
      (block): block is Extract<AgentModelThinkingBlock, { type: "thinking" }> =>
        block.type === "thinking",
    )
    .map((block) => block.thinking);
  if (parts.length === 0) return undefined;
  return parts.join("\n");
}

function toChatMessages(
  messages: AgentModelMessage[],
  options: { roundTripReasoning: boolean },
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const toolUses = message.content.filter(
        (block): block is AgentModelToolUseBlock => block.type === "tool_use",
      );
      const reasoning = reasoningFromBlocks(message.content);
      const assistantMessage: ChatAssistantMessageWithReasoning = {
        role: "assistant",
        content: textFromBlocks(message.content),
        ...(toolUses.length
          ? {
              tool_calls: toolUses.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
          : {}),
      };
      // MiMo requires reasoning_content on assistant+tool_calls turns once thinking is on.
      if (options.roundTripReasoning || reasoning !== undefined) {
        assistantMessage.reasoning_content = reasoning ?? "";
      }
      out.push(assistantMessage);
      continue;
    }

    const toolResults = message.content.filter(
      (block): block is AgentModelToolResultBlock => block.type === "tool_result",
    );
    for (const result of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: result.toolUseId,
        content: toolResultText(result),
      });
    }

    const userBlocks = message.content.filter(
      (block) => block.type === "text" || block.type === "image",
    );
    const resultImages = toolResults.flatMap((result) =>
      result.content.filter((block): block is AgentModelImageBlock => block.type === "image"),
    );
    const combined = [...userBlocks, ...resultImages];
    if (combined.length > 0) {
      out.push({ role: "user", content: toOpenAIUserContent(combined) });
    }
  }
  return out;
}

function parseChatToolCalls(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
): AgentModelToolUseBlock[] {
  if (!toolCalls?.length) return [];
  const out: AgentModelToolUseBlock[] = [];
  for (const call of toolCalls) {
    if (call.type !== "function") continue;
    const { input, parseError } = parseToolArguments(call.function.arguments);
    out.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input,
      ...(parseError ? { parseError } : {}),
    });
  }
  return out;
}

function contentFromChatChoice(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice | undefined,
): AgentModelContentBlock[] {
  const message = choice?.message as ChatMessageWithReasoning | undefined;
  const reasoning = message?.reasoning_content?.trim();
  const text = (message?.content ?? "").trim();
  return [
    ...(reasoning
      ? [
          {
            type: "thinking" as const,
            thinking: reasoning,
            signature: CHAT_REASONING_SIGNATURE,
          },
        ]
      : []),
    ...(text ? [{ type: "text" as const, text }] : []),
    ...parseChatToolCalls(message?.tool_calls),
  ];
}

function chatRequestBase(
  config: DriverResolvedConfig,
  request: PreparedAgentModelRequest,
): ChatRequestParams {
  const enableThinking = wantsCompatibleThinking(config);
  return {
    model: config.model,
    messages: [
      ...(request.systemPrompt ? [{ role: "system" as const, content: request.systemPrompt }] : []),
      ...toChatMessages(request.messages, {
        roundTripReasoning: enableThinking,
      }),
    ],
    max_tokens: request.maxOutputTokens,
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
              strict: true,
            },
          })),
        }
      : {}),
    ...(enableThinking ? { thinking: { type: "enabled" as const } } : {}),
  };
}

type ChatCompletionWithRequestId = OpenAI.Chat.Completions.ChatCompletion & {
  _request_id?: string | null;
};

function responseFromChatCompletion(
  config: DriverResolvedConfig,
  response: ChatCompletionWithRequestId,
): AgentModelResponse {
  const choice = response.choices[0];
  return {
    provider: "openai",
    model: config.model,
    content: contentFromChatChoice(choice),
    requestId: response._request_id ?? undefined,
    stopReason: toStopReasonFromChat(choice?.finish_reason),
    ...openAIUsageProperty(response.usage),
  };
}

async function generateWithChatCompletions(
  client: OpenAIClient,
  config: DriverResolvedConfig,
  request: PreparedAgentModelRequest,
): Promise<AgentModelResponse> {
  const params = chatRequestBase(config, request);
  const response = await client.chat.completions.create(params, { signal: request.signal });
  return responseFromChatCompletion(config, response);
}

async function* generateStreamWithChatCompletions(
  client: OpenAIClient,
  config: DriverResolvedConfig,
  request: PreparedAgentModelRequest,
): AsyncGenerator<AgentModelStreamChunk> {
  const params = {
    ...chatRequestBase(config, request),
    stream_options: { include_usage: true },
  };
  const stream = client.chat.completions.stream(params, { signal: request.signal });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta as ChatDeltaWithReasoning | undefined;
    const reasoning = delta?.reasoning_content;
    if (reasoning) {
      yield { type: "thinking_delta", thinking: reasoning };
    }
    const text = delta?.content;
    if (text) {
      yield { type: "text_delta", text };
    }
  }

  const response = await stream.finalChatCompletion();
  yield completeChunkFromResponse(responseFromChatCompletion(config, response));
}

export const openAIChatDriver = {
  generate: generateWithChatCompletions,
  generateStream: generateStreamWithChatCompletions,
} satisfies OpenAIModeDriver;
