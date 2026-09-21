import { createPptToolRegistry } from "@main/plugins/ppt/tools";
import { describe, expect, it } from "vitest";
import type { SkillCard } from "../src/main/agent/skills/skill-types";
import type { ToolContext } from "../src/main/agent/tools/tool-definition";
import {
  buildRuntimeContextSection,
  buildToolsSection,
} from "../src/main/plugins/ppt/prompts/prompt-sections";
import { rankSkillCatalogForStage } from "../src/main/plugins/ppt/prompts/skill-stage-policy";
import {
  capabilityGuidanceFromPlan,
  composePptTaskPlan,
  formatPptTaskPlanProjection,
  resolveActiveRoute,
  resolveSkillTiers,
  skillRecommendationForPlan,
  summarizeDifficulty,
} from "../src/main/plugins/ppt/task/ppt-task-composer";
import { deriveTaskFacts } from "../src/main/plugins/ppt/task/ppt-task-facts";
import {
  applyPptTaskAssessment,
  createPptTaskSession,
} from "../src/main/plugins/ppt/task/ppt-task-session";
import type {
  DifficultyDims,
  Level,
  PptTaskPlan,
  TaskAssessment,
  TaskFacts,
} from "../src/main/plugins/ppt/task/ppt-task-types";
import { emptyDims } from "../src/main/plugins/ppt/task/ppt-task-types";
import { setPptTaskAssessmentTool } from "../src/main/plugins/ppt/tools/set-ppt-task-assessment";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

function dims(overrides: Partial<DifficultyDims> = {}): DifficultyDims {
  return { ...emptyDims("low"), ...overrides };
}

function assess(
  partial: Partial<TaskAssessment> & Pick<TaskAssessment, "operation" | "deliverable">,
): TaskAssessment {
  const { openQuestions, ...rest } = partial;
  return {
    dims: dims(),
    collab: "unspecified",
    ...rest,
    openQuestions: openQuestions ?? [],
  };
}

function facts(overrides: Partial<TaskFacts> = {}): TaskFacts {
  return {
    queryId: "q1",
    inputRevision: "r1",
    hasDesign: false,
    hasPlan: false,
    hasPages: false,
    canDelegate: false,
    ...overrides,
  };
}

function planOf(a: TaskAssessment, f: TaskFacts, selectedCandidateId?: string | null): PptTaskPlan {
  return composePptTaskPlan({ assessment: a, facts: f, selectedCandidateId });
}

describe("summarizeDifficulty", () => {
  it("maps dimensions to simple/complex/undetermined", () => {
    expect(summarizeDifficulty(dims())).toBe("simple");
    expect(summarizeDifficulty(dims({ factBurden: "high" }))).toBe("complex");
    expect(summarizeDifficulty(dims({ workload: "unknown" as Level }))).toBe("undetermined");
  });
});

describe("routes follow intent, facts, and collab", () => {
  it("routes edit / review / export differently on the same facts", () => {
    const f = facts({ hasDesign: true, hasPlan: true, hasPages: true });
    const edit = resolveSkillTiers(planOf(assess({ operation: "edit", deliverable: "deck" }), f));
    const review = resolveSkillTiers(
      planOf(assess({ operation: "review", deliverable: "review-report", wantsFix: false }), f),
    );
    const exp = resolveSkillTiers(planOf(assess({ operation: "export", deliverable: "pptx" }), f));
    expect(edit.now).toContain("ppt-edit");
    expect(review.now).toContain("ppt-review");
    expect(review.now).not.toContain("ppt-build");
    expect(exp.now).toContain("ppt-export");
  });

  it("adds fact vs visual measures on complex create", () => {
    const factDense = planOf(
      assess({
        operation: "create",
        deliverable: "deck",
        dims: dims({ factBurden: "high", coupling: "medium" }),
      }),
      facts(),
    );
    const visual = planOf(
      assess({
        operation: "create",
        deliverable: "deck",
        dims: dims({ visual: "high" }),
      }),
      facts(),
    );
    expect(factDense.difficulty).toBe("complex");
    expect(visual.difficulty).toBe("complex");
    expect(resolveSkillTiers(factDense).later).toContain("ppt-research");
    expect(resolveSkillTiers(visual).later).toContain("ppt-review");
    expect(resolveSkillTiers(visual).now).not.toContain("ppt-research");
  });

  it("keeps create authoring path when deliverable is pptx", () => {
    const plan = planOf(
      assess({ operation: "create", deliverable: "pptx" }),
      facts({ canDelegate: false }),
    );
    const route = resolveActiveRoute(plan);
    const skills = resolveSkillTiers(plan);
    expect(route?.id).toBe("create+export");
    expect(skills.now).toContain("ppt-workflow");
    expect(skills.later).toContain("ppt-build");
    expect(skills.later).toContain("ppt-export");
  });

  it("recommends assist path when collab is required and tools exist", () => {
    const plan = planOf(
      assess({ operation: "edit", deliverable: "deck", collab: "required" }),
      facts({ canDelegate: true, hasPages: true }),
    );
    const recommended = plan.routes.find((r) => r.id === plan.recommendedId);
    expect(recommended?.collab).toBe("assist");
    expect(plan.selectedId).toBe(plan.recommendedId);
  });

  it("blocks required multi-agent when tools are unavailable", () => {
    const plan = planOf(
      assess({ operation: "edit", deliverable: "deck", collab: "required" }),
      facts({ canDelegate: false }),
    );
    const recommended = plan.routes.find((r) => r.id === plan.recommendedId);
    expect(recommended?.collab).toBe("blocked");
    expect(recommended?.availability).toBe("unsupported");
  });

  it("rejects selecting unsupported route and solo under required multi", () => {
    const blocked = planOf(
      assess({ operation: "edit", deliverable: "deck", collab: "required" }),
      facts({ canDelegate: false }),
      "edit+assist",
    );
    // selected assist is blocked → fall back to recommended (also assist blocked)
    expect(blocked.routes.find((r) => r.id === blocked.selectedId)?.collab).not.toBe("solo");

    const withTools = planOf(
      assess({ operation: "edit", deliverable: "deck", collab: "required" }),
      facts({ canDelegate: true }),
      "edit",
    );
    const selected = withTools.routes.find((r) => r.id === withTools.selectedId);
    expect(selected?.collab).not.toBe("solo");
    expect(withTools.reason).toContain("多 Agent");
  });

  it("keeps content terminal without authoring skills", () => {
    const plan = planOf(
      assess({ operation: "create", deliverable: "content", dims: dims({ coupling: "high" }) }),
      facts(),
    );
    const skills = resolveSkillTiers(plan);
    expect(skills.now).toContain("ppt-outline");
    expect(skills.now).not.toContain("ppt-build");
  });

  it("uses author-with-inspect when wantsFix, not same-query review submit", () => {
    const plan = planOf(
      assess({ operation: "review", deliverable: "review-report", wantsFix: true }),
      facts(),
    );
    expect(plan.recommendedId).toContain("author-with-inspect");
    const skills = resolveSkillTiers(plan);
    expect(skills.now).toContain("ppt-review");
    expect(skills.now).toContain("ppt-edit");
  });

  it("keeps report-only when user does not want fixes", () => {
    const plan = planOf(
      assess({ operation: "review", deliverable: "review-report", wantsFix: false }),
      facts(),
    );
    expect(plan.recommendedId).toBe("review-report");
    const skills = resolveSkillTiers(plan);
    expect(skills.now).toContain("ppt-review");
    expect(skills.now).not.toContain("ppt-edit");
  });

  it("preserves needs-input for blocking open questions", () => {
    const plan = planOf(
      assess({
        operation: "create",
        deliverable: "deck",
        dims: dims({ workload: "unknown" as Level }),
        openQuestions: [{ question: "给谁看？", resolveBy: "user" }],
      }),
      facts(),
    );
    expect(plan.difficulty).toBe("undetermined");
    const route = resolveActiveRoute(plan);
    expect(route?.availability).toBe("needs-input");
  });
});

