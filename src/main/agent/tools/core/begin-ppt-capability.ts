import { type PptJobProjection, pptJobProjectionSchema } from "@shared/presentation-lifecycle";
import { z } from "zod";
import { capabilityGuidanceFromPlan } from "../../runtime/ppt-task/ppt-task-composer";
import { probeWorkspaceArtifacts } from "../../runtime/presentation/workspace-artifacts";
import type { ToolDefinition } from "../tool-definition";
import { formatSvgDeckLockBootstrapGuidance } from "./svg-deck-locks";

export const beginPptCapabilitySchema = z
  .object({
    capability: z.enum(["create", "edit", "restyle", "review"]),
    instruction: z.string().trim().min(1).max(20_000).optional(),
  })
  .strict();

/**
 * Explicitly binds a generic Query to the long-lived Presentation Job.
 * Queries that only answer questions never call this tool and remain Query-only.
 */
export const beginPptCapabilityTool: ToolDefinition<
  typeof beginPptCapabilitySchema,
  PptJobProjection
> = {
  name: "BeginPptCapability",
  description:
    "开始一项可持久化的 PPT 业务请求。进行新建、编辑、重做风格或结构化审查前必须先调用一次；" +
    "普通问答不要调用；导出由应用内部创建 capability。后续 Presentation 工具只接受同一 Query 已声明的 capability。" +
    "create 时会返回 SVG deck 锁文件作者指引（design-spec / page-plan）；若已登记任务评估，将优先返回所选路径的简短指引。",
  category: "core",
  loadPolicy: "core",
  inputSchema: beginPptCapabilitySchema,
  outputSchema: pptJobProjectionSchema,
  isEnabled: (context) => Boolean(context.presentationLifecycle),
  risk: "low",
  mapResultToModelContent: async (result, context) => {
    const base = JSON.stringify(result);
    const planGuidance = capabilityGuidanceFromPlan(context.pptTaskSession?.plan);
    const fragments: string[] = [];
    if (planGuidance) fragments.push(planGuidance);

    const capabilityBoundary =
      result.capability === "review"
        ? "Capability 边界：review 的交付终点是 SubmitPptReview QualityReport。" +
          "SubmitSvgDeck 仅接受 create/edit/restyle；review Query 内不得写作者 SVG 或提交 deck。" +
          "需要改稿时先出报告，再新开 BeginPptCapability(edit/restyle)。"
        : result.capability === "create"
          ? "Capability 边界：create 走 SVG 作者链；SubmitSvgDeck 需要有效锁文件与当前预览凭据。"
          : `Capability 边界：${result.capability} 下按已声明范围修改；提交仍走 SubmitSvgDeck（create/edit/restyle）。`;
    fragments.push(capabilityBoundary);

    if (result.capability !== "create") {
      return `${base}\n\n${fragments.join("\n")}`;
    }
    const artifacts = context.workspaceRoot
      ? await probeWorkspaceArtifacts(context.workspaceRoot)
      : undefined;
    const locksReady = Boolean(artifacts?.designSpec && artifacts.pagePlan);
    if (!locksReady) {
      fragments.push(formatSvgDeckLockBootstrapGuidance());
    }
    return `${base}\n\n${fragments.join("\n\n")}`;
  },
  execute: async (args, context) => {
    if (!context.presentationLifecycle) {
      throw new Error("Presentation lifecycle is unavailable in this runtime.");
    }
    context.presentationLifecycle.beginCapability({
      capability: args.capability,
      instruction: args.instruction ?? context.request ?? "",
    });
    const active = context.presentationLifecycle.requireActiveCapability([args.capability]);
    if (context.workspaceRoot) {
      await context.presentationLifecycle.observeArtifactChanges({
        workspaceRoot: context.workspaceRoot,
        source: "capability_probe",
      });
      return context.presentationLifecycle.requireActiveCapability([args.capability]);
    }
    return active;
  },
};
