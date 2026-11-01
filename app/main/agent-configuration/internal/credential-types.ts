import { type AgentModelSelection, agentProviderSchema } from "@shared/agent";
import { credentialApiKeySchema, normalizeCredentialUrl } from "@shared/credentials";
import { z } from "zod";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Credential identifiers must not contain control characters.",
  );
const urlSchema = z.string().trim().min(1).max(2_048).url();
export const modelCredentialBindingSchema = z
  .object({
    vendorId: identifierSchema,
    provider: agentProviderSchema,
    baseURL: urlSchema.optional(),
  })
  .strict();
export const webSearchCredentialBindingSchema = z.object({ endpoint: urlSchema }).strict();
export const setModelCredentialsRequestSchema = z
  .object({
    bindings: z.array(modelCredentialBindingSchema).min(1).max(100),
    apiKey: credentialApiKeySchema,
  })
  .strict();
export const setWebSearchCredentialRequestSchema = z
  .object({
    binding: webSearchCredentialBindingSchema,
    apiKey: credentialApiKeySchema,
  })
  .strict();
export const deleteModelCredentialRequestSchema = z.object({ vendorId: identifierSchema }).strict();
export const credentialStatusRequestSchema = z
  .object({
    models: z.array(modelCredentialBindingSchema).max(500).default([]),
    webSearch: webSearchCredentialBindingSchema.optional(),
  })
  .strict();
export type ModelCredentialBinding = z.infer<typeof modelCredentialBindingSchema>;
export type WebSearchCredentialBinding = z.infer<typeof webSearchCredentialBindingSchema>;
export type SetModelCredentialsRequest = z.infer<typeof setModelCredentialsRequestSchema>;
export type SetWebSearchCredentialRequest = z.infer<typeof setWebSearchCredentialRequestSchema>;
export type DeleteModelCredentialRequest = z.infer<typeof deleteModelCredentialRequestSchema>;
export type CredentialStatusRequest = z.input<typeof credentialStatusRequestSchema>;
export function normalizeModelCredentialBinding(
  input: ModelCredentialBinding,
): ModelCredentialBinding {
  const binding = modelCredentialBindingSchema.parse(input);
  return {
    vendorId: binding.vendorId,
    provider: binding.provider,
    ...(binding.baseURL ? { baseURL: normalizeCredentialUrl(binding.baseURL) } : {}),
  };
}
export function normalizeWebSearchCredentialBinding(
  input: WebSearchCredentialBinding,
): WebSearchCredentialBinding {
  return {
    endpoint: normalizeCredentialUrl(webSearchCredentialBindingSchema.parse(input).endpoint),
  };
}
export function modelCredentialBindingFromSelection(
  selection: AgentModelSelection,
): ModelCredentialBinding {
  return normalizeModelCredentialBinding({
    vendorId: selection.vendorId ?? "",
    provider: selection.provider,
    ...(selection.baseURL ? { baseURL: selection.baseURL } : {}),
  });
}
