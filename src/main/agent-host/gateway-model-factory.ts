import { createHash } from "node:crypto";
import type {
  ModelAssistantMessage,
  ModelBinding,
  ModelCapabilities,
  ModelClientFactory,
  ModelRequest,
  ModelResponse,
  ModelSelection,
  ModelStreamEvent,
  ModelToolContent,
} from "../../agent/model/model-contract";
import { AgentError, sameValue, snapshot } from "../../agent/protocol-utils";
import type { JsonObject, JsonValue } from "../../agent/protocol-values";
import type { AgentModelSelection } from "../../shared/agent";
import { ensureToolResultPairing } from "../agent/gateway/message-pairing";
import type {
  AgentModelContentBlock,
  AgentModelGateway,
  AgentModelImageBlock,
  AgentModelMessage,
  AgentModelRequest,
  AgentModelResponse,
  AgentModelStreamChunk,
  AgentModelToolResultBlock,
} from "../agent/gateway/types";

export interface GatewayModelBindingSource {
  readonly gateway: AgentModelGateway;
  readonly selection: AgentModelSelection;
  readonly capabilities: ModelCapabilities;
  /** 必须描述真实旧 Gateway 路径，不能把 Responses 当作无损 thinking 重放器。 */
  readonly callPath: "anthropic" | "chat" | "responses";
  /** 宿主提供的稳定连接身份，跨进程保持一致；仅摘要进入重放状态。 */
  readonly replayScope: string;
  /** 只释放本次取得的资源；省略表示借用 Gateway。 */
  readonly dispose?: () => Promise<void>;
}

export type GatewayModelResolver = (
  selection: ModelSelection,
  signal: AbortSignal,
) => GatewayModelBindingSource | Promise<GatewayModelBindingSource>;

const REPLAY_FORMAT = "agent-gateway/content-blocks";

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Model request aborted.", "AbortError");
}

function projectAssistant(
  blocks: readonly AgentModelContentBlock[],
): ModelAssistantMessage["content"] {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new AgentError("invalid-gateway-response", "Gateway returned no authoritative content.");
  }
  const content: ModelAssistantMessage["content"][number][] = [];
  const calls = new Set<string>();
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (typeof block.text !== "string")
          throw new AgentError("invalid-gateway-response", "Invalid text block.");
        content.push({ type: "text", text: block.text });
        break;
      case "thinking":
        if (typeof block.thinking !== "string" || typeof block.signature !== "string") {
          throw new AgentError("invalid-gateway-response", "Invalid thinking block.");
        }
        content.push({ type: "reasoning", text: block.thinking });
        break;
      case "redacted_thinking":
        if (typeof block.data !== "string")
          throw new AgentError("invalid-gateway-response", "Invalid private replay block.");
        break;
      case "tool_use":
        if (block.parseError !== undefined) {
          throw new AgentError(
            "invalid-tool-arguments",
            "Gateway returned unparseable tool arguments.",
          );
        }
        if (
          !block.id ||
          !block.name ||
          calls.has(block.id) ||
          !block.input ||
          typeof block.input !== "object" ||
          Array.isArray(block.input)
        ) {
          throw new AgentError("invalid-gateway-response", "Invalid or duplicate tool call.");
        }
        calls.add(block.id);
        content.push({
          type: "tool-call",
          callId: block.id,
          name: block.name,
          input: snapshot(block.input) as JsonObject,
        });
        break;
      default:
        throw new AgentError(
          "unsupported-gateway-content",
          "Gateway assistant content cannot be represented by the model protocol.",
        );
    }
  }
  return content;
}

