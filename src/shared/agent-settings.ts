import { z } from "zod";
import { agentExecutionStrategySchema, agentProviderSchema } from "./agent";
import { agentGatewayPreferencesSchema } from "./agent-gateway-config";
import { agentStepLimitsSchema } from "./agent-step-limits";

const modelSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    model: z.string().trim().min(1),
    openaiApiMode: z.enum(["responses", "chat-completions"]),
    supports1MContext: z.boolean().optional(),
    enabled: z.boolean(),
    pricing: z
      .object({
        currency: z.enum(["CNY", "USD"]),
        inputPerMillion: z.number().nonnegative(),
        cachedInputPerMillion: z.number().nonnegative(),
        cacheCreationInputPerMillion: z.number().nonnegative().optional(),
        outputPerMillion: z.number().nonnegative(),
        updatedAt: z.string(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const agentSettingsSchema = z
  .object({
    vendors: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          kind: z.enum(["openai", "anthropic", "deepseek", "custom"]),
          label: z.string().trim().min(1),
          protocol: agentProviderSchema,
          baseURL: z.union([z.literal(""), z.string().url()]),
          enabled: z.boolean(),
          models: z.array(modelSchema),
        })
        .strict(),
    ),
    gateway: agentGatewayPreferencesSchema,
    stepLimits: agentStepLimitsSchema,
    executionStrategy: agentExecutionStrategySchema,
    defaultTemplateId: z.string().trim().min(1),
  })
  .strict()
  .superRefine((settings, context) => {
    const vendorIds = new Set<string>();
    const modelIds = new Set<string>();
    for (const vendor of settings.vendors) {
      if (vendorIds.has(vendor.id))
        context.addIssue({ code: "custom", message: "Duplicate vendor id" });
      vendorIds.add(vendor.id);
      for (const model of vendor.models) {
        if (modelIds.has(model.id))
          context.addIssue({ code: "custom", message: "Duplicate model id" });
        modelIds.add(model.id);
      }
    }
    if (settings.gateway.fallbackModelId && !modelIds.has(settings.gateway.fallbackModelId)) {
      context.addIssue({ code: "custom", message: "Unknown fallback model" });
    }
  });

export type AgentSettings = z.infer<typeof agentSettingsSchema>;
