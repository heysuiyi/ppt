import type { ModelClientFactory } from "@agent-harness/core/model/model-contract";
import type { Disposable } from "@agent-harness/core/protocol-values";
import type { Logger } from "@agent-harness/logs/log-contract";

export interface ModelProviderConnectionOptions {
  readonly connectionFingerprint: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly logger?: Logger;
}

export interface MimoTokenPlanCNOptions extends ModelProviderConnectionOptions {
  readonly adapterId: "mimo-token-plan-cn";
  readonly apiKey: string;
}

export type ModelProviderOptions = MimoTokenPlanCNOptions;
export type ModelAdapterId = ModelProviderOptions["adapterId"];

export interface DiscoveredModel {
  readonly id: string;
  readonly displayName?: string;
  readonly supported: boolean;
  readonly unsupportedReason?: string;
}

export interface ModelDiscovery {
  listModels(signal: AbortSignal): Promise<readonly DiscoveredModel[]>;
}

export interface ModelProvider extends ModelClientFactory, Disposable {
  readonly adapterId: ModelAdapterId;
  readonly discovery?: ModelDiscovery;
}
