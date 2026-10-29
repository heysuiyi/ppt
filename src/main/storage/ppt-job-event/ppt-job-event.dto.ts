import type { PptJobId } from "@shared/presentation-lifecycle";

export interface AppendPptJobEvent {
  jobId: PptJobId;
  stateRevision: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}
