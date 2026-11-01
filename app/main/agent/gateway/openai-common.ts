import type { ProviderTokenUsage } from "@shared/token-usage";
import OpenAI from "openai";
import type { DriverResolvedConfig } from "./config";
import type {
  AgentModelContentBlock,
  AgentModelImageBlock,
  AgentModelResponse,
  AgentModelStreamChunk,
  AgentModelToolResultBlock,
  PreparedAgentModelRequest,
} from "./types";

export type OpenAIClient = OpenAI;

export interface OpenAIModeDriver {
  generate(
    client: OpenAIClient,
    config: DriverResolvedConfig,
    request: PreparedAgentModelRequest,
  ): Promise<AgentModelResponse>;

  generateStream(
    client: OpenAIClient,
    config: DriverResolvedConfig,
    request: PreparedAgentModelRequest,
  ): AsyncGenerator<AgentModelStreamChunk>;
}

export function createOpenAIClient(config: DriverResolvedConfig): OpenAIClient {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeoutMs,
    maxRetries: 0,
  });
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function extractOpenAIUsage(value: unknown): ProviderTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = tokenCount(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = tokenCount(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = tokenCount(usage.total_tokens) || inputTokens + outputTokens;
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details;
  const cachedInputTokens =
    details && typeof details === "object"
      ? tokenCount((details as Record<string, unknown>).cached_tokens)
      : 0;
  if (totalTokens === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

export function openAIUsageProperty(value: unknown): { usage?: ProviderTokenUsage } {
  const usage = extractOpenAIUsage(value);
  return usage ? { usage } : {};
}

export function completeChunkFromResponse(
  response: AgentModelResponse,
): Extract<AgentModelStreamChunk, { type: "complete" }> {
  return {
    type: "complete",
    content: response.content,
    stopReason: response.stopReason,
    ...(response.usage ? { usage: response.usage } : {}),
  };
}

export function toOpenAIImageUrl(image: AgentModelImageBlock): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

export function textFromBlocks(blocks: AgentModelContentBlock[]): string {
  return blocks
    .filter(
      (block): block is Extract<AgentModelContentBlock, { type: "text" }> => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

export function toolResultBodyText(result: AgentModelToolResultBlock): string {
  const text = result.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return result.isError ? `[Tool error]${text ? `\n${text}` : ""}` : text;
}

export function toolResultText(result: AgentModelToolResultBlock): string {
  const markedText = toolResultBodyText(result);
  const images = result.content.filter((block) => block.type === "image");
  return images.length > 0
    ? `${markedText}\n\n[${images.length} image attachment(s) follow in a user message]`.trim()
    : markedText;
}

export function parseToolArguments(value: string | undefined): {
  input: Record<string, unknown>;
  parseError?: string;
} {
  try {
    const parsed = value ? JSON.parse(value) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        input: {},
        parseError: "Tool arguments must decode to a JSON object.",
      };
    }
    return { input: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      input: {},
      parseError: `Invalid tool argument JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
