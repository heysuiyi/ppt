import type { AgentRunResult } from "../../agent/agent-contract";
import { AgentError, asProtocolError } from "../../agent/protocol-errors";
import type { ProtocolError } from "../../agent/protocol-values";
import type { RuntimeEvent } from "../../agent/session/session-events";
import {
  MIMO_TOKEN_PLAN_CN_MAX_OUTPUT_TOKENS,
  MIMO_TOKEN_PLAN_CN_PROVIDER_ID,
  supportsMimoTokenPlanCNModel,
} from "../../models/mimo-token-plan-cn-contract";
import type { AgentConfigurationSnapshot } from "../../shared/agent-configuration";
import { ToolsError } from "../../tools/tools";

export interface DevelopmentCommand {
  readonly prompt?: string;
}
export type DevelopmentArguments =
  | { readonly mode: "help" }
  | { readonly mode: "run"; readonly command: DevelopmentCommand };

export const DEVELOPMENT_HELP = `通用 Agent 独立开发入口（不会启动 PPT/UI）

npm run agent:dev
npm run agent:dev -- --prompt <问题>

选项：
  --prompt      执行一次任务后退出；省略时进入循环对话
  --help, -h    显示帮助

工作区使用启动目录。首次启动按厂商、凭据、模型的顺序引导配置，API Key 明文回显。
缺配置且没有交互终端时明确退出；配置保存后继续原任务。
交互命令：/model 选择或配置模型，/new 新会话，/resume 选择历史会话，
/tools 选择只读或读写工具，/help 查看命令，/exit 退出。
默认只读，工作区内 read/glob/grep 自动允许；write/edit 逐次 yes/no/cancel 审批。EOF 保留 waiting，Ctrl+C 取消。
执行事实和结果保留逐行 JSON；向导、菜单和输入提示为可读文本。
AGENT_PPT_DATA_DIR 可指定配置根；开发历史仍使用独立 agent-development.sqlite。
当前仅支持 MiMo Token Plan 中国原生连接。
`;

export function parseDevelopmentArguments(args: readonly string[]): DevelopmentArguments {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { mode: "help" };
  if (args.length === 0) return { mode: "run", command: {} };
  if (args.length === 2 && args[0] === "--prompt" && args[1]?.trim()) {
    return { mode: "run", command: { prompt: args[1] } };
  }
  throw new AgentError(
    "CLI_ARGUMENTS_INVALID",
    "仅支持 --prompt <问题> 和 --help；模型、工具和会话请在交互中选择。",
  );
}

export type DevelopmentModelStatus =
  | "ready"
  | "disabled"
  | "unsupported-adapter"
  | "unsupported-model"
  | "invalid-budget"
  | "credential-storage-unavailable"
  | "missing-credential";

export interface DevelopmentModelOption {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly connectionKind: string;
  readonly remoteModelId: string;
  readonly reasoningEffort?: string;
  readonly status: DevelopmentModelStatus;
}

/** 只投影已保存的公开元数据与凭据状态，不解析密钥或请求远程模型。 */
export function projectDevelopmentModels(
  snapshot: AgentConfigurationSnapshot | undefined,
): readonly DevelopmentModelOption[] {
  if (!snapshot) return [];
  const configuredVendors = new Set(
    snapshot.credentials.models.filter((entry) => entry.configured).map((entry) => entry.vendorId),
  );
  return snapshot.settings.vendors.flatMap((vendor) =>
    vendor.models.map((model): DevelopmentModelOption => {
      const status: DevelopmentModelStatus =
        !vendor.enabled || !model.enabled
          ? "disabled"
          : vendor.kind !== MIMO_TOKEN_PLAN_CN_PROVIDER_ID
            ? "unsupported-adapter"
            : !supportsMimoTokenPlanCNModel(model.model)
              ? "unsupported-model"
              : snapshot.settings.gateway.maxOutputTokens > MIMO_TOKEN_PLAN_CN_MAX_OUTPUT_TOKENS
                ? "invalid-budget"
                : snapshot.credentials.storage.state === "unavailable"
                  ? "credential-storage-unavailable"
                  : !configuredVendors.has(vendor.id)
                    ? "missing-credential"
                    : "ready";
      return {
        id: model.id,
        name: model.name,
        vendor: vendor.label,
        connectionKind: vendor.kind,
        remoteModelId: model.model,
        ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
        status,
      };
    }),
  );
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
