import { agentQuestionInputSchema } from "@shared/agent-question";
import { z } from "zod";
import { type AgentAskUserResult, agentAskUserResultSchema } from "../../runtime/runtime-types";
import type { ToolDefinition } from "../tool-definition";

export const askUserSchema = z.object({
  message: z
    .string()
    .describe("向用户展示的完整问题正文；不得只写以冒号结尾的引导语，具体问题必须出现在正文中"),
  missingFields: z.array(z.string()).optional().describe("阻止安全执行的具体缺失信息"),
  responseUi: agentQuestionInputSchema
    .optional()
    .describe("可选的回答界面配置对象，不是问题正文；必须直接传对象，禁止 JSON.stringify。"),
});

const missingFieldLabels: Record<string, string> = {
  audience: "目标受众",
  focus: "内容侧重点",
  pageCount: "页数范围",
  purpose: "使用目的",
  style: "视觉风格",
  topic: "主题",
};

function humanizeMissingField(field: string): string {
  return (
    missingFieldLabels[field] ??
    field
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim()
  );
}

export function completeAskUserMessage(message: string, missingFields?: string[]): string {
  const trimmed = message.trim();
  const missingLabels = (missingFields ?? [])
    .map((field) => ({ field, label: humanizeMissingField(field) }))
    .filter(({ field, label }) => {
      const normalizedMessage = trimmed.toLocaleLowerCase();
      return (
        !normalizedMessage.includes(field.toLocaleLowerCase()) &&
        !normalizedMessage.includes(label.toLocaleLowerCase())
      );
    })
    .map(({ label }) => label)
    .filter(Boolean);

  if (missingLabels.length === 0) return trimmed;
  return `${trimmed}\n\n请补充：${missingLabels.join("、")}。`;
}

/**
 * Core Tool: 在缺少必要信息或目标存在高影响歧义时请求用户补充。
 * 应先读取 PPT、当前页和选择上下文；能安全继续时不得滥用追问。
 * 本工具只结束当前 Runtime 回合，不保存或修改 Presentation。
 */
export const askUserTool: ToolDefinition<typeof askUserSchema, AgentAskUserResult> = {
  name: "AskUser",
  description:
    "仅在缺少由用户决定的必要内容信息或指令存在高影响歧义时提问。" +
    "message 必须包含用户可直接回答的完整问题，不能把具体问题只放在 missingFields。" +
    "不得询问用户工具名、接口、环境能力或系统实现方式。",
  category: "core",
  loadPolicy: "core",
  inputSchema: askUserSchema,
  examples: [
    '{"message":"请选择内容侧重点","missingFields":["focus"],"responseUi":{"variant":"choices","options":[{"id":"theory","title":"理论框架"},{"id":"practice","title":"实践案例"}]}}',
    '{"message":"请补充目标受众","missingFields":["audience"],"responseUi":{"variant":"markdown","placeholder":"例如：企业管理者"}}',
  ],
  outputSchema: agentAskUserResultSchema,
  behavior: {
    capabilities: ["user_interaction"],
    completion: {
      terminalResult: "ask_user",
      expectation: "always",
      exclusiveBatch: true,
    },
  },
  risk: "low",
  execute: async (args) => {
    const content = completeAskUserMessage(args.message, args.missingFields);
    const data = {
      content,
      ...(args.missingFields ? { missingFields: args.missingFields } : {}),
      ...(args.responseUi ? { question: args.responseUi } : {}),
    };
    return {
      type: "ask_user",
      ...data,
    };
  },
};
