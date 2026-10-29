import { z } from "zod";
import { agentModelSettingsSchema } from "./agent";

export const DEFAULT_AGENT_GATEWAY_CONFIG = {
  timeoutMs: 180_000,
  maxOutputTokens: 16_384,
} as const;

export const DEFAULT_WEB_SEARCH_ENDPOINT = "https://api.tavily.com/search";

/** Persisted by Main; fallbackModelId is resolved against the saved model catalog. */
export const agentGatewayPreferencesSchema = z
  .object({
    timeoutMs: z.number().int().positive().default(DEFAULT_AGENT_GATEWAY_CONFIG.timeoutMs),
    maxOutputTokens: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_AGENT_GATEWAY_CONFIG.maxOutputTokens),
    fallbackModelId: z.string().trim().optional(),
    webSearchEndpoint: z.string().trim().optional(),
    webSearchTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

/** Model-gateway runtime parameters passed into AgentGateway. */
const agentGatewayConfigSchema = z.object({
  timeoutMs: z.number().int().positive().default(DEFAULT_AGENT_GATEWAY_CONFIG.timeoutMs),
  maxOutputTokens: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_AGENT_GATEWAY_CONFIG.maxOutputTokens),
  fallbackModel: agentModelSettingsSchema.optional(),
});

/** External search credentials; not part of the model gateway contract. */
const agentSearchConfigSchema = z.object({
  webSearchApiKey: z.string().trim().optional(),
  webSearchEndpoint: z.string().trim().optional(),
  webSearchTimeoutMs: z.number().int().positive().optional(),
});

export type AgentGatewayPreferences = z.infer<typeof agentGatewayPreferencesSchema>;
export type AgentGatewayConfig = z.infer<typeof agentGatewayConfigSchema>;
export type AgentSearchConfig = z.infer<typeof agentSearchConfigSchema>;

export function resolveAgentGatewayPreferences(
  input?: Partial<AgentGatewayPreferences>,
): AgentGatewayPreferences {
  return agentGatewayPreferencesSchema.parse({
    ...DEFAULT_AGENT_GATEWAY_CONFIG,
    ...input,
  });
}

export function resolveAgentGatewayConfig(input?: Partial<AgentGatewayConfig>): AgentGatewayConfig {
  return agentGatewayConfigSchema.parse({
    ...DEFAULT_AGENT_GATEWAY_CONFIG,
    ...input,
  });
}

export function resolveAgentSearchConfig(input?: Partial<AgentSearchConfig>): AgentSearchConfig {
  return agentSearchConfigSchema.parse({
    ...input,
  });
}
