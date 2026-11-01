import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentModelSelection } from "@shared/agent";
import type { AgentModelGateway, AgentModelMessage } from "../../gateway";
import { isOutputTruncated, textFromContentBlocks, toolUseBlocksFromContent } from "../../gateway";
import type { ModelPromptPayload } from "../turns/model-call-recovery";
import { COMPACT_HISTORY_MAX_FAILURES, COMPACT_TRANSCRIPTS_DIR } from "./config";
import { buildModelCompactionBoundary, takeRecentModelMessages } from "./model-messages";
import type { TranscriptEntry } from "./types";

const SUMMARY_SYSTEM_PROMPT = `You compress agent conversation history for context window management.
Return a concise markdown summary that preserves:
- Current goal and user constraints
- Important discoveries and decisions
- Files changed or read
- Remaining work and open questions
- Tool outcomes that still matter for the next steps
Do not invent facts. Use the same language as the conversation when possible.`;

export interface CompactHistoryOptions {
  payload: ModelPromptPayload;
  messages?: AgentModelMessage[];
  workspaceRoot?: string;
  threadId?: string;
  gateway: AgentModelGateway;
  model?: AgentModelSelection;
  signal?: AbortSignal;
  compactHistoryFailures?: number;
}

export interface CompactHistoryResult {
  payload: ModelPromptPayload;
  messages?: AgentModelMessage[];
  savedPath?: string;
  summary?: string;
  skipped: boolean;
  failures: number;
  reason?: string;
}

async function saveCompactionTranscript(
  workspaceRoot: string,
  threadId: string,
  payload: ModelPromptPayload,
  messages: AgentModelMessage[] | undefined,
): Promise<string> {
  const dir = join(workspaceRoot, COMPACT_TRANSCRIPTS_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${threadId}-${Date.now()}.jsonl`);

  const lines: TranscriptEntry[] = [
    ...(payload.conversation ?? []).map((message) => ({
      role: message.role,
      kind: "message",
      content: message.content,
    })),
    ...payload.transcript,
    ...(messages ?? []).map((message) => ({
      role: message.role,
      kind: "native_model_message",
      content: message.content,
    })),
  ];

  for (const line of lines) {
    await appendFile(filePath, `${JSON.stringify(line)}\n`, "utf8");
  }

  return filePath;
}

async function requestHistorySummary(
  gateway: AgentModelGateway,
  payload: ModelPromptPayload,
  messages: AgentModelMessage[] | undefined,
  model: AgentModelSelection | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await gateway.queryModel(
    {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      responseContract: "markdown-summary",
      prompt: JSON.stringify({
        instruction: "Summarize this agent session history for continuation.",
        request: payload.request ?? payload.task,
        conversation: payload.conversation ?? [],
        transcript: payload.transcript,
        messages: messages ?? [],
      }),
      signal,
      maxOutputTokens: 4_096,
    },
    model,
  );

  if (isOutputTruncated(response.stopReason)) {
    throw new Error(
      `Model output was truncated (${response.stopReason}); refusing to accept a partial one-shot result.`,
    );
  }
  if (toolUseBlocksFromContent(response.content).length > 0) {
    throw new Error("Model returned tool_use content during a markdown call.");
  }

  const markdown = textFromContentBlocks(response.content);
  if (!markdown) {
    throw new Error("Model returned no Markdown text.");
  }
  return markdown;
}

function buildCompactedPayload(
  payload: ModelPromptPayload,
  summary: string,
  savedPath: string,
): ModelPromptPayload {
  if (payload.transcript.length === 0 && (payload.conversation?.length ?? 0) === 0) {
    return payload;
  }
  const recentTail = payload.transcript.slice(-3);
  return {
    ...payload,
    conversation: [],
    transcript: [
      {
        role: "system",
        kind: "compact_boundary",
        content: summary,
        savedTranscript: savedPath,
      },
      ...recentTail,
    ],
  };
}

function buildCompactedMessages(
  messages: AgentModelMessage[] | undefined,
  summary: string,
  savedPath: string,
): AgentModelMessage[] | undefined {
  if (!messages || messages.length === 0) return messages;
  const recentTail = takeRecentModelMessages(messages, 3) ?? [];
  return [buildModelCompactionBoundary(summary, savedPath), ...recentTail];
}

/**
 * L4: compact_history — archive full history, LLM summary, replace active context.
 * Circuit breaker stops after COMPACT_HISTORY_MAX_FAILURES consecutive failures.
 */
export async function compactHistory(
  options: CompactHistoryOptions,
): Promise<CompactHistoryResult> {
  const failures = options.compactHistoryFailures ?? 0;
  if (failures >= COMPACT_HISTORY_MAX_FAILURES) {
    return {
      payload: options.payload,
      messages: options.messages,
      skipped: true,
      failures,
      reason: "compact_history circuit breaker open",
    };
  }

  if (!options.workspaceRoot || !options.threadId) {
    return {
      payload: options.payload,
      messages: options.messages,
      skipped: true,
      failures,
      reason: "workspaceRoot or threadId missing",
    };
  }

  try {
    const savedPath = await saveCompactionTranscript(
      options.workspaceRoot,
      options.threadId,
      options.payload,
      options.messages,
    );
    const summary = await requestHistorySummary(
      options.gateway,
      options.payload,
      options.messages,
      options.model,
      options.signal,
    );
    return {
      payload: buildCompactedPayload(options.payload, summary, savedPath),
      messages: buildCompactedMessages(options.messages, summary, savedPath),
      savedPath,
      summary,
      skipped: false,
      failures: 0,
    };
  } catch (error) {
    const nextFailures = failures + 1;
    return {
      payload: options.payload,
      messages: options.messages,
      skipped: true,
      failures: nextFailures,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