/** 显式宿主绑定：凭据留在 resolver/Gateway 内，内核只得到无密钥选择和客户端。 */
export function createGatewayModelFactory(resolve: GatewayModelResolver): ModelClientFactory {
  return {
    async create(selection, signal): Promise<ModelBinding> {
      checkAborted(signal);
      const selected: ModelSelection = snapshot({
        providerId: selection.providerId,
        modelId: selection.modelId,
        ...(selection.reasoningEffort !== undefined
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      });
      if (selected.reasoningEffort !== undefined) {
        throw new AgentError(
          "unsupported-reasoning-effort",
          "Legacy Gateway does not support explicit reasoning effort.",
        );
      }
      let source: GatewayModelBindingSource;
      try {
        source = await resolve(snapshot(selected), signal);
      } catch {
        checkAborted(signal);
        throw new AgentError(
          "model-resolution-failed",
          "Host could not resolve the requested model.",
        );
      }
      let disposed = false;
      let disposePromise: Promise<void> | undefined;
      const lifetime = new AbortController();
      async function dispose(): Promise<void> {
        if (disposePromise) return disposePromise;
        disposed = true;
        disposePromise = Promise.resolve().then(async () => {
          lifetime.abort();
          try {
            await source.dispose?.();
          } catch {
            throw new AgentError(
              "model-disposal-failed",
              "Host model binding could not be released.",
            );
          }
        });
        return disposePromise;
      }
      try {
        checkAborted(signal);
        const oldSelection: AgentModelSelection = snapshot({
          provider: source.selection.provider,
          model: source.selection.model,
          ...(source.selection.configurationId !== undefined
            ? { configurationId: source.selection.configurationId }
            : {}),
          ...(source.selection.vendorId !== undefined
            ? { vendorId: source.selection.vendorId }
            : {}),
          ...(source.selection.baseURL !== undefined ? { baseURL: source.selection.baseURL } : {}),
          ...(source.selection.openaiApiMode !== undefined
            ? { openaiApiMode: source.selection.openaiApiMode }
            : {}),
          ...(source.selection.supports1MContext !== undefined
            ? { supports1MContext: source.selection.supports1MContext }
            : {}),
        });
        const capabilities: ModelCapabilities = snapshot({
          streaming: source.capabilities.streaming,
          toolCalls: source.capabilities.toolCalls,
          images: source.capabilities.images,
          reasoning: source.capabilities.reasoning,
        });
        const callPath = source.callPath;
        if (
          (oldSelection.provider === "anthropic") !== (callPath === "anthropic") ||
          !["anthropic", "chat", "responses"].includes(callPath)
        ) {
          throw new AgentError(
            "invalid-gateway-binding",
            "Gateway provider and call path do not agree.",
          );
        }
        if (callPath === "chat" && capabilities.images) {
          throw new AgentError(
            "unsupported-gateway-capability",
            "Legacy Chat Gateway replaces images rather than transmitting them.",
          );
        }
        if (typeof source.replayScope !== "string" || !source.replayScope) {
          throw new AgentError(
            "invalid-replay-scope",
            "Host must supply a stable Gateway replay scope.",
          );
        }
        // endpoint 可能携带秘密，只保存连接身份摘要，不能跨 endpoint 重放签名。
        const transport = {
          provider: oldSelection.provider,
          model: oldSelection.model,
          callPath,
          connectionId: createHash("sha256")
            .update(JSON.stringify([source.replayScope, oldSelection]))
            .digest("hex"),
          ...(oldSelection.configurationId !== undefined
            ? { configurationId: oldSelection.configurationId }
            : {}),
          ...(oldSelection.vendorId !== undefined ? { vendorId: oldSelection.vendorId } : {}),
        };
        function requestSignal(requested: AbortSignal): AbortSignal {
          if (disposed) throw new AgentError("model-disposed", "Model binding has been disposed.");
          const combined = AbortSignal.any([signal, lifetime.signal, requested]);
          checkAborted(combined);
          return combined;
        }
        function toolContent(
          content: ModelToolContent,
        ): AgentModelImageBlock | { type: "text"; text: string } {
          if (content.type === "text") return { type: "text", text: content.text };
          if (!capabilities.images || callPath === "chat") {
            throw new AgentError(
              "unsupported-model-images",
              "This Gateway binding cannot transmit images losslessly.",
            );
          }
          if (content.source.type !== "base64") {
            throw new AgentError(
              "unsupported-image-source",
              "Legacy Gateway requires base64 image content, not remote URLs.",
            );
          }
          const mediaType = content.source.mediaType;
          if (
            mediaType !== "image/png" &&
            mediaType !== "image/jpeg" &&
            mediaType !== "image/webp" &&
            mediaType !== "image/gif"
          ) {
            throw new AgentError(
              "unsupported-image-type",
              "Gateway does not support this image media type.",
            );
          }
          return { type: "image", mediaType, data: content.source.data };
        }
        function assistantContent(message: ModelAssistantMessage): AgentModelContentBlock[] {
          if (message.replayState) {
            const replay = message.replayState;
            if (
              replay.providerId !== selected.providerId ||
              replay.modelId !== selected.modelId ||
              replay.format !== REPLAY_FORMAT ||
              replay.version !== 1
            ) {
              throw new AgentError(
                "incompatible-model-replay",
                "Assistant private replay belongs to another model or adapter version.",
              );
            }
            const data = replay.data;
            if (
              data === null ||
              typeof data !== "object" ||
              Array.isArray(data) ||
              !("transport" in data) ||
              !("content" in data) ||
              !Array.isArray(data.content) ||
              !sameValue(data.transport, transport)
            ) {
              throw new AgentError(
                "incompatible-model-replay",
                "Assistant private replay belongs to another Gateway transport.",
              );
            }
            const raw = snapshot(data.content) as unknown as AgentModelContentBlock[];
            if (!sameValue(projectAssistant(raw), message.content)) {
              throw new AgentError(
                "model-replay-conflict",
                "Assistant canonical content does not match its private replay.",
              );
            }
            if (
              callPath === "responses" &&
              raw.some((block) => block.type === "thinking" || block.type === "redacted_thinking")
            ) {
              throw new AgentError(
                "unsupported-model-replay",
                "Legacy Responses Gateway cannot replay private reasoning losslessly.",
              );
            }
            if (
              callPath === "chat" &&
              raw.some(
                (block) =>
                  block.type === "redacted_thinking" ||
                  (block.type === "thinking" && block.signature !== "chat-reasoning"),
              )
            ) {
              throw new AgentError(
                "unsupported-model-replay",
                "Chat Gateway cannot replay signed or redacted provider reasoning.",
              );
            }
            return raw;
          }
          return message.content.map((block): AgentModelContentBlock => {
            if (block.type === "text") return { type: "text", text: block.text };
            if (block.type === "tool-call")
              return {
                type: "tool_use",
                id: block.callId,
                name: block.name,
                input: snapshot(block.input),
              };
            throw new AgentError(
              "missing-model-replay",
              "Reasoning history requires its original private Gateway replay state.",
            );
          });
        }
        function prepare(request: ModelRequest, combined: AbortSignal): AgentModelRequest {
          const input = snapshot(request);
          if (input.tools?.length && !capabilities.toolCalls) {
            throw new AgentError(
              "unsupported-model-tools",
              "Model binding does not support tool calls.",
            );
          }
          const system: string[] = [];
          const messages: AgentModelMessage[] = [];
          for (const message of input.messages) {
            if (message.role === "system") {
              if (messages.length > 0)
                throw new AgentError(
                  "unsupported-system-position",
                  "Gateway system messages must precede conversation history.",
                );
              system.push(...message.content.map((block) => block.text));
            } else if (message.role === "user") {
              messages.push({ role: "user", content: message.content.map(toolContent) });
            } else if (message.role === "assistant") {
              const content = assistantContent(message);
              if (!capabilities.toolCalls && content.some((block) => block.type === "tool_use")) {
                throw new AgentError(
                  "unsupported-model-tools",
                  "Model binding cannot replay tool calls.",
                );
              }
              messages.push({ role: "assistant", content });
            } else {
              const content: AgentModelToolResultBlock[] = message.content.map((result) => ({
                type: "tool_result",
                toolUseId: result.callId,
                content: result.content.map(toolContent),
                ...(result.isError !== undefined ? { isError: result.isError } : {}),
              }));
              const previous = messages.at(-1);
              if (
                previous?.role === "user" &&
                previous.content.every((block) => block.type === "tool_result")
              )
                previous.content.push(...content);
              else messages.push({ role: "user", content });
            }
          }
          // 旧 Gateway 会修补缺失结果/去重。新协议必须拒绝此类输入，不能静默改写规范历史。
          if (!sameValue(ensureToolResultPairing(messages), messages)) {
            throw new AgentError(
              "invalid-model-history",
              "Gateway history requires exact ordered tool call/result pairs and nonempty messages.",
            );
          }
          return {
            prompt: "",
            responseContract: "none",
            messages,
            signal: combined,
            ...(system.length ? { systemPrompt: system.join("\n\n") } : {}),
            ...(input.tools !== undefined
              ? {
                  tools: input.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: snapshot(tool.inputSchema),
                  })),
                }
              : {}),
            ...(input.maxOutputTokens !== undefined
              ? { maxOutputTokens: input.maxOutputTokens }
              : {}),
          };
        }
        function response(
          content: AgentModelContentBlock[],
          stopReason: AgentModelResponse["stopReason"],
          usage: AgentModelResponse["usage"],
        ): ModelResponse {
          const raw = snapshot(content);
          const canonical = projectAssistant(raw);
          if (!capabilities.toolCalls && canonical.some((block) => block.type === "tool-call")) {
            throw new AgentError(
              "unsupported-model-tools",
              "Gateway returned tools for a model without tool support.",
            );
          }
          const privateState = raw.some(
            (block) => block.type === "thinking" || block.type === "redacted_thinking",
          );
          // snapshot 已严格校验 JSON；旧 Gateway 的 input 静态类型仍为 unknown。
          const replayContent = raw as unknown as JsonValue;
          return snapshot<ModelResponse>({
            message: {
              role: "assistant",
              content: canonical,
              ...(privateState
                ? {
                    replayState: {
                      providerId: selected.providerId,
                      modelId: selected.modelId,
                      format: REPLAY_FORMAT,
                      version: 1,
                      data: { transport, content: replayContent },
                    },
                  }
                : {}),
            },
            finishReason:
              stopReason === "end"
                ? "stop"
                : stopReason === "tool_use"
                  ? "tool-calls"
                  : stopReason === "max_tokens"
                    ? "length"
                    : "other",
            ...(usage
              ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }
              : {}),
          });
        }
        return {
          dispose,
          client: {
            get selection() {
              return snapshot(selected);
            },
            get capabilities() {
              return snapshot(capabilities);
            },
            async generate(request, requestedSignal) {
              const combined = requestSignal(requestedSignal);
              const prepared = prepare(request, combined);
              let result: AgentModelResponse;
              try {
                result = await source.gateway.queryModel(prepared, snapshot(oldSelection));
              } catch {
                checkAborted(combined);
                throw new AgentError("model-gateway-failed", "Model Gateway request failed.");
              }
              checkAborted(combined);
              if (
                result.provider !== oldSelection.provider ||
                result.model !== oldSelection.model
              ) {
                throw new AgentError(
                  "model-response-mismatch",
                  "Gateway returned a different model identity.",
                );
              }
              return response(result.content, result.stopReason, result.usage);
            },
            async *stream(request, requestedSignal): AsyncGenerator<ModelStreamEvent> {
              if (!capabilities.streaming)
                throw new AgentError(
                  "unsupported-model-streaming",
                  "Model binding does not support streaming.",
                );
              const combined = requestSignal(requestedSignal);
              const prepared = prepare(request, combined);
              let completed: Extract<AgentModelStreamChunk, { type: "complete" }> | undefined;
              try {
                for await (const chunk of source.gateway.queryModelStream(
                  prepared,
                  snapshot(oldSelection),
                )) {
                  checkAborted(combined);
                  if (completed) throw new Error("Gateway emitted after completion.");
                  if (chunk.type === "complete") {
                    completed = {
                      type: "complete",
                      content: snapshot(chunk.content),
                      ...(chunk.stopReason !== undefined ? { stopReason: chunk.stopReason } : {}),
                      ...(chunk.usage !== undefined ? { usage: snapshot(chunk.usage) } : {}),
                    };
                  }
                }
              } catch {
                checkAborted(combined);
                throw new AgentError("model-gateway-failed", "Model Gateway stream failed.");
              }
              checkAborted(combined);
              if (!completed)
                throw new AgentError(
                  "incomplete-model-stream",
                  "Gateway stream ended without authoritative completion.",
                );
              // 旧 SDK 的 index 不是最终规范内容位置，且 redacted 块没有公开槽位。
              // 不伪造增量索引；真正的流传输结束后只发布唯一权威响应。
              yield {
                type: "completed",
                response: response(completed.content, completed.stopReason, completed.usage),
              };
            },
          },
        };
      } catch (error) {
        await dispose();
        throw error;
      }
    },
  };
}
