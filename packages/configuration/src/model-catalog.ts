import type { AgentProvider } from "./model-contract.js";

export interface ModelTokenPricing {
  currency: "CNY" | "USD";
  inputPerMillion: number;
  cachedInputPerMillion: number;
  cacheCreationInputPerMillion?: number;
  outputPerMillion: number;
  updatedAt: string;
}

export type VendorKind = "openai" | "anthropic" | "deepseek" | "mimo-token-plan-cn" | "custom";
export type PresetVendorKind = Exclude<VendorKind, "custom">;

export interface ModelCatalogEntry {
  id: string;
  name: string;
  model: string;
  openaiApiMode: "responses" | "chat-completions";
  reasoningEffort?: string;
  supports1MContext?: boolean;
  enabled: boolean;
  pricing?: ModelTokenPricing | null;
}

export interface ModelVendorConnection {
  id: string;
  kind: VendorKind;
  label: string;
  protocol: AgentProvider;
  baseURL: string;
  enabled: boolean;
  models: ModelCatalogEntry[];
  /** Runtime-only status from Main; never persisted. */
  credentialConfigured?: boolean;
}
