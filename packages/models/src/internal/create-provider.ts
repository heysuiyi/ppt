import type {
  MimoTokenPlanCNOptions,
  ModelProvider,
  ModelProviderOptions,
} from "../model-contract.js";
import { ModelProviderError } from "../model-errors.js";
import {
  knownMimoError,
  mimoError,
  outputBudget,
} from "../providers/mimo-token-plan-cn/error-messages.js";

export async function createModelProvider(
  options: ModelProviderOptions,
  signal: AbortSignal,
): Promise<ModelProvider> {
  if (options?.adapterId !== "mimo-token-plan-cn") {
    throw new ModelProviderError("ADAPTER_UNSUPPORTED", "不支持该模型适配器。");
  }
  if (signal.aborted) throw mimoError("CANCELLED");

  // Capture primitive configuration and the borrowed logger before the first await.
  const { apiKey, connectionFingerprint, timeoutMs, maxOutputTokens, logger } = options;
  if (
    typeof apiKey !== "string" ||
    !apiKey.trim() ||
    typeof connectionFingerprint !== "string" ||
    !connectionFingerprint.trim() ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw mimoError("CONFIGURATION");
  }
  const snapshot: MimoTokenPlanCNOptions = {
    adapterId: "mimo-token-plan-cn",
    apiKey,
    connectionFingerprint,
    timeoutMs,
    maxOutputTokens: outputBudget(maxOutputTokens),
    ...(logger === undefined ? {} : { logger }),
  };
  let provider: ModelProvider | undefined;
  try {
    if (signal.aborted) throw mimoError("CANCELLED");
    // Keep the SDK out of the creation facade until this adapter is selected.
    const { createMimoTokenPlanCN } = await import("../providers/mimo-token-plan-cn/provider.js");
    if (signal.aborted) throw mimoError("CANCELLED");
    provider = createMimoTokenPlanCN(snapshot);
    if (signal.aborted) throw mimoError("CANCELLED");
    return provider;
  } catch (error) {
    try {
      await provider?.dispose();
    } catch (cleanupError) {
      throw knownMimoError(cleanupError) ?? mimoError("CONFIGURATION");
    }
    throw signal.aborted
      ? mimoError("CANCELLED")
      : (knownMimoError(error) ?? mimoError("CONFIGURATION"));
  }
}
