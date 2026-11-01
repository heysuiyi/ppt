import { AgentGatewayError, isAbortError } from "../../gateway";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConnectionTerminated(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    message === "terminated" ||
    /connection (?:closed|reset|terminated)/i.test(message) ||
    /socket hang up/i.test(message)
  );
}

/** User-facing Chinese copy for recoverable agent failures. */
export function formatRecoverableAgentError(error: unknown, signal?: AbortSignal): string | null {
  if (isAbortError(error, signal) || errorMessage(error) === "Run aborted by user.") {
    return "会话已中断。";
  }

  if (error instanceof AgentGatewayError) {
    switch (error.code) {
      case "aborted":
        return "会话已中断。";
      case "timeout":
        return `${error.message} 请重试，或在设置 → 工作流中增大请求超时时间。`;
      case "rate-limit":
      case "overloaded":
        return `${error.message} 请稍后再试。`;
      case "prompt-too-long":
        return `${error.message} 上下文过长，系统已尝试压缩后重试。`;
      case "authentication":
        return `${error.message} 请检查 API Key 与代理地址。`;
      case "provider-error":
        if (isConnectionTerminated(error) || isConnectionTerminated(error.cause)) {
          return "与模型的连接中断（terminated）。常见于长时间思考无输出、代理超时或网络波动。请直接重试；若反复出现，可在设置中增大请求超时或更换端点。";
        }
        return `${error.message} 请重试；若持续失败，请检查网络与模型配置。`;
      default:
        return `${error.message} 请重试。`;
    }
  }

  if (isConnectionTerminated(error)) {
    return "与模型的连接中断（terminated）。请重试；若使用代理，请检查其超时设置。";
  }

  return null;
}
