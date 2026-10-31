import { z } from "zod";
import {
  MIMO_REASONING_EFFORTS,
  MIMO_TOKEN_PLAN_CN_BASE_URL,
  MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
} from "../models/mimo-token-plan-cn-contract";
import { agentExecutionStrategySchema, agentProviderSchema } from "./agent";
import { agentGatewayPreferencesSchema } from "./agent-gateway-config";
import { agentStepLimitsSchema } from "./agent-step-limits";

const modelSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    model: z.string().trim().min(1),
    openaiApiMode: z.enum(["responses", "chat-completions"]),
    reasoningEffort: z.string().min(1).optional(),
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
          kind: z.enum(["openai", "anthropic", "deepseek", "mimo-token-plan-cn", "custom"]),
          label: z.string().trim().min(1),
          protocol: agentProviderSchema,
          baseURL: z.union([z.literal(""), z.string().url()]),
          enabled: z.boolean(),
          models: z.array(modelSchema),
        })
        .strict()
        .superRefine((vendor, context) => {
          if (vendor.kind !== MIMO_TOKEN_PLAN_CN_PROVIDER_ID) return;
          if (vendor.protocol !== "openai")
            context.addIssue({
              code: "custom",
              path: ["protocol"],
              message: "MiMo requires OpenAI protocol.",
            });
          if (vendor.baseURL !== MIMO_TOKEN_PLAN_CN_BASE_URL)
            context.addIssue({
              code: "custom",
              path: ["baseURL"],
              message: "MiMo requires its fixed CN Token Plan URL.",
            });
          for (const [index, model] of vendor.models.entries()) {
            if (model.openaiApiMode !== "responses")
              context.addIssue({
                code: "custom",
                path: ["models", index, "openaiApiMode"],
                message: "MiMo requires Responses API.",
              });
            if (
              model.reasoningEffort !== undefined &&
              !MIMO_REASONING_EFFORTS.some((effort) => effort === model.reasoningEffort)
            )
              context.addIssue({
                code: "custom",
                path: ["models", index, "reasoningEffort"],
                message: "Unsupported MiMo reasoning effort.",
              });
          }
        }),
    ),
    gateway: agentGatewayPreferencesSchema,
    stepLimits: agentStepLimitsSchema,
    executionStrategy: agentExecutionStrategySchema,
    defaultTemplateId: z.string().trim().min(1),
  })
  .strict()
  .superRefine((settings, context) => {
    if (
      settings.vendors.some((vendor) => vendor.kind === MIMO_TOKEN_PLAN_CN_PROVIDER_ID) &&
      settings.gateway.maxOutputTokens > 131_072
    )
      context.addIssue({
        code: "custom",
        path: ["gateway", "maxOutputTokens"],
        message: "MiMo maxOutputTokens must be between 1 and 131072.",
      });
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