describe("prompt projection", () => {
  it("ranks path skills first and invalidates on revision change", () => {
    const plan = planOf(assess({ operation: "edit", deliverable: "deck" }), facts());
    const cards: SkillCard[] = [
      { name: "ppt-review", description: "review" },
      { name: "ppt-edit", description: "edit" },
      { name: "ppt-workflow", description: "workflow" },
    ];
    expect(rankSkillCatalogForStage(cards, "discover", undefined, plan)[0]?.name).toBe("ppt-edit");
    expect(skillRecommendationForPlan(plan, "ppt-edit")).toBe("now");
    const a = buildRuntimeContextSection({ stage: "discover", pptTaskPlan: plan });
    const b = buildRuntimeContextSection({
      stage: "discover",
      pptTaskPlan: { ...plan, revision: plan.revision + 1, selectedId: "nope" },
    });
    expect(a).not.toEqual(b);
    const tools = buildToolsSection({
      stage: "discover",
      enabledTools: [],
      skillCatalog: [{ name: "ppt-edit", description: "edit" }],
      pptTaskPlan: plan,
    });
    expect(tools).toContain("现在需要");
  });
});

describe("SetPptTaskAssessment tool", () => {
  it("composes routes, returns skill tiers and compact routes", async () => {
    const registry = createPptToolRegistry();
    const session = createPptTaskSession();
    const context = {
      presentation: createStarterPresentation(),
      request: "改标题，用多 Agent",
      selectedElementIds: [],
      discoverySession: { discoveredToolNames: new Set<string>() },
      registry,
      messageHistory: [],
      skillSession: { loadedSkillNames: new Set<string>() },
      pptTaskSession: session,
    } as unknown as ToolContext;

    const result = await setPptTaskAssessmentTool.execute(
      {
        assessment: assess({
          operation: "create",
          deliverable: "deck",
          collab: "unspecified",
        }),
      },
      context,
    );
    const mapped = setPptTaskAssessmentTool.mapResultToModelContent?.(result, context) ?? "";
    expect(mapped).toContain("BeginPptCapability");
    expect(mapped).toContain("capability");
    expect(mapped).toContain("create");
    expect(result.guidance ?? "").toContain("BeginPptCapability(create)");
    expect(result.skillTiers.now).toContain("ppt-workflow");
    expect(result.routes.length).toBeGreaterThan(0);
    expect(session.plan?.revision).toBe(1);
  });
});

describe("deriveTaskFacts", () => {
  it("maps workspace probes to four booleans without inventing current", () => {
    const derived = deriveTaskFacts({
      queryId: "q",
      inputRevision: "r",
      artifacts: {
        designSpec: true,
        templatePolicy: false,
        templatePack: false,
        pagePlan: false,
        pageSvg: false,
        assets: false,
        deck: false,
        exportHistory: false,
        brief: false,
        outline: false,
        research: false,
      },
    });
    expect(derived.hasDesign).toBe(true);
    expect(derived.hasPlan).toBe(false);
    expect(derived.hasPages).toBe(false);
  });
});
