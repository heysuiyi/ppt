import type { AgentModelSelection } from "@shared/agent";
import { type AgentGatewayConfig, resolveAgentGatewayConfig } from "@shared/agent-gateway-config";
import type {
  AgentModelContentBlock,
  AgentModelGateway,
  AgentModelMessage,
  AgentModelStreamChunk,
  AgentResponseContract,
  AgentToolSchema,
  StopReason,
} from "../../gateway";
import {
  AgentGatewayError,
  classifyGatewayRecovery,
  isAbortError,
  isOutputTruncated,
  resolveFallbackModelSelection,
  textFromContentBlocks,
  toolUseBlocksFromContent,
} from "../../gateway";
import { createModuleLogger } from "../../logger";
import {
  emergencyTrimContext,
  emergencyTrimModelMessages,
  prepareContext,
} from "../context-compact";
import { backoffBeforeRetry } from "../model/with-retry";

const logger = createModuleLogger("model-call-recovery");
const MAX_RECOVERY_ATTEMPTS = 8;
const TOKEN_UPGRADE_8K = 8_192;
const TOKEN_UPGRADE_64K = 65_536;
const CONSECUTIVE_OVERLOAD_SWITCH = 2;
const CONTINUATION_INSTRUCTION =
  "Continue exactly where the previous text response ended. " +
  "Do not repeat content already written.";

function readGatewayConfig(gateway: AgentModelGateway): AgentGatewayConfig {
  const reader = gateway as AgentModelGateway & { getGatewayConfig?: () => AgentGatewayConfig };
  return reader.getGatewayConfig?.() ?? resolveAgentGatewayConfig();
}
export interface ModelPromptPayload {
  /** Specialized one-shot callers only; the main query loop leaves this unset. */
  request?: string;
  task?: string;
  /** Legacy/specialized compact input; the main query loop uses canonical messages. */
  conversation?: Array<{ role: "user" | "assistant"; content: string }>;
  transcript: Array<Record<string, unknown>>;
  queryContext?: {
    source: "user" | "continuation" | "recovery";
    user: Readonly<Record<string, string>>;
    system: Readonly<Record<string, string>>;
  };
}

export interface ModelCallRecoveryOptions {
  gateway: AgentModelGateway;
  systemPrompt: string;
  responseContract?: AgentResponseContract;
  promptPayload: ModelPromptPayload;
  model?: AgentModelSelection;
  fallbackModel?: AgentModelSelection;
  maxOutputTokensOverride?: number;
  workspaceRoot?: string;
  threadId?: string;
  signal?: AbortSignal;
  tools?: AgentToolSchema[];
  messages?: AgentModelMessage[];
  stream?: {
    onChunk?: (chunk: AgentModelStreamChunk) => void;
    onThinkingChunk?: (text: string) => void;
  };
  onRecovery?: (message: string) => void;
  onContextPrepared?: (
    payload: ModelPromptPayload,
    notes: string[],
    messages?: AgentModelMessage[],
  ) => void;
}

export interface ModelCallRecoveryResult {
  content: AgentModelContentBlock[];
  stopReason?: StopReason;
  modelUsed?: AgentModelSelection;
  recoveryNotes: string[];
  maxOutputTokensOverride?: number;
  maxOutputTokensRecoveryCount: number;
  hasAttemptedReactiveCompact: boolean;
}

function buildPrompt(payload: ModelPromptPayload): string {
  return JSON.stringify(payload);
}

function buildContinuationPrompt(
  originalPayload: ModelPromptPayload,
  partialOutput: string,
): string {
  return JSON.stringify({
    ...originalPayload,
    continuation: {
      instruction: `Your previous text response was truncated by max_tokens. ${CONTINUATION_INSTRUCTION}`,
      partialOutput,
    },
  });
}

