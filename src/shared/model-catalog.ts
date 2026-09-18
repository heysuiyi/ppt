import type { AgentProvider } from "./agent";

export interface ModelTokenPricing {
  currency: "CNY" | "USD";
  inputPerMillion: number;
  cachedInputPerMillion: number;
  cacheCreationInputPerMillion?: number;
  outputPerMillion: number;
  updatedAt: string;
}

export type VendorKind = "openai" | "anthropic" | "deepseek" | "custom";
export type PresetVendorKind = Exclude<VendorKind, "custom">;

export interface ModelCatalogEntry {
  id: string;
  name: string;
  model: string;
  openaiApiMode: "responses" | "chat-completions";
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
