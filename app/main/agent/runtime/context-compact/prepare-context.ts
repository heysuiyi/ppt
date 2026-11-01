import type { ModelPromptPayload } from "../turns/model-call-recovery";
import { compactHistory } from "./compact-history";
import { resolveContextSoftTokenThreshold, resolveContextTokenThreshold } from "./config";
import { estimatePromptTokens } from "./estimate-tokens";
import { microCompactTranscript } from "./micro-compact";
import { microCompactModelMessages, snipCompactModelMessages } from "./model-messages";
import { snipCompactConversation, snipCompactTranscript } from "./snip-compact";
import { toolResultBudget } from "./tool-result-budget";
import type { ContextCompactResult, PrepareContextOptions } from "./types";

export const CONTEXT_TOOL_RESULTS_COMPACTED_USER_MESSAGE =
  "上下文空间接近阈值，已精简较早的工具结果并保留可恢复摘要…";
export const CONTEXT_HISTORY_COMPACTED_USER_MESSAGE =
  "上下文空间接近上限，已总结较早的会话记录并继续处理…";
export const CONTEXT_LARGE_RESULTS_PERSISTED_USER_MESSAGE =
  "已将较大的工具结果保存到工作区，正在继续处理…";

function contextProgressMessage(notes: string[]): string | undefined {
  if (notes.some((note) => /^L4 compact_history:/i.test(note))) {
    return CONTEXT_HISTORY_COMPACTED_USER_MESSAGE;
  }
  if (notes.some((note) => /^L1 snip_compact:/i.test(note))) {
    return CONTEXT_HISTORY_COMPACTED_USER_MESSAGE;
  }
  if (notes.some((note) => /^L2 micro_compact:/i.test(note))) {
    return CONTEXT_TOOL_RESULTS_COMPACTED_USER_MESSAGE;
  }
  if (
    notes.some((note) => /^(?:L3 tool_result_budget:|Persisted oversized tool result)/i.test(note))
  ) {
    return CONTEXT_LARGE_RESULTS_PERSISTED_USER_MESSAGE;
  }
  return undefined;
}

/**
 * Persist exceptionally large results immediately, then delay lossy compaction
 * until the prompt approaches its configured token threshold. Both the legacy
 * payload and canonical native messages participate in every size decision.
 */
export async function prepareContext(
  options: PrepareContextOptions,
): Promise<ContextCompactResult> {
  const notes: string[] = [];
  let compactHistoryFailures = options.compactHistoryFailures ?? 0;
  let payload: ModelPromptPayload = structuredClone(options.payload);
  let messages = options.messages ? structuredClone(options.messages) : undefined;

  const budgetResult = await toolResultBudget(payload.transcript, options.workspaceRoot);
  payload = { ...payload, transcript: budgetResult.transcript };
  notes.push(...budgetResult.notes);

  const tokenThreshold =
    options.tokenThreshold ??
    resolveContextTokenThreshold(process.env, options.model?.supports1MContext === true);
  const softTokenThreshold = Math.min(
    options.softTokenThreshold ?? resolveContextSoftTokenThreshold(tokenThreshold),
    tokenThreshold,
  );
  let estimatedTokens = estimatePromptTokens(options.systemPrompt, payload, messages);

  if (estimatedTokens > softTokenThreshold) {
    const beforeMicro =
      JSON.stringify(payload.transcript).length + JSON.stringify(messages ?? []).length;
    payload = {
      ...payload,
      transcript: microCompactTranscript(payload.transcript),
    };
    messages = microCompactModelMessages(messages);
    const afterMicro =
      JSON.stringify(payload.transcript).length + JSON.stringify(messages ?? []).length;
    if (afterMicro < beforeMicro) {
      notes.push(
        `L2 micro_compact: reduced older tool results by ${beforeMicro - afterMicro} characters.`,
      );
      estimatedTokens = estimatePromptTokens(options.systemPrompt, payload, messages);
    }
  }

  if (estimatedTokens > tokenThreshold && options.gateway) {
    const historyResult = await compactHistory({
      payload,
      messages,
      workspaceRoot: options.workspaceRoot,
      threadId: options.threadId,
      gateway: options.gateway,
      model: options.model,
      signal: options.signal,
      compactHistoryFailures,
    });
    compactHistoryFailures = historyResult.failures;

    if (!historyResult.skipped && historyResult.summary) {
      payload = historyResult.payload;
      messages = historyResult.messages;
      notes.push(
        historyResult.savedPath
          ? `L4 compact_history: archived to ${historyResult.savedPath} and replaced with summary.`
          : "L4 compact_history: replaced history with LLM summary.",
      );
      estimatedTokens = estimatePromptTokens(options.systemPrompt, payload, messages);
    } else if (historyResult.reason) {
      notes.push(`L4 compact_history skipped: ${historyResult.reason}`);
    }
  }

  if (estimatedTokens > tokenThreshold) {
    const beforeSnip =
      payload.transcript.length + (payload.conversation?.length ?? 0) + (messages?.length ?? 0);
    const beforeSnipChars = JSON.stringify({
      conversation: payload.conversation,
      transcript: payload.transcript,
      messages,
    }).length;
    payload = {
      ...payload,
      conversation: snipCompactConversation(payload.conversation),
      transcript: snipCompactTranscript(payload.transcript),
    };
    // Hard overflow is size-driven. Use a paired native tail even when fewer
    // than the normal count threshold are individually very large.
    messages = snipCompactModelMessages(messages, 0, 1, 2);
    const afterSnip =
      payload.transcript.length + (payload.conversation?.length ?? 0) + (messages?.length ?? 0);
    const afterSnipChars = JSON.stringify({
      conversation: payload.conversation,
      transcript: payload.transcript,
      messages,
    }).length;
    if (afterSnip < beforeSnip || afterSnipChars < beforeSnipChars) {
      notes.push(
        `L1 snip_compact: removed ${Math.max(0, beforeSnip - afterSnip)} messages ` +
          `and ${Math.max(0, beforeSnipChars - afterSnipChars)} characters after summary was unavailable.`,
      );
    }
  }

  const contextChanged = notes.some((note) => !/^L4 compact_history skipped:/i.test(note));
  const progressMessage = contextChanged ? contextProgressMessage(notes) : undefined;
  if (progressMessage) options.onProgress?.(progressMessage);

  return { payload, messages, notes, compactHistoryFailures, contextChanged };
}