function buildContinuationMessages(
  messages: AgentModelMessage[] | undefined,
  payload: ModelPromptPayload,
  partialOutput: string,
): AgentModelMessage[] | undefined {
  if (!messages) return undefined;
  return [
    ...structuredClone(messages),
    {
      role: "user",
      content: [{ type: "text", text: buildPrompt(payload) }],
    },
    {
      role: "assistant",
      content: [{ type: "text", text: partialOutput }],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `The preceding assistant response was truncated by max_tokens. ${CONTINUATION_INSTRUCTION}`,
        },
      ],
    },
  ];
}

function nextOutputTokenUpgrade(current: number): number | undefined {
  if (current < TOKEN_UPGRADE_8K) return TOKEN_UPGRADE_8K;
  if (current < TOKEN_UPGRADE_64K) return TOKEN_UPGRADE_64K;
  return undefined;
}

function mergeContinuationText(previous: string, next: string): string {
  if (!previous) return next;
  if (!next) return previous;
  if (next.startsWith(previous)) return next;
  if (previous.endsWith(next)) return previous;

  const maxOverlap = Math.min(previous.length, next.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (previous.slice(-size) === next.slice(0, size)) {
      return previous + next.slice(size);
    }
  }
  return previous + next;
}

function mergeContinuationContent(
  previousText: string,
  content: AgentModelContentBlock[],
): AgentModelContentBlock[] {
  const nextText = textFromContentBlocks(content);
  const combinedText = mergeContinuationText(previousText, nextText);
  const nonText = content.filter((block) => block.type !== "text");
  return [...(combinedText ? [{ type: "text" as const, text: combinedText }] : []), ...nonText];
}

async function invokeGateway(
  gateway: AgentModelGateway,
  request: {
    systemPrompt: string;
    prompt: string;
    signal?: AbortSignal;
    maxOutputTokens?: number;
    responseContract?: AgentResponseContract;
    tools?: AgentToolSchema[];
    messages?: AgentModelMessage[];
  },
  model: AgentModelSelection | undefined,
  stream?: ModelCallRecoveryOptions["stream"],
): Promise<{ content: AgentModelContentBlock[]; stopReason?: StopReason }> {
  if (stream?.onChunk || stream?.onThinkingChunk) {
    let streamedText = "";
    let content: AgentModelContentBlock[] = [];
    let stopReason: StopReason | undefined;
    for await (const chunk of gateway.queryModelStream(request, model)) {
      if (chunk.type === "thinking_delta") {
        stream.onThinkingChunk?.(chunk.thinking);
      } else if (chunk.type === "text_delta") {
        streamedText += chunk.text;
        stream.onChunk?.(chunk);
      } else {
        content = chunk.content;
        stopReason = chunk.stopReason;
      }
    }
    if (content.length === 0 && streamedText) {
      content = [{ type: "text", text: streamedText }];
    }
    return { content, stopReason };
  }

  const response = await gateway.queryModel(request, model);
  return { content: response.content, stopReason: response.stopReason };
}

/**
 * Runtime 到模型 Gateway 的可靠调用边界：先压缩上下文并构造最终 prompt/messages，
 * 再处理限流、上下文超限、输出截断和 fallback；成功时统一返回 text/tool_use 内容块。
 * 工具只在后续 AgentRuntime 循环中执行，本方法不会修改 Presentation。
 */
