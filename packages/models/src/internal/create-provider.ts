import type {
  MimoTokenPlanCNOptions,
  ModelProvider,
  ModelProviderOptions,
} from "../model-contract.js";
import { ModelProviderError } from "../model-errors.js";
import {
  knownMimoError,
  mimoError,
  outputBudget,
} from "../providers/mimo-token-plan-cn/error-messages.js";

export async function createModelProvider(
  options: ModelProviderOptions,
  signal: AbortSignal,
): Promise<ModelProvider> {
  if (options?.adapterId !== "mimo-token-plan-cn") {
    return createConfigurableProvider(options, signal);
  }
  if (signal.aborted) throw mimoError("CANCELLED");

  // Capture primitive configuration and the borrowed logger before the first await.
  const { apiKey, connectionFingerprint, timeoutMs, maxOutputTokens, logger } = options;
  if (
    typeof apiKey !== "string" ||
    !apiKey.trim() ||
    typeof connectionFingerprint !== "string" ||
    !connectionFingerprint.trim() ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw mimoError("CONFIGURATION");
  }
  const snapshot: MimoTokenPlanCNOptions = {
    adapterId: "mimo-token-plan-cn",
    apiKey,
    connectionFingerprint,
    timeoutMs,
    maxOutputTokens: outputBudget(maxOutputTokens),
    ...(logger === undefined ? {} : { logger }),
  };
  let provider: ModelProvider | undefined;
  try {
    if (signal.aborted) throw mimoError("CANCELLED");
    // Keep the SDK out of the creation facade until this adapter is selected.
    const { createMimoTokenPlanCN } = await import("../providers/mimo-token-plan-cn/provider.js");
    if (signal.aborted) throw mimoError("CANCELLED");
    provider = createMimoTokenPlanCN(snapshot);
    if (signal.aborted) throw mimoError("CANCELLED");
    return provider;
  } catch (error) {
    try {
      await provider?.dispose();
    } catch (cleanupError) {
      throw knownMimoError(cleanupError) ?? mimoError("CONFIGURATION");
    }
    throw signal.aborted
      ? mimoError("CANCELLED")
      : (knownMimoError(error) ?? mimoError("CONFIGURATION"));
  }
}

async function createConfigurableProvider(
  options: ModelProviderOptions,
  signal: AbortSignal,
): Promise<ModelProvider> {
  const adapterId = options?.adapterId;
  if (
    adapterId !== "openai-chat-completions" &&
    adapterId !== "openai-responses" &&
    adapterId !== "anthropic-messages"
  ) {
    throw new ModelProviderError("ADAPTER_UNSUPPORTED", "不支持该模型适配器。");
  }
  const failure = (code: "CONFIGURATION" | "CANCELLED"): ModelProviderError =>
    new ModelProviderError(
      code,
      code === "CANCELLED" ? "模型操作已取消。" : "模型连接配置无效。",
      adapterId,
    );
  if (signal.aborted) throw failure("CANCELLED");
  const { apiKey, connectionFingerprint, timeoutMs, maxOutputTokens, logger, baseURL } = options;
  if (
    typeof apiKey !== "string" ||
    !apiKey.trim() ||
    typeof connectionFingerprint !== "string" ||
    !connectionFingerprint.trim() ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens <= 0
  ) {
    throw failure("CONFIGURATION");
  }
  let normalizedURL: string | undefined;
  if (baseURL !== undefined) {
    try {
      const url = new URL(baseURL);
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw failure("CONFIGURATION");
      normalizedURL = url.href.replace(/\/+$/u, "");
    } catch {
      throw failure("CONFIGURATION");
    }
  }
  const snapshot = {
    apiKey,
    connectionFingerprint,
    timeoutMs,
    maxOutputTokens,
    ...(logger === undefined ? {} : { logger }),
    ...(normalizedURL === undefined ? {} : { baseURL: normalizedURL }),
  };
  let provider: ModelProvider | undefined;
  try {
    // 运行时协议选择是 SDK 加载边界；未选择的适配器不得被初始化。
    switch (adapterId) {
      case "openai-chat-completions": {
        const { createOpenAIChat } = await import(
          "../providers/openai-chat-completions/provider.js"
        );
        if (signal.aborted) throw failure("CANCELLED");
        provider = createOpenAIChat({ ...snapshot, adapterId });
        break;
      }
      case "openai-responses": {
        const { createOpenAIResponses } = await import("../providers/openai-responses/provider.js");
        if (signal.aborted) throw failure("CANCELLED");
        provider = createOpenAIResponses({ ...snapshot, adapterId });
        break;
      }
      case "anthropic-messages": {
        const { createAnthropicMessages } = await import(
          "../providers/anthropic-messages/provider.js"
        );
        if (signal.aborted) throw failure("CANCELLED");
        provider = createAnthropicMessages({ ...snapshot, adapterId });
        break;
      }
    }
    if (signal.aborted) throw failure("CANCELLED");
    return provider;
  } catch (error) {
    try {
      await provider?.dispose();
    } catch {
      // 创建未发布的实例仍需释放；不公开 SDK 清理错误。
    }
    if (signal.aborted) throw failure("CANCELLED");
    if (error instanceof ModelProviderError && error.adapterId === adapterId) throw error;
    throw failure("CONFIGURATION");
  }
}
