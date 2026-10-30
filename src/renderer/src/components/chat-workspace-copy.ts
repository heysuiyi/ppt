import type { Presentation } from "@shared/presentation";

export interface ChatPromptTemplate {
  command: string;
  description: string;
}

export const CHAT_WORKSPACE_COPY_ZH_CN = {
  newChatTitle: "AI 新建会话",
  currentChatTitle: "当前对话",
  taskFocusAria: "任务焦点",
  mainTaskAttentionAria: "主任务有新动态",
  approvalRequired: "需要授权",
  approvalJumpTitle: "跳转处理，完成后返回当前视图",
  approvalAria: (reason: string) => `需要授权：${reason}`,
  openPreview: "打开右侧预览",
  copied: "已复制到剪贴板",
  copyFailed: "复制失败，请重试",
  copyContent: "复制内容",
  editAndRerun: "编辑指令并重新运行",
  returnToLatest: "回到最新",
  newContentReturnToLatest: "有新动态 · 回到最新",
  promptTemplateAria: "提示词模板",
  promptTemplateHeader: "提示词模板（填入输入框，不会直接执行）",
  teammateComposerNote: "当前正在查看任务详情；这里发送的新指令仍会交给 PPT Agent。",
  editor: {
    groupAria: "编辑已发送的消息",
    title: "编辑消息",
    hint: "提交后将从这里重新运行",
    textareaAria: "修改消息内容",
    shortcut: "Esc 取消 · Ctrl/⌘ Enter 提交",
    cancel: "取消",
    submit: "提交修改",
  },
  templates: {
    unifyStyle: {
      command: "将整套演示统一为商务蓝视觉风格",
      description: "提示：统一设计风格",
    },
    appendSlide: {
      command: "在末尾新增一页：",
      description: "提示：追加页面",
    },
    deleteSlide: (pageNumber: number) => ({
      command: `删除第 ${pageNumber} 页`,
      description: "提示：删除指定页",
    }),
    polishCurrentSlide: {
      command: "润色当前页的文案，保持论点不变",
      description: "提示：局部润色",
    },
  },
  suggestions: [
    "做一份 8 页的产品发布会演示，面向企业客户，语气专业且有冲击力",
    "帮我准备季度业务汇报 PPT，包含进展、风险和下一步计划",
    "生成一套面向新员工的入职培训课件，结构清晰、便于讲解",
    "写一份产品方案介绍，突出问题、方案价值与落地路径",
  ],
} as const;

export function getChatPromptTemplates(
  presentation?: Presentation,
  selectedSlideId?: string,
): ChatPromptTemplate[] {
  const templates: ChatPromptTemplate[] = [
    CHAT_WORKSPACE_COPY_ZH_CN.templates.unifyStyle,
    CHAT_WORKSPACE_COPY_ZH_CN.templates.appendSlide,
  ];
  const selectedIndex = selectedSlideId
    ? (presentation?.slides.findIndex((slide) => slide.id === selectedSlideId) ?? -1)
    : -1;
  if (selectedIndex >= 0) {
    templates.push(CHAT_WORKSPACE_COPY_ZH_CN.templates.deleteSlide(selectedIndex + 1));
  }
  templates.push(CHAT_WORKSPACE_COPY_ZH_CN.templates.polishCurrentSlide);
  return templates;
}
