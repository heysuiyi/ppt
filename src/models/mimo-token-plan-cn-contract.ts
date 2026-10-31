import type { ModelClientFactory } from "../agent/model/model-contract";
import type { Disposable } from "../agent/protocol-values";
import type { Logger } from "../logs/log-contract";

export const MIMO_TOKEN_PLAN_CN_PROVIDER_ID = "mimo-token-plan-cn" as const;
export const MIMO_TOKEN_PLAN_CN_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
export const MIMO_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type MimoReasoningEffort = (typeof MIMO_REASONING_EFFORTS)[number];

export interface MimoTokenPlanCNOptions {
  readonly apiKey: string;
  readonly connectionFingerprint: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly logger?: Logger;
}

export interface MimoRemoteModel {
  readonly id: string;
  readonly displayName?: string;
  /** 未知型号保留发现结果，但不能据名称猜测执行能力。 */
  readonly supported: boolean;
  readonly unsupportedReason?: string;
}

export interface MimoTokenPlanCN extends ModelClientFactory, Disposable {
  listModels(signal: AbortSignal): Promise<readonly MimoRemoteModel[]>;
}
