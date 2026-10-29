export interface CheckpointLease {
  activeRunId?: string;
  writerGeneration: number;
  writerRevision: number;
  checkpointJson: string;
}

export interface CheckpointCasInput {
  threadId: string;
  runId: string;
  generation: number;
  expectedRevision: number;
  nextRevision: number;
  checkpoint: unknown;
}
