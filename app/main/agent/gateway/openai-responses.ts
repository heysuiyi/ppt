import type OpenAI from "openai";
import type { DriverResolvedConfig } from "./config";
import {
  completeChunkFromResponse,
  type OpenAIClient,
  type OpenAIModeDriver,
  openAIUsageProperty,
  parseToolArguments,
  toOpenAIImageUrl,
  toolResultBodyText,
  toolResultText,
} from "./openai-common";
import type {
  AgentModelContentBlock,
  AgentModelImageBlock,
  AgentModelMessage,
  AgentModelResponse,
  AgentModelStreamChunk,
  AgentModelToolResultBlock,
  AgentModelToolUseBlock,
  PreparedAgentModelRequest,
  StopReason,
} from "./types";

function toResponsesMessageContent(
  blocks: AgentModelContentBlock[],
): OpenAI.Responses.ResponseInputMessageContentList | string {
  const parts: OpenAI.Responses.ResponseInputMessageContentList = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text.trim()) {
      parts.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      parts.push({
        type: "input_image",
        image_url: toOpenAIImageUrl(block),
        detail: "auto",
      });
    }
  }
  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0].type === "input_text") return parts[0].text;
  return parts;
}

function toResponsesToolOutput(
  result: AgentModelToolResultBlock,
): OpenAI.Responses.ResponseFunctionCallOutputItemList | string {
  const images = result.content.filter(
    (block): block is AgentModelImageBlock => block.type === "image",
  );
  if (images.length === 0) {
    return toolResultText(result);
  }

  const output: OpenAI.Responses.ResponseFunctionCallOutputItemList = [];
  const markedText = toolResultBodyText(result);
  if (markedText.trim()) {
    output.push({ type: "input_text", text: markedText });
  }
  for (const block of result.content) {
    if (block.type === "image") {
      output.push({
        type: "input_image",
        image_url: toOpenAIImageUrl(block),
        detail: "auto",
      });
    }
  }
  return output;
}

function toResponsesInput(messages: AgentModelMessage[]): OpenAI.Responses.ResponseInput {
  const out: OpenAI.Responses.ResponseInput = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      const messageContent = toResponsesMessageContent(message.content);
      if (typeof messageContent === "string" ? messageContent : messageContent.length > 0) {
        out.push({ role: "assistant", content: messageContent });
      }
      for (const call of message.content) {
        if (call.type !== "tool_use") continue;
        out.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input),
        });
      }
      continue;
    }

    for (const result of message.content) {
      if (result.type !== "tool_result") continue;
      out.push({
        type: "function_call_output",
        call_id: result.toolUseId,
        output: toResponsesToolOutput(result),
      });
    }

    const userContent = toResponsesMessageContent(
      message.content.filter((block) => block.type === "text" || block.type === "image"),
    );
    if (typeof userContent === "string" ? userContent : userContent.length > 0) {
      out.push({ role: "user", content: userContent });
    }
  }
  return out;
}

function contentFromResponsesOutput(response: OpenAI.Responses.Response): AgentModelContentBlock[] {
  const text = response.output_text.trim();
  const thinking: AgentModelContentBlock[] = [];
  const toolCalls: AgentModelToolUseBlock[] = [];
  for (const item of response.output ?? []) {
    if (item.type === "reasoning") {
      const summary = item.summary
        .map((part) => part.text)
        .join("\n\n")
        .trim();
      const reasoning =
        summary ||
        item.content
          ?.map((part) => part.text)
          .join("\n\n")
          .trim();
      if (reasoning) {
        thinking.push({
          type: "thinking",
          thinking: reasoning,
          signature: item.id,
        });
      }
      continue;
    }
    if (item.type !== "function_call") continue;
    const { input, parseError } = parseToolArguments(item.arguments);
    toolCalls.push({
      type: "tool_use",
      id: item.call_id,
      name: item.name,
      input,
      ...(parseError ? { parseError } : {}),
    });
  }
  return [...thinking, ...(text ? [{ type: "text" as const, text }] : []), ...toolCalls];
}

function stopReasonFromResponses(response: OpenAI.Responses.Response): StopReason {
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "max_output_tokens") return "max_tokens";
    return "other";
  }
  return response.output.some((item) => item.type === "function_call") ? "tool_use" : "end";
}

function responsesRequestBase(
  config: DriverResolvedConfig,
  request: PreparedAgentModelRequest,
): Omit<OpenAI.Responses.ResponseCreateParamsNonStreaming, "stream"> {
  return {
    model: config.model,
    instructions: request.systemPrompt,
    input: toResponsesInput(request.messages),
    max_output_tokens: request.maxOutputTokens,
    reasoning: {
      effort: (config.reasoningEffort ?? "medium") as OpenAI.ReasoningEffort,
      summary: "auto",
    },
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function" as const,
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: true,
          })),
        }
      : {}),
  };
}

type ResponseWithRequestId = OpenAI.Responses.Response & {
  _request_id?: string | null;
};

function responseFromResponsesOutput(
  config: DriverResolvedConfig,
  response: ResponseWithRequestId,
): AgentModelResponse {
  return {
    provider: "openai",
    model: config.model,
    content: contentFromResponsesOutput(response),
    requestId: response._request_id ?? undefined,
    stopReason: stopReasonFromResponses(response),
    ...openAIUsageProperty(response.usage),
  };
}

async function generateWithResponses(
  client: OpenAIClient,
  config: DriverResolvedConfig,
  request: PreparedAgentModelRequest,
): Promise<AgentModelResponse> {
  const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = responsesRequestBase(
    config,
    request,
  );
  const response = await client.responses.create(params, { signal: request.signal });
  return responseFromResponsesOutput(config, response);
}

async function* generateStreamWithResponses(
  client: OpenAIClient,
  config: DriverResolvedConfig,
  request: PreparedAgentModelRequest,
): AsyncGenerator<AgentModelStreamChunk> {
  const stream = client.responses.stream(responsesRequestBase(config, request), {
    signal: request.signal,
  });

  for await (const event of stream) {
    if (
      (event.type === "response.reasoning_summary_text.delta" ||
        event.type === "response.reasoning_text.delta") &&
      event.delta
    ) {
      yield { type: "thinking_delta", thinking: event.delta, index: event.output_index };
    } else if (event.type === "response.output_text.delta" && event.delta) {
      yield { type: "text_delta", text: event.delta };
    }
  }

  const response = await stream.finalResponse();
  yield completeChunkFromResponse(responseFromResponsesOutput(config, response));
}

export const openAIResponsesDriver = {
  generate: generateWithResponses,
  generateStream: generateStreamWithResponses,
} satisfies OpenAIModeDriver;
