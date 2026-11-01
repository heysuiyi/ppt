import { getModelProfile } from "@agent-harness/models/model-profiles";
import { z } from "zod";
import {
  type CredentialStatusSnapshot,
  credentialApiKeySchema,
  normalizeCredentialUrl,
} from "./credential-contract.js";
import { agentGatewayPreferencesSchema } from "./gateway-settings.js";
import { agentExecutionStrategySchema, agentProviderSchema } from "./model-contract.js";
import type { ListRemoteModelsResult } from "./remote-models.js";
import {
  type AgentSettings,
  type agentCliPreferencesSchema,
  agentSettingsSchema,
} from "./settings.js";
import { agentStepLimitsSchema } from "./step-limits.js";

export const credentialUpdateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("keep") }).strict(),
  z.object({ type: z.literal("replace"), apiKey: credentialApiKeySchema }).strict(),
  z.object({ type: z.literal("remove") }).strict(),
]);
export const vendorConfigurationSchema = agentSettingsSchema.shape.vendors.element;
export const saveAgentVendorSchema = z
  .object({
    vendor: vendorConfigurationSchema,
    credential: credentialUpdateSchema,
  })
  .strict();
export const agentPreferencesSchema = z
  .object({
    gateway: agentGatewayPreferencesSchema,
    stepLimits: agentStepLimitsSchema,
    executionStrategy: agentExecutionStrategySchema,
    defaultTemplateId: z.string().trim().min(1),
  })
  .strict();
export const vendorIdSchema = z.string().trim().min(1).max(256);
const connectionUrlSchema = z
  .string()
  .trim()
  .transform((value, context) => {
    try {
      return normalizeCredentialUrl(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid connection URL.",
      });
      return z.NEVER;
    }
  });
export const updateSearchCredentialSchema = z
  .object({
    endpoint: connectionUrlSchema,
    credential: credentialUpdateSchema,
  })
  .strict();
export const discoverAgentModelsSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("saved-vendor"), vendorId: vendorIdSchema }).strict(),
    z
      .object({
        type: z.literal("draft"),
        provider: agentProviderSchema,
        baseURL: connectionUrlSchema,
        modelAdapter: z.literal("mimo-token-plan-cn").optional(),
        apiKey: credentialApiKeySchema,
      })
      .strict(),
  ])
  .superRefine((request, context) => {
    if (request.type !== "draft" || request.modelAdapter !== "mimo-token-plan-cn") return;
    const profile = getModelProfile(request.modelAdapter);
    if (profile?.protocol !== "openai-responses" || request.provider !== "openai")
      context.addIssue({
        code: "custom",
        path: ["provider"],
        message: "MiMo requires OpenAI protocol.",
      });
    if (profile?.endpoint?.kind !== "fixed" || request.baseURL !== profile.endpoint.url)
      context.addIssue({
        code: "custom",
        path: ["baseURL"],
        message: "MiMo requires its fixed CN Token Plan URL.",
      });
  });

export type VendorConfiguration = z.infer<typeof vendorConfigurationSchema>;
export type CredentialUpdate = z.infer<typeof credentialUpdateSchema>;
export type SaveAgentVendorRequest = z.infer<typeof saveAgentVendorSchema>;
export type AgentPreferences = z.infer<typeof agentPreferencesSchema>;
export type AgentCliPreferences = z.infer<typeof agentCliPreferencesSchema>;
export type UpdateSearchCredentialRequest = z.infer<typeof updateSearchCredentialSchema>;
export type DiscoverAgentModelsRequest = z.infer<typeof discoverAgentModelsSchema>;
export interface AgentConfigurationSnapshot {
  settings: AgentSettings;
  credentials: CredentialStatusSnapshot;
}
export interface ConfigurationManagement {
  getSnapshot(): Promise<AgentConfigurationSnapshot | undefined>;
  initialize(legacy?: AgentSettings): Promise<AgentConfigurationSnapshot>;
  saveVendor(request: SaveAgentVendorRequest): Promise<AgentConfigurationSnapshot>;
  deleteVendor(vendorId: string): Promise<AgentConfigurationSnapshot>;
  savePreferences(preferences: AgentPreferences): Promise<AgentConfigurationSnapshot>;
  saveCliPreferences(preferences: AgentCliPreferences): Promise<AgentConfigurationSnapshot>;
  updateSearchCredential(
    request: UpdateSearchCredentialRequest,
  ): Promise<AgentConfigurationSnapshot>;
  listRemoteModels(
    request: DiscoverAgentModelsRequest,
    signal?: AbortSignal,
  ): Promise<ListRemoteModelsResult>;
}