export async function callModelWithRecovery(
  options: ModelCallRecoveryOptions,
): Promise<ModelCallRecoveryResult> {
  const recoveryNotes: string[] = [];
  const gatewayConfig = readGatewayConfig(options.gateway);
  const defaultOutputTokens = gatewayConfig.maxOutputTokens;
  let payload: ModelPromptPayload = structuredClone(options.promptPayload);
  let modelSelection = options.model;
  let maxOutputTokens = options.maxOutputTokensOverride;
  let maxOutputTokensRecoveryCount = 0;
  let emergencyTrimmed = false;
  let compactHistoryFailures = 0;
  let continuationPartial: string | undefined;
  let consecutiveOverloaded = 0;
  let reasoningOnlyRecoveryAttempted = false;
  let reasoningOnlyRecoveryExhausted = false;
  let lastError: unknown;
  let preparedMessages = options.messages ? structuredClone(options.messages) : undefined;

  const recordDiagnostic = (message: string) => {
    recoveryNotes.push(message);
    logger.info("model.recovery", { message, model: modelSelection });
  };
  const notify = (diagnostic: string, userMessage = diagnostic) => {
    recordDiagnostic(diagnostic);
    options.onRecovery?.(userMessage);
  };

  for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) throw new Error("Run aborted by user.");

    if (!continuationPartial) {
      const prepared = await prepareContext({
        payload,
        messages: preparedMessages,
        systemPrompt: options.systemPrompt,
        workspaceRoot: options.workspaceRoot,
        threadId: options.threadId,
        gateway: options.gateway,
        model: modelSelection,
        signal: options.signal,
        compactHistoryFailures,
        onProgress: options.onRecovery,
      });
      prepared.notes.forEach(recordDiagnostic);
      payload = prepared.payload;
      compactHistoryFailures = prepared.compactHistoryFailures;
      preparedMessages = prepared.messages;
      options.onContextPrepared?.(
        structuredClone(payload),
        [...prepared.notes],
        preparedMessages ? structuredClone(preparedMessages) : undefined,
      );
    }

    const continuationMessages = continuationPartial
      ? buildContinuationMessages(preparedMessages, payload, continuationPartial)
      : undefined;
    const prompt = continuationPartial
      ? continuationMessages
        ? ""
        : buildContinuationPrompt(payload, continuationPartial)
      : buildPrompt(payload);

    try {
      const response = await invokeGateway(
        options.gateway,
        {
          systemPrompt: reasoningOnlyRecoveryAttempted
            ? `${options.systemPrompt}\n\nRecovery: The previous attempt exhausted its output budget without text or tool calls. Complete the next concrete action now. For page authoring, write only the next page, not the remaining deck. Reuse settled decisions and avoid further design exploration. If blocked, state the specific blocker.`
            : options.systemPrompt,
          responseContract: options.responseContract,
          prompt,
          signal: options.signal,
          maxOutputTokens,
          tools: options.tools,
          messages: continuationMessages ?? preparedMessages,
        },
        modelSelection,
        continuationPartial ? undefined : options.stream,
      );

      const toolUses = toolUseBlocksFromContent(response.content);
      const text = textFromContentBlocks(response.content);
      if (isOutputTruncated(response.stopReason)) {
        if (
          toolUses.length === 0 &&
          !text.trim() &&
          response.content.some((block) => block.type === "thinking" || block.type === "redacted_thinking")
        ) {
          if (reasoningOnlyRecoveryAttempted) {
            reasoningOnlyRecoveryExhausted = true;
            throw new AgentGatewayError(
              "Model exhausted its output budget twice without text or tool calls. No executable progress was produced.",
              "empty-response",
            );
          }
          reasoningOnlyRecoveryAttempted = true;
          notify(
            "输出预算耗尽但只有思考；保持预算，缩小到下一项具体产物后重试一次。",
            "本轮尚未产生可执行结果，正在缩小范围重试…",
          );
          continue;
        }
        const currentTokens = maxOutputTokens ?? defaultOutputTokens;
        const nextTokens = nextOutputTokenUpgrade(currentTokens);
        if (nextTokens !== undefined) {
          maxOutputTokens = nextTokens;
          maxOutputTokensRecoveryCount += 1;
          notify(
            `输出被截断，提升 max_tokens 至 ${nextTokens} 后重试。`,
            "回复内容较长，正在继续生成…",
          );
          continue;
        }
        if (toolUses.length > 0) {
          throw new AgentGatewayError(
            "Model output was truncated while emitting native tool calls; refusing to execute an incomplete turn.",
            "empty-response",
          );
        }
        if (!text) {
          throw new AgentGatewayError(
            "Model output was truncated without recoverable text.",
            "empty-response",
          );
        }
        const wasContinuation = continuationPartial !== undefined;
        continuationPartial = mergeContinuationText(continuationPartial ?? "", text);
        lastError = new Error(
          "Model output remained truncated after continuation recovery attempts.",
        );
        notify(
          !wasContinuation
            ? "输出截断后启用续写提示重试。"
            : "续写结果仍被截断，保留已生成内容并继续续写。",
          "回复内容较长，正在继续生成…",
        );
        continue;
      }

      if (toolUses.length > 0) {
        return {
          content: continuationPartial
            ? mergeContinuationContent(continuationPartial, response.content)
            : response.content,
          stopReason: response.stopReason,
          modelUsed: modelSelection,
          recoveryNotes,
          maxOutputTokensOverride: maxOutputTokens,
          maxOutputTokensRecoveryCount,
          hasAttemptedReactiveCompact: emergencyTrimmed,
        };
      }

      if (!text) {
        throw new AgentGatewayError(
          "Model returned no text or tool_use content.",
          "empty-response",
        );
      }

      return {
        content: continuationPartial
          ? mergeContinuationContent(continuationPartial, response.content)
          : response.content,
        stopReason: response.stopReason,
        modelUsed: modelSelection,
        recoveryNotes,
        maxOutputTokensOverride: maxOutputTokens,
        maxOutputTokensRecoveryCount,
        hasAttemptedReactiveCompact: emergencyTrimmed,
      };
    } catch (error) {
      lastError = error;
      if (reasoningOnlyRecoveryExhausted) throw error;
      if (isAbortError(error, options.signal)) {
        throw error instanceof Error ? error : new Error("Run aborted by user.");
      }

      const recovery = classifyGatewayRecovery(error);
      if (recovery === "non-recoverable") throw error;
      if (attempt === MAX_RECOVERY_ATTEMPTS) break;

      if (error instanceof AgentGatewayError && error.code === "overloaded") {
        consecutiveOverloaded += 1;
      } else if (recovery === "retry-backoff") {
        consecutiveOverloaded = 0;
      }

      if (recovery === "compact-context" && !emergencyTrimmed) {
        emergencyTrimmed = true;
        payload = emergencyTrimContext(payload);
        preparedMessages = emergencyTrimModelMessages(preparedMessages);
        options.onContextPrepared?.(
          structuredClone(payload),
          ["Reactive emergency trim after provider prompt-too-long."],
          preparedMessages ? structuredClone(preparedMessages) : undefined,
        );
        notify("上下文超限，已应急裁剪后重试。", "对话内容较多，整理后正在继续…");
        continue;
      }

      if (consecutiveOverloaded >= CONSECUTIVE_OVERLOAD_SWITCH) {
        const fallback =
          options.fallbackModel &&
          (!modelSelection ||
            options.fallbackModel.provider !== modelSelection.provider ||
            options.fallbackModel.model !== modelSelection.model)
            ? options.fallbackModel
            : resolveFallbackModelSelection(modelSelection, gatewayConfig);
        if (fallback) {
          modelSelection = fallback;
          consecutiveOverloaded = 0;
          notify(
            `连续过载，切换备用模型 ${fallback.provider}/${fallback.model}。`,
            "服务暂时繁忙，已切换备用服务继续处理…",
          );
          continue;
        }
      }

      const retryAfterMs = error instanceof AgentGatewayError ? error.retryAfterMs : undefined;
      notify(
        retryAfterMs
          ? `临时故障，按 Retry-After 等待后重试（第 ${attempt} 次）。`
          : `临时故障，指数退避后重试（第 ${attempt} 次）。`,
        "服务暂时繁忙，正在重试…",
      );
      await backoffBeforeRetry({ attempt, retryAfterMs, signal: options.signal });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Model call failed after recovery attempts.");
}
