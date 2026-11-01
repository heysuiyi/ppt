import type { DriverResolvedConfig } from "./config";
import type { AgentProviderDriver } from "./driver";
import { openAIChatDriver } from "./openai-chat";
import { createOpenAIClient } from "./openai-common";
import { openAIResponsesDriver } from "./openai-responses";
import type { AgentModelResponse, AgentModelStreamChunk, PreparedAgentModelRequest } from "./types";

/** Chat Completions call-path driver (OpenAI-compatible endpoints). */
export const chatDriver = {
  async generate(
    config: DriverResolvedConfig,
    request: PreparedAgentModelRequest,
  ): Promise<AgentModelResponse> {
    return openAIChatDriver.generate(createOpenAIClient(config), config, request);
  },
  async *generateStream(
    config: DriverResolvedConfig,
    request: PreparedAgentModelRequest,
  ): AsyncGenerator<AgentModelStreamChunk> {
    yield* openAIChatDriver.generateStream(createOpenAIClient(config), config, request);
  },
} satisfies AgentProviderDriver;

/** Responses API call-path driver. */
export const responsesDriver = {
  async generate(
    config: DriverResolvedConfig,
    request: PreparedAgentModelRequest,
  ): Promise<AgentModelResponse> {
    return openAIResponsesDriver.generate(createOpenAIClient(config), config, request);
  },
  async *generateStream(
    config: DriverResolvedConfig,
    request: PreparedAgentModelRequest,
  ): AsyncGenerator<AgentModelStreamChunk> {
    yield* openAIResponsesDriver.generateStream(createOpenAIClient(config), config, request);
  },
} satisfies AgentProviderDriver;
