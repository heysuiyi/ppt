import { z } from "zod";
import { agentModelSelectionSchema, agentModelSettingsSchema } from "./agent";

export const DEFAULT_AGENT_GATEWAY_CONFIG = {
  timeoutMs: 180_000,
  maxOutputTokens: 16_384,
} as const;

export const DEFAULT_AGENT_SEARCH_CONFIG = {
  webSearchTimeoutMs: 20_000,
} as const;

export const DEFAULT_WEB_SEARCH_ENDPOINT = "https://api.tavily.com/search";

/** Persisted by Main; fallbackModelId is resolved against the saved model catalog. */
export const agentGatewayPreferencesSchema = z.object({
  timeoutMs: z.number().int().positive().default(DEFAULT_AGENT_GATEWAY_CONFIG.timeoutMs),
  maxOutputTokens: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_AGENT_GATEWAY_CONFIG.maxOutputTokens),
  fallbackModelId: z.string().trim().optional(),
  webSearchEndpoint: z.string().trim().optional(),
  webSearchTimeoutMs: z.number().int().positive().optional(),
});

/** Model-gateway runtime parameters passed into AgentGateway. */
export const agentGatewayConfigSchema = z.object({
  timeoutMs: z.number().int().positive().default(DEFAULT_AGENT_GATEWAY_CONFIG.timeoutMs),
  maxOutputTokens: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_AGENT_GATEWAY_CONFIG.maxOutputTokens),
  fallbackModel: agentModelSettingsSchema.optional(),
});

/** External search credentials; not part of the model gateway contract. */
export const agentSearchConfigSchema = z.object({
  webSearchApiKey: z.string().trim().optional(),
  webSearchEndpoint: z.string().trim().optional(),
  webSearchTimeoutMs: z.number().int().positive().optional(),
});

/** Secret-free service configuration resolved inside Main before credential hydration. */
export const agentRunServicesWireSchema = z
  .object({
    timeoutMs: z.number().int().positive().default(DEFAULT_AGENT_GATEWAY_CONFIG.timeoutMs),
    maxOutputTokens: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_AGENT_GATEWAY_CONFIG.maxOutputTokens),
    fallbackModel: agentModelSelectionSchema.optional(),
    webSearchEndpoint: z.string().trim().optional(),
    webSearchTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export type AgentGatewayPreferences = z.infer<typeof agentGatewayPreferencesSchema>;
export type AgentGatewayConfig = z.infer<typeof agentGatewayConfigSchema>;
export type AgentSearchConfig = z.infer<typeof agentSearchConfigSchema>;
export type AgentRunServicesWire = z.infer<typeof agentRunServicesWireSchema>;

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

/** Split resolved service configuration before Main adds credentials. */
export function splitAgentRunServicesConfig(input?: Partial<AgentRunServicesWire>): {
  gateway: AgentGatewayConfig;
  search: AgentSearchConfig;
} {
  const parsed = agentRunServicesWireSchema.parse({
    ...DEFAULT_AGENT_GATEWAY_CONFIG,
    ...input,
  });
  return {
    gateway: {
      timeoutMs: parsed.timeoutMs,
      maxOutputTokens: parsed.maxOutputTokens,
      ...(parsed.fallbackModel ? { fallbackModel: parsed.fallbackModel } : {}),
    },
    search: {
      ...(parsed.webSearchEndpoint ? { webSearchEndpoint: parsed.webSearchEndpoint } : {}),
      ...(parsed.webSearchTimeoutMs ? { webSearchTimeoutMs: parsed.webSearchTimeoutMs } : {}),
    },
  };
}
