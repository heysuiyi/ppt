import type { TokenUsageModel } from "@shared/token-usage";
import type { ManagedModel, ModelTokenPricing } from "./modelCatalog";

export type ModelPricingCurrency = ModelTokenPricing["currency"];

export interface ModelPricingIndex {
  byConfigurationId: Map<string, ModelTokenPricing>;
  legacyCandidates: Map<string, ManagedModel[]>;
}

export interface ModelCostEstimate {
  currency?: ModelPricingCurrency;
  cost: number;
  coveredTokens: number;
}

export interface ModelCostTotals {
  costs: Record<ModelPricingCurrency, number>;
  coveredTokens: number;
}

function legacyModelKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

export function buildPricingIndex(models: ManagedModel[]): ModelPricingIndex {
  const byConfigurationId = new Map<string, ModelTokenPricing>();
  const legacyCandidates = new Map<string, ManagedModel[]>();
  for (const model of models) {
    if (model.pricing) byConfigurationId.set(model.id, model.pricing);
    const key = legacyModelKey(model.provider, model.model);
    legacyCandidates.set(key, [...(legacyCandidates.get(key) ?? []), model]);
  }
  return { byConfigurationId, legacyCandidates };
}

export function resolveUsagePricing(
  usage: TokenUsageModel,
  index: ModelPricingIndex,
): ModelTokenPricing | undefined {
  if (usage.configurationId) return index.byConfigurationId.get(usage.configurationId);
  const candidates = index.legacyCandidates.get(legacyModelKey(usage.provider, usage.model)) ?? [];
  return candidates.length === 1 ? (candidates[0].pricing ?? undefined) : undefined;
}

export function estimateModelCost(
  usage: TokenUsageModel,
  pricing: ModelTokenPricing | undefined,
): ModelCostEstimate {
  if (!pricing) return { cost: 0, coveredTokens: 0 };
  const cachedInput = usage.cachedInputTokens;
  const cacheCreationInput = usage.cacheCreationInputTokens;
  const regularInput =
    usage.provider === "anthropic"
      ? usage.inputTokens
      : Math.max(0, usage.inputTokens - cachedInput - cacheCreationInput);
  const cost =
    (regularInput * pricing.inputPerMillion +
      cachedInput * pricing.cachedInputPerMillion +
      cacheCreationInput * (pricing.cacheCreationInputPerMillion ?? pricing.inputPerMillion) +
      usage.outputTokens * pricing.outputPerMillion) /
    1_000_000;
  return { currency: pricing.currency, cost, coveredTokens: usage.totalTokens };
}

export function estimateModelsCost(
  usageModels: TokenUsageModel[],
  index: ModelPricingIndex,
): ModelCostTotals {
  return usageModels.reduce<ModelCostTotals>(
    (total, usage) => {
      const estimate = estimateModelCost(usage, resolveUsagePricing(usage, index));
      if (estimate.currency) total.costs[estimate.currency] += estimate.cost;
      total.coveredTokens += estimate.coveredTokens;
      return total;
    },
    { costs: { CNY: 0, USD: 0 }, coveredTokens: 0 },
  );
}
