import { type PptJobProjection, pptJobProjectionSchema } from "@shared/presentation-lifecycle";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";
import { pptReviewReportSchema } from "../../../presentation-lifecycle/presentation-lifecycle-orchestrator";
import { requirePptCapability } from "../context";

/**
 * Commits a structured review against the current immutable Presentation
 * revision. Reviewing is observational: it never mutates the Presentation.
 */
export const submitPptReviewTool: ToolDefinition<typeof pptReviewReportSchema, PptJobProjection> = {
  name: "SubmitPptReview",
  description:
    "提交当前演示文稿的结构化审查结果。必须先用 BeginPptCapability 声明 review；" +
    "报告会绑定当前非过期 PresentationRevision，并完成本次审查任务，但不会修改幻灯片。",
  category: "core",
  loadPolicy: "core",
  inputSchema: pptReviewReportSchema,
  outputSchema: pptJobProjectionSchema,
  validateContext: requirePptCapability(["review"]),
  isEnabled: (context) => Boolean(context.presentationLifecycle),
  risk: "low",
  execute: async (report, context) => {
    if (!context.presentationLifecycle) {
      throw new Error("Presentation lifecycle is unavailable in this runtime.");
    }
    return context.presentationLifecycle.submitReview(report);
  },
};
