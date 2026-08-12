import { describe, expect, it } from "vitest";
import {
  AgentGateway,
  type AgentModelStreamChunk,
  textFromContentBlocks,
} from "../src/main/agent/gateway";
import {
  hasEnvironment,
  requiredEnvironment,
  resolveAnthropicBaseURL,
  resolveOpenAiBaseURL,
} from "./integration-env";

const OPENAI_AVAILABLE = hasEnvironment("OPENAI_API_KEY", "OPENAI_MODEL");
const ANTHROPIC_AVAILABLE = hasEnvironment("ANTHROPIC_API_KEY", "ANTHROPIC_MODEL");

function providerBaseURL(provider: "openai" | "anthropic"): string | undefined {
  return provider === "openai" ? resolveOpenAiBaseURL() : resolveAnthropicBaseURL();
}

async function expectUsefulStream(
  provider: "openai" | "anthropic",
  model: string,
  apiKey: string,
): Promise<void> {
  const gateway = new AgentGateway();
  const baseURL = providerBaseURL(provider);
  const selection = gateway.configure({
    provider,
    model,
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
  const chunks: AgentModelStreamChunk[] = [];

  for await (const chunk of gateway.queryModelStream(
    {
      systemPrompt: "You are a connectivity test. Reply with one short sentence only.",
      prompt: `Confirm that the ${provider} streaming gateway request succeeded.`,
    },
    selection,
  )) {
    chunks.push(chunk);
  }

  expect(chunks.filter((chunk) => chunk.type === "complete")).toHaveLength(1);
  const finalChunk = chunks.at(-1);
  expect(finalChunk?.type).toBe("complete");
  if (finalChunk?.type !== "complete") {
    throw new Error(`${provider} stream did not end with a complete chunk.`);
  }

  const streamedText = chunks
    .filter((chunk) => chunk.type === "text_delta")
    .map((chunk) => chunk.text)
    .join("");
  expect(streamedText.trim().length).toBeGreaterThan(0);
  expect(textFromContentBlocks(finalChunk.content).trim().length).toBeGreaterThan(0);
}

describe.sequential("AgentGateway real provider integration", () => {
  it.skipIf(!OPENAI_AVAILABLE)(
    "generates text through the configured OpenAI-compatible endpoint",
    async () => {
      const model = requiredEnvironment("OPENAI_MODEL");
      const gateway = new AgentGateway();
      const baseURL = resolveOpenAiBaseURL();
      const selection = gateway.configure({
        provider: "openai",
        model,
        apiKey: requiredEnvironment("OPENAI_API_KEY"),
        ...(baseURL ? { baseURL } : {}),
      });

      const response = await gateway.queryModel(
        {
          systemPrompt: "You are a connectivity test. Reply with one short sentence only.",
          prompt: "Confirm that the OpenAI-compatible gateway request succeeded.",
        },
        selection,
      );

      expect(response.provider).toBe("openai");
      expect(response.model).toBe(model);
      expect(textFromContentBlocks(response.content).trim().length).toBeGreaterThan(0);
    },
    120_000,
  );

  it.skipIf(!OPENAI_AVAILABLE)(
    "streams text through the configured OpenAI-compatible endpoint",
    async () => {
      await expectUsefulStream(
        "openai",
        requiredEnvironment("OPENAI_MODEL"),
        requiredEnvironment("OPENAI_API_KEY"),
      );
    },
    120_000,
  );

  it.skipIf(!ANTHROPIC_AVAILABLE)(
    "generates text through the configured Anthropic-compatible endpoint",
    async () => {
      const model = requiredEnvironment("ANTHROPIC_MODEL");
      const gateway = new AgentGateway();
      const baseURL = resolveAnthropicBaseURL();
      const selection = gateway.configure({
        provider: "anthropic",
        model,
        apiKey: requiredEnvironment("ANTHROPIC_API_KEY"),
        ...(baseURL ? { baseURL } : {}),
      });

      const response = await gateway.queryModel(
        {
          systemPrompt: "You are a connectivity test. Reply with one short sentence only.",
          prompt: "Confirm that the Anthropic-compatible gateway request succeeded.",
        },
        selection,
      );

      expect(response.provider).toBe("anthropic");
      expect(response.model).toBe(model);
      expect(textFromContentBlocks(response.content).trim().length).toBeGreaterThan(0);
    },
    120_000,
  );

  it.skipIf(!ANTHROPIC_AVAILABLE)(
    "streams text through the configured Anthropic-compatible endpoint",
    async () => {
      await expectUsefulStream(
        "anthropic",
        requiredEnvironment("ANTHROPIC_MODEL"),
        requiredEnvironment("ANTHROPIC_API_KEY"),
      );
    },
    120_000,
  );
});
