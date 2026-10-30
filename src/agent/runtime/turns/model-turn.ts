import type { ModelRequest, ModelResponse } from "../../model/model-contract";
import { AgentError, snapshot } from "../../protocol-utils";
import type { RunEnvironment } from "../run-controller";

/** 增量不驱动状态提交；完整响应通过后才允许进入工具派发。 */
export async function executeModelTurn(
  env: RunEnvironment,
  request: ModelRequest,
  requestId: string,
  step: number,
): Promise<ModelResponse> {
  env.signal.throwIfAborted();
  if (
    !env.model.capabilities.images &&
    request.messages.some((message) =>
      message.content.some(
        (part) =>
          part.type === "image" ||
          (part.type === "tool-result" && part.content.some((content) => content.type === "image")),
      ),
    )
  ) {
    throw new AgentError("MODEL_CAPABILITY", "Selected model does not accept image input");
  }
  let response: ModelResponse | undefined;
  if (env.model.capabilities.streaming) {
    for await (const event of env.model.stream(snapshot(request), env.signal)) {
      env.signal.throwIfAborted();
      if (response)
        throw new AgentError("INVALID_MODEL_STREAM", "Model emitted data after completion");
      if (event.type === "completed") {
        response = snapshot(event.response);
      } else {
        if (!Number.isSafeInteger(event.index) || event.index < 0)
          throw new AgentError("INVALID_MODEL_STREAM", "Invalid content position");
        env.emit({
          identity: env.identity,
          kind: "stream",
          type: "model.delta",
          requestId,
          step,
          contentIndex: event.index,
          delta: snapshot(event.delta),
        });
      }
    }
    if (!response)
      throw new AgentError(
        "INCOMPLETE_MODEL_STREAM",
        "Model stream ended without a complete response",
      );
  } else {
    response = snapshot(await env.model.generate(snapshot(request), env.signal));
    env.signal.throwIfAborted();
  }
  if (response.message.role !== "assistant" || !Array.isArray(response.message.content)) {
    throw new AgentError("INVALID_MODEL_RESPONSE", "Expected an assistant message");
  }
  if (response.finishReason === "length")
    throw new AgentError("MODEL_TRUNCATED", "Model output was truncated before a complete step");
  if (response.finishReason !== "stop" && response.finishReason !== "tool-calls")
    throw new AgentError("MODEL_STOPPED", "Model did not complete the step");
  const ids = new Set<string>();
  for (const part of response.message.content) {
    if (part.type === "tool-call") {
      if (
        !env.model.capabilities.toolCalls ||
        !part.callId ||
        !part.name ||
        part.input === null ||
        typeof part.input !== "object" ||
        Array.isArray(part.input) ||
        ids.has(part.callId)
      ) {
        throw new AgentError("INVALID_MODEL_RESPONSE", "Invalid or duplicate model tool call");
      }
      ids.add(part.callId);
    } else if (
      (part.type !== "text" && part.type !== "reasoning") ||
      typeof part.text !== "string"
    ) {
      throw new AgentError("INVALID_MODEL_RESPONSE", "Unsupported assistant content");
    }
  }
  if (response.finishReason === "tool-calls" && ids.size === 0)
    throw new AgentError("INVALID_MODEL_RESPONSE", "Tool finish without any tool calls");
  return response;
}
