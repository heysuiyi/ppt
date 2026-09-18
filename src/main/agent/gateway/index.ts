import type { AgentModelSelection, AgentModelSettings } from "@shared/agent";
import type { AgentGatewayConfig, AgentSearchConfig } from "@shared/agent-gateway-config";
import { resolveAgentGatewayConfig, resolveAgentSearchConfig } from "@shared/agent-gateway-config";
import type { ModelUsageRecord } from "../../token-usage-store";
import { createModuleLogger } from "../logger";
import { anthropicDriver } from "./anthropic";
import {
  type AgentCallPath,
  AgentModelSettingsRegistry,
  type DriverResolvedConfig,
  resolveAgentModelConfig,
} from "./config";
import { textFromContentBlocks } from "./content-blocks";
import type { AgentProviderDriver } from "./driver";
import { AgentGatewayError, normalizeProviderError } from "./errors";
import {
  buildGatewayIoLogEntry,
  buildGatewayIoLogRequest,
  writeGatewayIoLog,
} from "./gateway-io-log";
import { chatDriver, responsesDriver } from "./openai";
import {
  prepareAgentModelRequest,
  validateAgentModelResponse,
  validateStreamChunk,
} from "./protocol";
import type {
  AgentModelGateway,
  AgentModelRequest,
  AgentModelResponse,
  AgentModelStreamChunk,
} from "./types";

const logger = createModuleLogger("gateway");

const DRIVERS = {
  chat: chatDriver,
  responses: responsesDriver,
  anthropic: anthropicDriver,
} satisfies Record<AgentCallPath, AgentProviderDriver>;

function resolveDriver(callPath: AgentCallPath): AgentProviderDriver {
  const driver = DRIVERS[callPath];
  if (!Object.hasOwn(DRIVERS, callPath) || !driver) {
    throw new AgentGatewayError(`No call-path driver registered for ${callPath}.`, "configuration");
  }
  return driver;
}

export class AgentGateway implements AgentModelGateway {
  private readonly runtimeSettings = new AgentModelSettingsRegistry();
  private gatewayConfig: AgentGatewayConfig = resolveAgentGatewayConfig();
  private searchConfig: AgentSearchConfig = resolveAgentSearchConfig();
  private usageRecorder?: (record: ModelUsageRecord) => Promise<void>;

  setUsageRecorder(recorder: (record: ModelUsageRecord) => Promise<void>): void {
    this.usageRecorder = recorder;
  }

  private async recordUsage(record: ModelUsageRecord): Promise<void> {
    try {
      await this.usageRecorder?.(record);
    } catch (error) {
      logger.error("model.usage.persist-failed", {
        provider: record.provider,
        model: record.model,
        error,
      });
    }
  }

  /**
   * 更新当前应用会话使用的 provider 配置，并返回后续请求应携带的模型选择。
   * API Key 等运行时设置只保存在主进程内存中。
   */
  configure(
    settings: AgentModelSettings,
    gatewayConfig?: AgentGatewayConfig,
    searchConfig?: AgentSearchConfig,
  ): AgentModelSelection {
    this.runtimeSettings.registerPrimary(settings);
    if (gatewayConfig) {
      this.gatewayConfig = resolveAgentGatewayConfig(gatewayConfig);
      this.runtimeSettings.registerFallback(this.gatewayConfig.fallbackModel);
    }
    if (searchConfig) {
      this.searchConfig = resolveAgentSearchConfig(searchConfig);
    }
    return {
      ...(settings.configurationId ? { configurationId: settings.configurationId } : {}),
      ...(settings.vendorId ? { vendorId: settings.vendorId } : {}),
      provider: settings.provider,
      model: settings.model,
      ...(settings.supports1MContext ? { supports1MContext: true } : {}),
    };
  }

  /** Drop decrypted primary credentials before configuring a new foreground run. */
  clearPrimarySettings(): void {
    this.runtimeSettings.clearPrimary();
  }

  applyGatewayConfig(gatewayConfig: AgentGatewayConfig): void {
    this.gatewayConfig = resolveAgentGatewayConfig(gatewayConfig);
    this.runtimeSettings.registerFallback(this.gatewayConfig.fallbackModel);
  }

  applySearchConfig(searchConfig: AgentSearchConfig): void {
    this.searchConfig = resolveAgentSearchConfig(searchConfig);
  }

  getGatewayConfig(): AgentGatewayConfig {
    return this.gatewayConfig;
  }

  getSearchConfig(): AgentSearchConfig {
    return this.searchConfig;
  }

