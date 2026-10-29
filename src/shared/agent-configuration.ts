import { z } from "zod";
import { agentExecutionStrategySchema, agentProviderSchema } from "./agent";
import { agentGatewayPreferencesSchema } from "./agent-gateway-config";
import { type AgentSettings, agentSettingsSchema } from "./agent-settings";
import { agentStepLimitsSchema } from "./agent-step-limits";
import { credentialApiKeySchema, type CredentialStatusSnapshot, normalizeCredentialUrl } from "./credentials";
import type { ListRemoteModelsResult } from "./remote-models";

export const credentialUpdateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("keep") }).strict(),
  z.object({ type: z.literal("replace"), apiKey: credentialApiKeySchema }).strict(),
  z.object({ type: z.literal("remove") }).strict(),
]);
export const vendorConfigurationSchema = agentSettingsSchema.shape.vendors.element;
export const saveAgentVendorSchema = z.object({
  vendor: vendorConfigurationSchema,
  credential: credentialUpdateSchema,
}).strict();
export const agentPreferencesSchema = z.object({
  gateway: agentGatewayPreferencesSchema,
  stepLimits: agentStepLimitsSchema,
  executionStrategy: agentExecutionStrategySchema,
  defaultTemplateId: z.string().trim().min(1),
}).strict();
export const vendorIdSchema = z.string().trim().min(1).max(256);
const connectionUrlSchema = z.string().trim().transform((value, context) => {
  try { return normalizeCredentialUrl(value); }
  catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid connection URL." });
    return z.NEVER;
  }
});
export const updateSearchCredentialSchema = z.object({
  endpoint: connectionUrlSchema,
  credential: credentialUpdateSchema,
}).strict();
export const discoverAgentModelsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("saved-vendor"), vendorId: vendorIdSchema }).strict(),
  z.object({ type: z.literal("draft"), provider: agentProviderSchema, baseURL: connectionUrlSchema, apiKey: credentialApiKeySchema }).strict(),
]);

export type VendorConfiguration = z.infer<typeof vendorConfigurationSchema>;
export type CredentialUpdate = z.infer<typeof credentialUpdateSchema>;
export type SaveAgentVendorRequest = z.infer<typeof saveAgentVendorSchema>;
export type AgentPreferences = z.infer<typeof agentPreferencesSchema>;
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
  updateSearchCredential(request: UpdateSearchCredentialRequest): Promise<AgentConfigurationSnapshot>;
  listRemoteModels(request: DiscoverAgentModelsRequest): Promise<ListRemoteModelsResult>;
}
