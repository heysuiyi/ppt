export type AgentToolDisplayCategory =
  | "read"
  | "search"
  | "inspect"
  | "change"
  | "coordinate"
  | "other";

export type AgentToolActivityState =
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "invalid-input";

interface AgentToolDisplayCopy {
  action: string;
  category: AgentToolDisplayCategory;
}

/**
 * Tool names are protocol identifiers. Keep their user-facing copy centralized so
 * CamelCase/snake_case implementation details never need to reach the activity UI.
 */
const TOOL_DISPLAY_COPY = {
  AskUser: { action: "确认需求", category: "coordinate" },
  BeginPptCapability: { action: "开始演示文稿任务", category: "coordinate" },
  EditFile: { action: "编辑工作文件", category: "change" },
  GetDesignReference: { action: "读取设计参考", category: "read" },
  ResolveProjectTemplate: { action: "解析项目模板", category: "read" },
  GetSelection: { action: "读取当前选择", category: "read" },
  Glob: { action: "查找工作文件", category: "search" },
  list_teammates: { action: "查看协作进度", category: "coordinate" },
  ListSlides: { action: "读取页面列表", category: "read" },
  PreviewSvgPage: { action: "预览 SVG 页面", category: "inspect" },
  ReadFile: { action: "读取工作文件", category: "read" },
  ReadCurrentSlide: { action: "读取当前页面", category: "read" },
  ReadPresentationSnapshot: { action: "读取演示文稿", category: "read" },
  respond_plan_approval: { action: "确认任务计划", category: "coordinate" },
  send_teammate_message: { action: "同步协作信息", category: "coordinate" },
  SetPptTaskAssessment: { action: "评估演示任务路径", category: "coordinate" },
  shutdown_teammate: { action: "结束协作任务", category: "coordinate" },
  spawn_teammate: { action: "启动协作任务", category: "coordinate" },
  SubmitPptReview: { action: "提交演示文稿审查", category: "read" },
  SubmitSvgDeck: { action: "提交 SVG 演示文稿", category: "change" },
  TaskCreate: { action: "建立任务", category: "coordinate" },
  TaskArchiveList: { action: "归档任务列表", category: "coordinate" },
  TaskAssign: { action: "指派任务", category: "coordinate" },
  TaskUpdate: { action: "更新任务", category: "coordinate" },
  TaskCloseList: { action: "关闭任务列表", category: "coordinate" },
  TaskDelete: { action: "删除任务", category: "coordinate" },
  TaskList: { action: "读取任务计划", category: "read" },
  TaskGet: { action: "读取任务详情", category: "read" },
  TaskClaim: { action: "领取任务", category: "coordinate" },
  TaskRelease: { action: "释放任务", category: "coordinate" },
  TaskReopen: { action: "重新打开任务", category: "coordinate" },
  TaskReopenList: { action: "重新打开任务列表", category: "coordinate" },
  TaskReviewRequest: { action: "请求任务验收", category: "coordinate" },
  TaskReviewApprove: { action: "通过任务验收", category: "coordinate" },
  TaskReviewReject: { action: "退回任务修改", category: "coordinate" },
  TaskTransfer: { action: "转交任务", category: "coordinate" },
  LoadSkill: { action: "准备专业能力", category: "coordinate" },
  WebSearch: { action: "查找在线资料", category: "search" },
  WriteFile: { action: "保存工作文件", category: "change" },
  SearchSlideImages: { action: "搜索幻灯片图片", category: "search" },
  PreviewSlide: { action: "生成页面预览", category: "inspect" },

  bash: { action: "执行本地操作", category: "change" },
  web_search: { action: "查找在线资料", category: "search" },
  recovery: { action: "恢复当前任务", category: "coordinate" },
} as const satisfies Record<string, AgentToolDisplayCopy>;

const FALLBACK_ACTIONS: Record<AgentToolDisplayCategory, string> = {
  read: "读取相关信息",
  search: "查找相关资料",
  inspect: "检查当前内容",
  change: "更新演示内容",
  coordinate: "协调处理任务",
  other: "处理当前任务",
};

function inferToolCategory(toolName: string): AgentToolDisplayCategory {
  if (/task|teammate|spawn|message|approval|skill/i.test(toolName)) return "coordinate";
  if (/search|find|web|glob/i.test(toolName)) return "search";
  if (/read|get|list|load/i.test(toolName)) return "read";
  if (/preview|validate|analyze|detect|inspect/i.test(toolName)) return "inspect";
  if (
    /submit|execute|apply|update|insert|rewrite|compress|beautify|export|write|edit/i.test(toolName)
  ) {
    return "change";
  }
  return "other";
}

export function hasAgentToolDisplayCopy(toolName: string): boolean {
  return Object.hasOwn(TOOL_DISPLAY_COPY, toolName);
}

export function getAgentToolDisplayCopy(toolName: string): AgentToolDisplayCopy {
  const known = TOOL_DISPLAY_COPY[toolName as keyof typeof TOOL_DISPLAY_COPY];
  if (known) return known;
  const category = inferToolCategory(toolName);
  return { action: FALLBACK_ACTIONS[category], category };
}

