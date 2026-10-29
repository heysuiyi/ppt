export type RunStatus = "preparing" | "running" | "completed" | "failed" | "interrupted";

export interface RunRecord {
  runId: string;
  sessionId: string;
  threadId?: string;
  queryId?: string;
  status: RunStatus;
  result?: unknown;
}

export interface StoredRunResult {
  status: RunStatus;
  resultJson?: string;
}

export interface LatestSessionRun {
  runId: string;
  threadId?: string;
}

export interface RunSession {
  sessionId: string;
  threadId?: string;
}

export interface RunQueryBinding extends RunSession {
  queryId?: string;
}

export interface BeginRunInput {
  runId: string;
  sessionId: string;
  threadId?: string;
  provider?: string;
  model?: string;
  request?: string;
}

export interface FinishRunInput {
  runId: string;
  status: "completed" | "failed" | "interrupted";
  result?: unknown;
  error?: string;
  threadId?: string;
}