  private resolveConfig(selection?: AgentModelSelection): DriverResolvedConfig {
    return resolveAgentModelConfig(
      selection,
      this.runtimeSettings,
      process.env,
      this.gatewayConfig,
    );
  }

  /** One complete model round-trip through the unified call-path driver. */
  async queryModel(
    request: AgentModelRequest,
    selection?: AgentModelSelection,
  ): Promise<AgentModelResponse> {
    const gatewayRequestId = crypto.randomUUID();
    const startedAt = Date.now();
    const startedAtDate = new Date();
    let config: DriverResolvedConfig | undefined;
    let preparedRequest: ReturnType<typeof prepareAgentModelRequest> | undefined;

    try {
      config = this.resolveConfig(selection);
      const driver = resolveDriver(config.callPath);
      preparedRequest = prepareAgentModelRequest(request, config);
      const requestLogPayload = buildGatewayIoLogRequest(preparedRequest);
      logger.info("model.request.started", {
        gatewayRequestId,
        provider: config.provider,
        model: config.model,
        callPath: config.callPath,
        promptLength: request.prompt.length,
        systemPromptLength: preparedRequest.systemPrompt?.length ?? 0,
        timeoutMs: config.timeoutMs,
        maxOutputTokens: preparedRequest.maxOutputTokens,
      });

      const response = await driver.generate(config, preparedRequest);
      validateAgentModelResponse(response, config);

      if (response.usage) {
        await this.recordUsage({
          ...response.usage,
          ...(config.configurationId ? { configurationId: config.configurationId } : {}),
          provider: response.provider,
          model: response.model,
        });
      }

      logger.info("model.request.completed", {
        gatewayRequestId,
        provider: response.provider,
        model: response.model,
        providerRequestId: response.requestId,
        stopReason: response.stopReason,
        responseLength: textFromContentBlocks(response.content).length,
        durationMs: Date.now() - startedAt,
      });
      await writeGatewayIoLog(
        buildGatewayIoLogEntry({
          gatewayRequestId,
          kind: "query",
          status: "completed",
          provider: config.provider,
          model: config.model,
          callPath: config.callPath,
          startedAt: startedAtDate,
          durationMs: Date.now() - startedAt,
          request: requestLogPayload,
          response,
        }),
      );
      return response;
    } catch (error) {
      const normalized = config
        ? normalizeProviderError(config.provider, error, request.signal)
        : error;
      logger.error("model.request.failed", {
        gatewayRequestId,
        provider: config?.provider ?? selection?.provider,
        model: config?.model ?? selection?.model,
        durationMs: Date.now() - startedAt,
        error: normalized,
      });
      await writeGatewayIoLog(
        buildGatewayIoLogEntry({
          gatewayRequestId,
          kind: "query",
          status: "failed",
          provider: config?.provider ?? selection?.provider ?? "unknown",
          model: config?.model ?? selection?.model ?? "unknown",
          callPath: config?.callPath ?? "unknown",
          startedAt: startedAtDate,
          durationMs: Date.now() - startedAt,
          request:
            preparedRequest
              ? buildGatewayIoLogRequest(preparedRequest)
              : {
                  messages: [],
                  maxOutputTokens: config?.maxOutputTokens ?? 0,
                  systemPromptLength: 0,
                  messageCount: 0,
                  toolNames: [],
                },
          error: normalized,
        }),
      );
      throw normalized;
    }
  }

