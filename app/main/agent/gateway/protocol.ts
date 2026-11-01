import { AgentGatewayError } from "./errors";
import { withEphemeralPrompt } from "./message-pairing";
import { applyResponseContract } from "./response-contract";
import type {
  AgentModelContentBlock,
  AgentModelRequest,
  AgentModelResponse,
  AgentModelStreamChunk,
  PreparedAgentModelRequest,
  ResolvedAgentModelConfig,
} from "./types";

function protocolError(message: string, config: ResolvedAgentModelConfig): AgentGatewayError {
  return new AgentGatewayError(message, "provider-error", config.provider);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validateUsage(value: unknown, config: ResolvedAgentModelConfig): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw protocolError("Provider returned malformed usage metadata.", config);
  }
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (!isTokenCount(value[key])) {
      throw protocolError(`Provider returned malformed usage.${key}.`, config);
    }
  }
  for (const key of ["cachedInputTokens", "cacheCreationInputTokens"] as const) {
    if (value[key] !== undefined && !isTokenCount(value[key])) {
      throw protocolError(`Provider returned malformed usage.${key}.`, config);
    }
  }
}

function validateOptionalString(
  value: unknown,
  field: string,
  config: ResolvedAgentModelConfig,
): void {
  if (value !== undefined && typeof value !== "string") {
    throw protocolError(`Provider returned malformed ${field}.`, config);
  }
}

const VALID_STOP_REASONS: ReadonlySet<string> = new Set(["end", "max_tokens", "tool_use", "other"]);

function validateOptionalStopReason(
  value: unknown,
  field: string,
  config: ResolvedAgentModelConfig,
): void {
  if (value !== undefined && !VALID_STOP_REASONS.has(value as string)) {
    throw protocolError(`Provider returned an unknown ${field}: ${value}.`, config);
  }
}

/** Prepare provider-neutral request state exactly once before driver dispatch. */
export function prepareAgentModelRequest(
  request: AgentModelRequest,
  config: ResolvedAgentModelConfig,
): PreparedAgentModelRequest {
  const messages = request.messages
    ? withEphemeralPrompt(request.messages, request.prompt)
    : [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: request.prompt }],
        },
      ];

  return {
    systemPrompt: applyResponseContract(request.systemPrompt, request.responseContract),
    messages,
    signal: request.signal,
    maxOutputTokens: request.maxOutputTokens ?? config.maxOutputTokens,
    tools: request.tools,
  };
}

function validateContentBlock(
  block: AgentModelContentBlock,
  config: ResolvedAgentModelConfig,
): void {
  const value: unknown = block;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw protocolError("Provider returned a malformed content block.", config);
  }

  switch (value.type) {
    case "text":
      if (typeof value.text !== "string") {
        throw protocolError("Provider returned a malformed text block.", config);
      }
      return;
    case "thinking":
      if (typeof value.thinking !== "string" || typeof value.signature !== "string") {
        throw protocolError("Provider returned a malformed thinking block.", config);
      }
      return;
    case "redacted_thinking":
      if (typeof value.data !== "string") {
        throw protocolError("Provider returned a malformed redacted-thinking block.", config);
      }
      return;
    case "image":
      if (
        typeof value.data !== "string" ||
        typeof value.mediaType !== "string" ||
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(value.mediaType)
      ) {
        throw protocolError("Provider returned a malformed image block.", config);
      }
      return;
    case "tool_use":
      if (
        typeof value.id !== "string" ||
        !value.id ||
        typeof value.name !== "string" ||
        !value.name ||
        !isRecord(value.input) ||
        (value.parseError !== undefined && typeof value.parseError !== "string")
      ) {
        throw protocolError("Provider returned a malformed tool_use block.", config);
      }
      return;
    case "tool_result":
      throw protocolError("Provider returned an unexpected tool_result block.", config);
    default:
      throw protocolError(`Provider returned an unsupported content block: ${value.type}.`, config);
  }
}

export function validateResponseContent(
  content: AgentModelContentBlock[],
  config: ResolvedAgentModelConfig,
): void {
  if (!Array.isArray(content) || content.length === 0) {
    throw new AgentGatewayError(
      `${config.provider} returned an empty response.`,
      "empty-response",
      config.provider,
    );
  }
  for (const block of content) validateContentBlock(block, config);
  const usable = content.some((block) => {
    switch (block.type) {
      case "text":
        return block.text.trim().length > 0;
      case "thinking":
        return block.thinking.trim().length > 0;
      case "redacted_thinking":
        return block.data.length > 0;
      case "image":
        return block.data.length > 0;
      case "tool_use":
        return true;
      case "tool_result":
        return false;
    }
  });
  if (!usable) {
    throw new AgentGatewayError(
      `${config.provider} returned no usable content.`,
      "empty-response",
      config.provider,
    );
  }
}

export function validateAgentModelResponse(
  response: AgentModelResponse,
  config: ResolvedAgentModelConfig,
): void {
  const value: unknown = response;
  if (!isRecord(value)) {
    throw protocolError("Provider driver returned a malformed response.", config);
  }
  if (value.provider !== config.provider || value.model !== config.model) {
    throw protocolError("Provider driver returned mismatched provider or model metadata.", config);
  }
  validateOptionalString(value.requestId, "requestId", config);
  validateOptionalStopReason(value.stopReason, "stopReason", config);
  validateUsage(value.usage, config);
  validateResponseContent(value.content as AgentModelContentBlock[], config);
}

export function validateStreamChunk(
  chunk: AgentModelStreamChunk,
  config: ResolvedAgentModelConfig,
): void {
  const value: unknown = chunk;
  if (!isRecord(value) || typeof value.type !== "string") {
    throw protocolError("Provider returned a malformed stream event.", config);
  }
  if (value.type === "text_delta") {
    if (typeof value.text !== "string") {
      throw protocolError("Provider returned a malformed text stream delta.", config);
    }
    return;
  }
  if (value.type === "thinking_delta") {
    if (typeof value.thinking !== "string") {
      throw protocolError("Provider returned a malformed thinking stream delta.", config);
    }
    return;
  }
  if (value.type !== "complete") {
    throw protocolError(`Provider returned an unsupported stream event: ${value.type}.`, config);
  }
  validateOptionalStopReason(value.stopReason, "stream stopReason", config);
  validateUsage(value.usage, config);
  validateResponseContent(value.content as AgentModelContentBlock[], config);
}
