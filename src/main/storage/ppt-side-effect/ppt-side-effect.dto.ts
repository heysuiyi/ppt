import type { PptJobId } from "@shared/presentation-lifecycle";

export interface PptSideEffectKey {
  jobId: PptJobId;
  operation: "apply" | "export";
  key: string;
}

export interface PptSideEffectRecord {
  status: string;
  result: unknown;
  error: string | null;
}

export interface InsertPptSideEffect extends PptSideEffectKey {
  claimedAt: string;
}

export interface CompletePptSideEffect extends PptSideEffectKey {
  status: "succeeded" | "failed";
  result?: unknown;
  error?: string;
  completedAt: string;
}
