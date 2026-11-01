import type { AgentModelMessage } from "../../gateway";
import type { ModelPromptPayload } from "../turns/model-call-recovery";

export type TranscriptEntry = Record<string, unknown>;

export type ConversationMessage = { role: "user" | "assistant"; content: string };

export interface ContextCompactResult {
  payload: ModelPromptPayload;
  /** Canonical native ContentBlock history after the same compaction pass. */
  messages?: AgentModelMessage[];
  notes: string[];
  compactHistoryFailures: number;
  contextChanged: boolean;
}

export interface PrepareContextOptions {
  payload: ModelPromptPayload;
  /** Canonical model history. Ephemeral prompt/query context is not part of it. */
  messages?: AgentModelMessage[];
  systemPrompt: string;
  workspaceRoot?: string;
  threadId?: string;
  tokenThreshold?: number;
  softTokenThreshold?: number;
  compactHistoryFailures?: number;
  gateway?: import("../../gateway/types").AgentModelGateway;
  model?: import("@shared/agent").AgentModelSelection;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
