import type { AgentRunResult } from "../../agent/agent-contract";
import { AgentError, asProtocolError } from "../../agent/protocol-utils";
import type { ProtocolError } from "../../agent/protocol-values";
import type { RuntimeEvent } from "../../agent/session/session-events";
import { ToolsError, type ToolsMode } from "../../tools/tools";

export interface DevelopmentCommand {
  readonly modelId: string;
  readonly workspaceRoot: string;
  readonly toolMode: ToolsMode;
  readonly threadId?: string;
  readonly queryId?: string;
  readonly resumeQueryId?: string;
  readonly prompt?: string;
}
export type DevelopmentArguments =
  | { readonly help: true }
  | { readonly help: false; readonly command: DevelopmentCommand };

export const DEVELOPMENT_HELP = `通用 Agent 独立开发入口（不会启动 PPT/UI）

npm run agent:dev -- --model <已配置模型ID> --workspace <已有目录> [--prompt <问题>]
npm run agent:dev -- --model <已配置模型ID> --workspace <原目录> --thread <会话ID> --resume <QueryID>

选项：
  --model       应用 Settings 中的模型配置 ID，不是远程模型名称
  --workspace   已有工作目录；UTF-8 文本，单文件最多 64 KiB
  --tools       read-only（默认：read/glob/grep）或 read-write（另启用 write/edit）
  --thread      继续指定会话；省略时创建新会话并输出 ID
  --query       新请求的 Query ID；省略时生成
  --resume      恢复已有 Query，必须同时指定 --thread
  --prompt      执行单个问题；省略时从 stdin 逐行读取
  --help        显示帮助

每次工作区工具调用都等待 yes/no/cancel，包括显式启用的写入；EOF 保留 waiting，Ctrl+C 取消当前请求。
AGENT_PPT_DATA_DIR 可指定已有配置根；开发状态单独存入 agent-development.sqlite。
仅支持已接入的原生模型适配器；当前为 MiMo Token Plan 中国预设，其他连接明确拒绝，不回退旧执行链。
`;

export function parseDevelopmentArguments(args: readonly string[]): DevelopmentArguments {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { help: true };
  const allowed: Record<string, true> = {
    "--model": true,
    "--workspace": true,
    "--tools": true,
    "--thread": true,
    "--query": true,
    "--resume": true,
    "--prompt": true,
  };
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !Object.hasOwn(allowed, flag) ||
      values.has(flag) ||
      value === undefined ||
      value.startsWith("--") ||
      !value.trim()
    ) {
      throw new AgentError(
        "CLI_ARGUMENTS_INVALID",
        "参数不完整、重复或不受支持；使用 --help 查看用法。",
      );
    }
    values.set(flag, value);
  }
  const modelId = values.get("--model");
  const workspaceRoot = values.get("--workspace");
  const threadId = values.get("--thread");
  const queryId = values.get("--query");
  const resumeQueryId = values.get("--resume");
  const prompt = values.get("--prompt");
  const toolMode = values.get("--tools") ?? "read-only";
  if (!modelId || !workspaceRoot || (resumeQueryId && (!threadId || queryId || prompt))) {
    throw new AgentError(
      "CLI_ARGUMENTS_INVALID",
      "需要 --model 与 --workspace；--resume 必须带 --thread，且不能同时提交新问题。",
    );
  }
  if (toolMode !== "read-only" && toolMode !== "read-write") {
    throw new AgentError("CLI_ARGUMENTS_INVALID", "--tools 必须是 read-only 或 read-write。");
  }
  return {
    help: false,
    command: {
      modelId,
      workspaceRoot,
      toolMode,
      ...(threadId ? { threadId } : {}),
      ...(queryId ? { queryId } : {}),
      ...(resumeQueryId ? { resumeQueryId } : {}),
      ...(prompt ? { prompt } : {}),
    },
  };
}

export function publicDevelopmentError(error: unknown): ProtocolError {
  if (error instanceof ToolsError) return { code: error.code, message: error.message };
  return asProtocolError(error);
}

/** 只投影公开事实；不把调用输入、工具内容、重放状态或 reasoning 整体序列化到终端。 */
export function projectDevelopmentEvent(event: RuntimeEvent): object | undefined {
  if (event.kind !== "fact") return undefined;
  const base = { type: event.type, ...event.identity };
  switch (event.type) {
    case "tool.started":
      return {
        ...base,
        step: event.step,
        tool: event.invocation.call.name,
        callId: event.invocation.call.callId,
      };
    case "tool.completed":
      return {
        ...base,
        step: event.step,
        tool: event.invocation.call.name,
        callId: event.invocation.call.callId,
        status: event.completion.status,
        effects: event.completion.effects,
        ...(event.completion.status === "succeeded" ? {} : { error: event.completion.error }),
      };
    case "step.started":
      return { ...base, step: event.step };
    case "step.committed":
      return { ...base, step: event.step, historyRevision: event.historyRevision };
    case "run.failed":
      return { ...base, error: event.error };
    case "run.waiting":
      return { ...base, interactionId: event.interactionId };
    case "interaction.requested":
    case "interaction.resolved":
      return undefined;
    default:
      return base;
  }
}

export function projectDevelopmentResult(result: AgentRunResult): object {
  const base = { type: "result", ...result.identity, status: result.status };
  if (result.status === "completed")
    return {
      ...base,
      messages: result.output
        .filter((message) => message.role === "assistant")
        .map((message) => ({
          role: "assistant",
          text: message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        })),
    };
  if (result.status === "waiting") return { ...base, interactionId: result.interaction.id };
  if (result.status === "failed") return { ...base, error: result.error };
  return base;
}
