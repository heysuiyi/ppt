import { describe, expect, it } from "vitest";
import type { ManagedModel } from "../app/renderer/src/modelCatalog";
import {
  buildPricingIndex,
  estimateModelCost,
  estimateModelsCost,
  resolveUsagePricing,
} from "../app/renderer/src/modelPricing";
import type { TokenUsageModel } from "../src/shared/token-usage";

function model(id: string, currency: "CNY" | "USD", inputPerMillion: number): ManagedModel {
  return {
    id,
    vendorId: `vendor-${id}`,
    vendorKind: "custom",
    vendorLabel: id,
    name: id,
    provider: "openai",
    model: "shared-model",
    baseURL: "https://example.com/v1",
    openaiApiMode: "responses",
    pricing: {
      currency,
      inputPerMillion,
      cachedInputPerMillion: inputPerMillion / 10,
      outputPerMillion: inputPerMillion * 2,
      updatedAt: "2026-08-01",
    },
  };
}

function usage(configurationId?: string): TokenUsageModel {
  return {
    ...(configurationId ? { configurationId } : {}),
    provider: "openai",
    model: "shared-model",
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    requestCount: 1,
  };
}

describe("model pricing", () => {
  it("attributes identical model names by configuration ID and keeps currencies separate", () => {
    const index = buildPricingIndex([model("cny-config", "CNY", 1), model("usd-config", "USD", 5)]);

    const totals = estimateModelsCost([usage("cny-config"), usage("usd-config")], index);

    expect(totals).toEqual({ costs: { CNY: 1, USD: 5 }, coveredTokens: 2_000_000 });
  });

  it("only prices legacy usage when protocol and model have one candidate", () => {
    const unique = buildPricingIndex([model("only-config", "USD", 5)]);
    const ambiguous = buildPricingIndex([
      model("first-config", "USD", 5),
      model("second-config", "USD", 7),
    ]);

    expect(resolveUsagePricing(usage(), unique)?.inputPerMillion).toBe(5);
    expect(resolveUsagePricing(usage(), ambiguous)).toBeUndefined();
  });

  it("uses regular input pricing when cache creation has no separate price", () => {
    const pricedModel = model("cache-model", "CNY", 3);
    const estimate = estimateModelCost(
      {
        ...usage("cache-model"),
        provider: "anthropic",
        inputTokens: 100_000,
        cachedInputTokens: 200_000,
        cacheCreationInputTokens: 300_000,
        outputTokens: 400_000,
        totalTokens: 1_000_000,
      },
      pricedModel.pricing ?? undefined,
    );

    expect(estimate).toEqual({ currency: "CNY", cost: 3.66, coveredTokens: 1_000_000 });
  });
});
