import { createModelProvider as createProvider } from "./internal/create-provider.js";
import type { ModelProvider, ModelProviderOptions } from "./model-contract.js";

export function createModelProvider(
  options: ModelProviderOptions,
  signal: AbortSignal,
): Promise<ModelProvider> {
  return createProvider(options, signal);
}
