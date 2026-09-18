import { z } from "zod";
import { probeWorkspaceArtifactDetails } from "../../runtime/presentation/workspace-artifacts";
import {
  capabilityGuidanceFromPlan,
  formatPptTaskPlanProjection,
  resolveSkillTiers,
} from "../../runtime/ppt-task/ppt-task-composer";
import { deriveTaskFacts } from "../../runtime/ppt-task/ppt-task-facts";
import { setPptTaskAssessmentSchema } from "../../runtime/ppt-task/ppt-task-schema";
import { applyPptTaskAssessment } from "../../runtime/ppt-task/ppt-task-session";
import type { PptTaskPlan } from "../../runtime/ppt-task/ppt-task-types";
import type { ToolDefinition } from "../tool-definition";

const routeSchema = z.object({
  id: z.string(),
  now: z.array(z.string()),
  later: z.array(z.string()),
  collab: z.string(),
  availability: z.string(),
  why: z.string(),
  blockers: z.array(z.string()),
});

export const setPptTaskAssessmentResultSchema = z.object({
  plan: z.custom<PptTaskPlan>((value) => Boolean(value) && typeof value === "object"),
  summary: z.string(),
  skillTiers: z.object({ now: z.array(z.string()), later: z.array(z.string()) }),
  routes: z.array(routeSchema),
  recommendedCandidateId: z.string().nullable(),
  selectedCandidateId: z.string().nullable(),
  difficultySummary: z.string(),
  selectionReason: z.string(),
  guidance: z.string().optional(),
});

export type SetPptTaskAssessmentResult = z.infer<typeof setPptTaskAssessmentResultSchema> & {
  plan: PptTaskPlan;
};

function artifactsFromDetails(
  details: Awaited<ReturnType<typeof probeWorkspaceArtifactDetails>>,
): Parameters<typeof deriveTaskFacts>[0]["artifacts"] {
  return {
    designSpec: details.designSpec.verified,
    templatePolicy: details.templatePolicy.verified,
    templatePack: details.templatePack.verified,
    pagePlan: details.pagePlan.verified,
    pageSvg: details.pageSvg.verified,
    assets: details.assets.verified,
    deck: details.deck.verified,
    exportHistory: details.exportHistory.verified,
    brief: details.brief.verified,
    outline: details.outline.verified,
    research: details.research.verified,
  };
}

/**
 * Register a query-level task assessment. Advisory only: no capability, no writes, no ACL.
 * Runtime owns tool availability and artifact current/stale; model cannot override them.
 */
export const setPptTaskAssessmentTool: ToolDefinition<
  typeof setPptTaskAssessmentSchema,
  SetPptTaskAssessmentResult
> = {
  name: "SetPptTaskAssessment",
  description:
    "在实质 PPT 创作/修改前登记任务评估（意图、难度、协作、wantsFix/wantsExport），返回 ≤3 条候选路径与 Skill 分层。" +
    "不创建 capability、不授权修改、不写作者文件。按用户范围与已有资料评估，不因自行扩展内容判为 high。" +
    "首次调用省略 selectedCandidateId，使用返回的推荐；只有已取得候选且需改选时才传入真实 ID。协作偏好未说明时用 unspecified。",
  category: "core",
  loadPolicy: "core",
  inputSchema: setPptTaskAssessmentSchema,
  outputSchema: setPptTaskAssessmentResultSchema,
  examples: [
    '{"assessment":{"operation":"edit","deliverable":"deck","dims":{"workload":"low","factBurden":"low","visual":"low","coupling":"low","uncertainty":"low"},"collab":"required","openQuestions":[]}}',
  ],
  risk: "low",
  isEnabled: (context) => Boolean(context.pptTaskSession || context.registry),
  mapResultToModelContent: (result) =>
    JSON.stringify({
      difficultySummary: result.difficultySummary,
      recommendedCandidateId: result.recommendedCandidateId,
      selectedCandidateId: result.selectedCandidateId,
      selectionReason: result.selectionReason,
      skillTiers: result.skillTiers,
      routes: result.routes,
      summary: result.summary,
      guidance: result.guidance,
      nextStep:
        result.plan.operation === "create" || result.plan.operation === "edit" || result.plan.operation === "restyle"
          ? `BeginPptCapability({"capability":"${result.plan.operation}"}) 必须先于 ResolveProjectTemplate/WriteFile/SubmitSvgDeck。可与本工具结果后的下一轮同批发出 Begin；作者工具不能与本评估同批抢跑。`
          : result.plan.operation === "review"
            ? "BeginPptCapability(review) 后只读审查并 SubmitPptReview；不要在 review 下提交 SVG deck。"
            : "",
    }),
  execute: async (args, context) => {
    if (!context.pptTaskSession) {
      throw new Error("PPT task plan session is not available in this runtime.");
    }

    const availableTools = context.registry.getCoreTools(context).map((tool) => tool.name);
    const teammateCapabilities = context.teammateManager
      ? ["SpawnTeammate", "SendTeammateMessage"]
      : [];

    const artifactDetails = context.workspaceRoot
      ? await probeWorkspaceArtifactDetails(context.workspaceRoot)
      : undefined;

    let staleRefs: string[] = [];
    try {
      const projection = context.presentationLifecycle?.requireActiveCapability(undefined, {
        allowCompleted: true,
      });
      staleRefs = (projection?.staleArtifacts ?? []).map((item) => item.artifactId);
    } catch {
      // No active PptJob — workspace probe is the fact source.
    }

    const facts = deriveTaskFacts({
      queryId: context.presentationLifecycle?.queryId ?? "query-local",
      inputRevision: `request:${(context.request ?? "").length}:presentation:${context.presentation.revision}`,
      artifacts: artifactDetails ? artifactsFromDetails(artifactDetails) : undefined,
      artifactDetails,
      availableTools,
      teammateCapabilities,
      staleRefs,
    });

    const plan = applyPptTaskAssessment(context.pptTaskSession, {
      assessment: args.assessment,
      facts,
      selectedCandidateId: args.selectedCandidateId ?? null,
      selectionReason: args.selectionReason,
    });

    return {
      plan,
      summary: formatPptTaskPlanProjection(plan),
      skillTiers: resolveSkillTiers(plan),
      routes: plan.routes,
      recommendedCandidateId: plan.recommendedId,
      selectedCandidateId: plan.selectedId,
      difficultySummary: plan.difficulty,
      selectionReason: plan.reason,
      guidance: capabilityGuidanceFromPlan(plan) ?? undefined,
    };
  },
};
