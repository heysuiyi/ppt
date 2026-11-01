import type {
  PptCapability,
  PptJobStatus,
  PptProposalStatus,
  PptStage,
} from "@shared/presentation-lifecycle";

export const JOB_STATUS_LABELS: Record<PptJobStatus, string> = {
  running: "进行中",
  waiting_user: "等待用户",
  waiting_approval: "等待审批",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

export const PROPOSAL_STATUS_LABELS: Record<PptProposalStatus, string> = {
  waiting_approval: "等待审批",
  applied: "已应用",
  rejected: "已拒绝",
  superseded: "已失效",
};

export const STAGE_LABELS: Record<PptStage, string> = {
  intent: "意图",
  design_spec: "设计规范",
  page_plan: "逐页规划",
  page_svg: "页面 SVG",
  preview: "预览",
  candidate: "候选稿",
  quality: "质量检查",
  proposal: "提案",
  presentation: "演示文稿",
  export: "导出",
};

export const CAPABILITY_LABELS: Record<PptCapability, string> = {
  create: "新建",
  edit: "编辑",
  restyle: "重做风格",
  review: "审查",
  export: "导出",
};
