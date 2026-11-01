import { z } from "zod";

export const agentProviderSchema = z.enum(["openai", "anthropic"]);
export const agentExecutionStrategySchema = z.enum(["REQUEST_APPROVAL", "AUTO"]);

export const agentModelSettingsSchema = z.object({
  configurationId: z.string().trim().min(1).optional(),
  /** Vendor connection id used for credential lookup. */
  vendorId: z.string().trim().min(1).optional(),
  provider: agentProviderSchema,
  model: z.string().trim().min(1),
  apiKey: z.string().trim().min(1).optional(),
  baseURL: z.string().trim().url().optional(),
  openaiApiMode: z.enum(["responses", "chat-completions"]).optional(),
  reasoningEffort: z.string().min(1).optional(),
  supports1MContext: z.boolean().optional(),
});
export const agentModelSelectionSchema = agentModelSettingsSchema.omit({ apiKey: true }).strict();

export type AgentProvider = z.infer<typeof agentProviderSchema>;
export type AgentExecutionStrategy = z.infer<typeof agentExecutionStrategySchema>;
export type AgentModelSettings = z.infer<typeof agentModelSettingsSchema>;
export type AgentModelSelection = z.infer<typeof agentModelSelectionSchema>;