function completedAction(action: string): string {
  const replacements: Array<[string, string]> = [
    ["读取", "已读取"],
    ["查看", "已查看"],
    ["确认", "已确认"],
    ["检查", "已检查"],
    ["查找", "已查找"],
    ["预览", "已预览"],
    ["应用", "已应用"],
    ["提交", "已提交"],
    ["执行", "已执行"],
    ["启动", "已启动"],
    ["结束", "已结束"],
    ["建立", "已建立"],
    ["领取", "已领取"],
    ["完成", "已完成"],
    ["准备", "已准备"],
    ["优化", "已优化"],
    ["精简", "已精简"],
    ["调整", "已调整"],
    ["导出", "已导出"],
    ["添加", "已添加"],
    ["保存", "已保存"],
    ["编辑", "已编辑"],
    ["同步", "已同步"],
    ["选择", "已选择"],
    ["生成", "已生成"],
    ["分配", "已分配"],
    ["改写", "已改写"],
    ["处理", "已处理"],
    ["恢复", "已恢复"],
  ];
  for (const [prefix, replacement] of replacements) {
    if (action.startsWith(prefix)) return `${replacement}${action.slice(prefix.length)}`;
  }
  return `${action}已完成`;
}

export function formatAgentToolActivity(toolName: string, state: AgentToolActivityState): string {
  const { action } = getAgentToolDisplayCopy(toolName);
  switch (state) {
    case "running":
      return `正在${action}…`;
    case "completed":
      return completedAction(action);
    case "failed":
      return `${action}未完成`;
    case "denied":
      return `${action}已取消`;
    case "invalid-input":
      // Not always schema errors — often a missing prerequisite (e.g. BeginPptCapability).
      return `${action}暂未执行：参数或前置条件不满足`;
  }
}

function formatBackgroundTaskLabel(label: string): string {
  const toolMatch = label.match(/^([A-Za-z][\w-]*)(?::\s*.*)?$/);
  if (toolMatch) return getAgentToolDisplayCopy(toolMatch[1]!).action;
  return label;
}

/** Normalize runtime diagnostics at the final display boundary. */
export function formatAgentProgressMessage(message: string): string | null {
  const value = message.trim();
  if (!value) return null;

  if (/Call BeginPptCapability before using Presentation/i.test(value)) {
    return "需先声明演示文稿任务（BeginPptCapability），再解析模板或写入作者文件";
  }

  if (/^L1\s+snip_compact\b/i.test(value)) return "已整理较早的对话内容";
  if (/^L2\s+micro_compact\b/i.test(value)) return "已精简较早的运行记录";
  if (/^L3\s+tool_result_budget\b/i.test(value)) return "已整理较大的运行结果";
  if (/^Persisted oversized tool result\b/i.test(value)) return "已整理较大的运行结果";
  if (/^L4\s+compact_history\s+skipped\b/i.test(value)) return null;
  if (/^L4\s+compact_history\b/i.test(value)) return "已总结较早的对话内容";
  if (/^L\d+\s+[a-z][\w-]*\s*:/i.test(value)) return "已整理较早的会话记录";

  if (/max_tokens|输出被截断|输出截断后启用续写/i.test(value)) {
    return "回复内容较长，正在继续生成…";
  }
  if (/上下文超限|prompt (?:is )?too long|context length/i.test(value)) {
    return "对话内容较多，整理后正在继续…";
  }
  if (/连续过载|备用模型|Retry-After|指数退避|临时故障/i.test(value)) {
    return "服务暂时繁忙，正在重试…";
  }

  const backgroundMatch = value.match(/^后台任务\s+\S+\s+已启动[：:]\s*(.+)$/);
  if (backgroundMatch) {
    return `已开始后台处理：${formatBackgroundTaskLabel(backgroundMatch[1]!)}`;
  }

  return value;
}

export function formatAgentToolApprovalDetail(detail: string): string {
  const normalized = detail.trim().replace(/^path:\s*/gim, "位置：");
  if (/^[[{]/.test(normalized)) return "此操作包含需要确认的高级设置";
  return normalized;
}

export function formatPublicErrorMessage(
  error: unknown,
  fallback = "处理时遇到问题，请稍后重试。",
): string {
  const value = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
  if (!value) return fallback;
  if (/aborted|中断|取消/i.test(value)) return "操作已取消。";
  if (/api[_ -]?key|authentication|unauthorized|\b401\b/i.test(value)) {
    return "模型服务尚未正确配置，请在设置中检查连接信息。";
  }
  if (/rate.?limit|overload|too many requests|\b429\b|timeout|timed out|econn/i.test(value)) {
    return "服务暂时繁忙，请稍后重试。";
  }
  if (/\b(?:enoent|file not found|path not found|no such file)\b/i.test(value)) {
    return "未找到所需文件，请检查项目目录后重试。";
  }
  if (/\b(?:eacces|eperm|permission denied)\b/i.test(value)) {
    return "当前操作缺少必要权限，请检查项目目录权限。";
  }
  if (
    /zod|schema|validation|json|tool[_ -]?use|modeloutputerror|unrecognized key|invalid input: expected|校验失败|stack|\bat\s+\S+\s*\(/i.test(
      value,
    )
  ) {
    return fallback;
  }
  if (/^[\x00-\x7F]+$/.test(value)) return fallback;
  return value.length > 180 ? `${value.slice(0, 177)}…` : value;
}