  /** queryModel 的流式版本；向上层暴露统一 chunk 协议而非 provider 原生事件。 */
  async *queryModelStream(
    request: AgentModelRequest,
    selection?: AgentModelSelection,
  ): AsyncGenerator<AgentModelStreamChunk> {
    const gatewayRequestId = crypto.randomUUID();
    const startedAt = Date.now();
    const startedAtDate = new Date();
    let config: DriverResolvedConfig | undefined;
    let preparedRequest: ReturnType<typeof prepareAgentModelRequest> | undefined;
    let requestLogPayload: ReturnType<typeof buildGatewayIoLogRequest> | undefined;
    let completedResponse: AgentModelResponse | undefined;

    try {
      config = this.resolveConfig(selection);
      const driver = resolveDriver(config.callPath);
      preparedRequest = prepareAgentModelRequest(request, config);
      requestLogPayload = buildGatewayIoLogRequest(preparedRequest);
      logger.info("model.stream.started", {
        gatewayRequestId,
        provider: config.provider,
        model: config.model,
        callPath: config.callPath,
        promptLength: request.prompt.length,
        systemPromptLength: preparedRequest.systemPrompt?.length ?? 0,
        timeoutMs: config.timeoutMs,
        maxOutputTokens: preparedRequest.maxOutputTokens,
      });

      let totalLength = 0;
      let completed = false;
      const generator = driver.generateStream(config, preparedRequest);

      for await (const chunk of generator) {
        if (completed) {
          throw new AgentGatewayError(
            `${config.provider} stream emitted data after complete.`,
            "provider-error",
            config.provider,
          );
        }
        validateStreamChunk(chunk, config);
        if (chunk.type === "text_delta") {
          totalLength += chunk.text.length;
        } else if (chunk.type === "complete") {
          completed = true;
          completedResponse = {
            provider: config.provider,
            model: config.model,
            content: chunk.content,
            ...(chunk.stopReason !== undefined ? { stopReason: chunk.stopReason } : {}),
            ...(chunk.usage ? { usage: chunk.usage } : {}),
          };
          if (chunk.usage) {
            await this.recordUsage({
              ...chunk.usage,
              ...(config.configurationId ? { configurationId: config.configurationId } : {}),
              provider: config.provider,
              model: config.model,
            });
          }
        }
        yield chunk;
      }
      if (!completed) {
        throw new AgentGatewayError(
          `${config.provider} stream ended without a complete event.`,
          "empty-response",
          config.provider,
        );
      }

      logger.info("model.stream.completed", {
        gatewayRequestId,
        provider: config.provider,
        model: config.model,
        totalLength,
        durationMs: Date.now() - startedAt,
      });
      await writeGatewayIoLog(
        buildGatewayIoLogEntry({
          gatewayRequestId,
          kind: "stream",
          status: "completed",
          provider: config.provider,
          model: config.model,
          callPath: config.callPath,
          startedAt: startedAtDate,
          durationMs: Date.now() - startedAt,
          request: requestLogPayload,
          ...(completedResponse ? { response: completedResponse } : {}),
        }),
      );
    } catch (error) {
      const normalized = config
        ? normalizeProviderError(config.provider, error, request.signal)
        : error;
      logger.error("model.stream.failed", {
        gatewayRequestId,
        provider: config?.provider ?? selection?.provider,
        model: config?.model ?? selection?.model,
        durationMs: Date.now() - startedAt,
        error: normalized,
      });
      await writeGatewayIoLog(
        buildGatewayIoLogEntry({
          gatewayRequestId,
          kind: "stream",
          status: "failed",
          provider: config?.provider ?? selection?.provider ?? "unknown",
          model: config?.model ?? selection?.model ?? "unknown",
          callPath: config?.callPath ?? "unknown",
          startedAt: startedAtDate,
          durationMs: Date.now() - startedAt,
          request:
            requestLogPayload ??
            (preparedRequest
              ? buildGatewayIoLogRequest(preparedRequest)
              : {
                  messages: [],
                  maxOutputTokens: config?.maxOutputTokens ?? 0,
                  systemPromptLength: 0,
                  messageCount: 0,
                  toolNames: [],
                }),
          error: normalized,
        }),
      );
      throw normalized;
    }
  }
}

// -- Config (仅 Runtime 需要的 fallback 选择) --
export { resolveFallbackModelSelection } from "./config";
// -- Content blocks --
export {
  textBlock,
  textFromContentBlocks,
  thinkingFromContentBlocks,
  toolResultBlocksFromContent,
  toolUseBlocksFromContent,
} from "./content-blocks";
export type { AgentGatewayErrorCode, GatewayRecoveryKind } from "./errors";
// -- Errors (Gateway 标准错误与恢复分类) --
export {
  AgentGatewayError,
  classifyGatewayRecovery,
  isAbortError,
  isOutputTruncated,
} from "./errors";

// -- Message pairing --
export { ensureToolResultPairing, withEphemeralPrompt } from "./message-pairing";
// -- Types --
export type {
  AgentModelContentBlock,
  AgentModelGateway,
  AgentModelImageBlock,
  AgentModelMessage,
  AgentModelRequest,
  AgentModelResponse,
  AgentModelStreamChunk,
  AgentModelTextBlock,
  AgentModelThinkingBlock,
  AgentModelToolResultBlock,
  AgentModelToolUseBlock,
  AgentResponseContract,
  AgentToolSchema,
  PreparedAgentModelRequest,
  ResolvedAgentModelConfig,
  StopReason,
} from "./types";
