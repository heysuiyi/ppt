export interface StoredContextSnapshot {
  id: number;
  sessionId: string;
  threadId?: string;
  coveredSequenceStart: number;
  coveredSequenceEnd: number;
  summary: string;
  modelContext: unknown;
  tokenEstimate?: number;
  createdAt: string;
}
