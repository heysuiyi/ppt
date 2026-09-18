import {
  type CollabMode,
  type Deliverable,
  type DifficultyDims,
  type DifficultySummary,
  type Level,
  type Operation,
  type PptTaskPlan,
  type Route,
  type SkillTiers,
  type TaskAssessment,
  type TaskFacts,
} from "./ppt-task-types";

const CORE_DIMS = ["workload", "factBurden", "visual", "coupling"] as const;

export function summarizeDifficulty(dims: DifficultyDims): DifficultySummary {
  const levels = CORE_DIMS.map((key) => dims[key] ?? "unknown");
  if (levels.some((level) => level === "high")) return "complex";
  if (levels.every((level) => level === "low")) return "simple";
  if (levels.some((level) => level === "unknown")) return "undetermined";
  return "standard";
}

function isHigh(level: Level | undefined): boolean {
  return level === "high";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Authoring skill sets by terminal operation. Table, not a step DSL. */
const BASE_SKILLS: Record<Operation, { now: string[]; later: string[] }> = {
  answer: { now: [], later: [] },
  content: { now: ["ppt-outline"], later: [] },
  create: { now: ["ppt-workflow", "ppt-design"], later: ["ppt-build"] },
  edit: { now: ["ppt-edit"], later: [] },
  restyle: { now: ["ppt-beautify"], later: ["ppt-review"] },
  review: { now: ["ppt-review"], later: [] },
  export: { now: ["ppt-export"], later: [] },
};

/**
 * Compose ≤3 meaningful routes from assessment + runtime facts.
 * Does not invent keyword routing; NL flags come from the model (wantsFix/Export/Redesign).
 */
export function composePptTaskPlan(input: {
  assessment: TaskAssessment;
  facts: TaskFacts;
  previousPlan?: PptTaskPlan;
  selectedCandidateId?: string | null;
  selectionReason?: string;
}): PptTaskPlan {
  const { assessment: a, facts: f } = input;
  const difficulty = summarizeDifficulty(a.dims);
  const routes: Route[] = [];
  const authoring: Operation[] = ["create", "edit", "restyle"];
  const wantsExport = a.wantsExport || a.deliverable === "pptx";

  // 1) Terminal-only paths that never enter the SVG authoring chain.
  if (a.operation === "answer" || a.deliverable === "answer") {
    routes.push(route("answer", [], [], "solo", "ready", "普通问答：直接回答，不创建 capability。"));
  } else if (a.deliverable === "content") {
    const now = baseNow("content", a, f);
    routes.push(
      route(
        "content",
        now,
        [],
        "solo",
        openBlockers(a).length ? "needs-input" : "ready",
        "只交付内容产物，不生成 SVG。",
        openBlockers(a),
      ),
    );
  } else if (a.operation === "export") {
    const now = baseNow("export", a, f);
    const later = wantsExportCheck(a, f) ? ["ppt-review"] : [];
    routes.push(
      route(
        "export",
        unique([...now, ...later]),
        [],
        "solo",
        "ready",
        "交付终点为导出：核对当前应用版本后走 UI，不进入改稿。",
      ),
    );
  } else if (a.operation === "review" || a.deliverable === "review-report") {
    routes.push(...reviewRoutes(a, f));
  } else if (authoring.includes(a.operation)) {
    routes.push(...authoringRoutes(a, f, a.operation, difficulty, wantsExport));
  } else {
    // Fallback: treat as create.
    routes.push(...authoringRoutes(a, f, "create", difficulty, wantsExport));
  }

  const { recommendedId, selectedId, reason } = pickRoutes(routes, a, input);
  return {
    revision: (input.previousPlan?.revision ?? 0) + 1,
    queryId: f.queryId,
    operation: a.operation,
    deliverable: a.deliverable,
    difficulty,
    routes,
    recommendedId,
    selectedId,
    reason,
  };
}

function route(
  id: string,
  now: string[],
  later: string[],
  collab: CollabMode,
  availability: Route["availability"],
  why: string,
  blockers: string[] = [],
): Route {
  return { id, now: unique(now), later: unique(later.filter((s) => !now.includes(s))), collab, availability, why, blockers };
}

function baseNow(
  op: Operation,
  a: TaskAssessment,
  f: TaskFacts,
): string[] {
  const base = [...BASE_SKILLS[op].now];
  if (op === "create") {
    if (!f.hasDesign || a.wantsRedesign) base.push("ppt-design");
    if (!f.hasPlan || isHigh(a.dims.coupling)) base.push("ppt-design-layout");
  }
  if (op === "content" && isHigh(a.dims.uncertainty)) base.unshift("ppt-brief");
  return unique(base);
}

function authoringLater(
  a: TaskAssessment,
  f: TaskFacts,
  op: Operation,
): { later: string[]; notes: string[] } {
  const later = [...BASE_SKILLS[op].later];
  const notes: string[] = [];
  if (op === "create" && f.hasPlan && !isHigh(a.dims.coupling)) {
    later.push("ppt-design-layout");
  }
  if (isHigh(a.dims.factBurden)) {
    if (op === "create") later.push("ppt-research", "ppt-review");
    else later.push("ppt-review");
    notes.push("来源与口径核对");
  }
  if (isHigh(a.dims.visual)) {
    later.push("ppt-review");
    notes.push("复杂页尽早预览");
  }
  if (isHigh(a.dims.uncertainty) && op === "create") later.push("ppt-brief");
  return { later: unique(later), notes };
}

function openBlockers(a: TaskAssessment): string[] {
  return (a.openQuestions ?? [])
    .filter((q) => q.resolveBy === "user")
    .map((q) => q.question);
}

function wantsExportCheck(a: TaskAssessment, f: TaskFacts): boolean {
  return a.wantsExport || f.hasStaleEvidence === true || isHigh(a.dims.factBurden);
}

function authoringRoutes(
  a: TaskAssessment,
  f: TaskFacts,
  op: Operation,
  difficulty: DifficultySummary,
  wantsExport: boolean,
): Route[] {
  const now = baseNow(op, a, f);
  const { later, notes } = authoringLater(a, f, op);
  const blockers = openBlockers(a);
  const whyBase =
    op === "create"
      ? `${difficulty} 创建：workflow/design（按缺口）→ build → 预览 → 提交`
      : op === "edit"
        ? "局部编辑：ppt-edit → 预览 → 提交"
        : "视觉优化：ppt-beautify → 检查 → 提交";
  const why = notes.length ? `${whyBase}；${notes.join("、")}` : whyBase;

  const mainId = wantsExport ? `${op}+export` : op;
  const mainLater = wantsExport ? unique([...later, "ppt-export"]) : later;
  const mainWhy = wantsExport
    ? `${why}；先完成作者链并应用，再在 UI 导出 pptx`
    : why;

  const routes: Route[] = [
    route(
      mainId,
      now,
      mainLater,
      "solo",
      blockers.length ? "needs-input" : "ready",
      mainWhy,
      blockers,
    ),
  ];

  if (a.collab === "required") {
    if (f.canDelegate) {
      routes.push(
        route(
          `${mainId}+assist`,
          now,
          mainLater,
          "assist",
          blockers.length ? "needs-input" : "ready",
          `${mainWhy}；Lead 作者/提交，teammate 独立核对（需委派契约）`,
          blockers,
        ),
      );
    } else {
      routes.push(
        route(
          `${mainId}+assist`,
          now,
          mainLater,
          "blocked",
          "unsupported",
          `${mainWhy}；用户要求多 Agent，但 teammate 工具不可用`,
          ["SpawnTeammate/SendTeammateMessage 不可用"],
        ),
      );
    }
  } else if ((a.collab === "allowed" || a.collab === "unspecified") && f.canDelegate && difficulty === "complex") {
    routes.push(
      route(
        `${mainId}+assist`,
        now,
        mainLater,
        "assist",
        "ready",
        `${mainWhy}；复杂任务可选独立核对`,
        blockers,
      ),
    );
  }

  return routes;
}

function reviewRoutes(a: TaskAssessment, f: TaskFacts): Route[] {
  const routes: Route[] = [];
  if (a.wantsFix) {
    // Executable same-query fix: authoring capability + review checklist (not review ACL).
    const op: Operation = a.deliverable === "pptx" ? "edit" : "edit";
    const base = authoringRoutes(
      {
        ...a,
        operation: op,
        deliverable: "deck",
        wantsExport: a.wantsExport || a.deliverable === "pptx",
      },
      f,
      op,
      summarizeDifficulty(a.dims),
      a.wantsExport || a.deliverable === "pptx",
    );
    // Shift skills: inspect needs ppt-review now.
    routes.push(
      ...base.map((r) => ({
        ...r,
        id: r.id === op || r.id === `${op}+export` ? `author-with-inspect${r.id.endsWith("+export") ? "+export" : ""}` : r.id,
        now: unique(["ppt-review", ...r.now]),
        why: `${r.why}；inspect 套用 ppt-review 检查表后修复提交（edit/restyle capability）`,
      })),
    );
    routes.push(
      route(
        "review-report",
        ["ppt-review"],
        ["ppt-edit", "ppt-beautify"],
        "solo",
        "needs-input",
        "先 review 出 QualityReport；改稿须在新的 Query 开 edit/restyle（同 Query 不能切 capability）",
        ["跨 Query 交接"],
      ),
    );
  } else {
    routes.push(
      route(
        "review-report",
        ["ppt-review"],
        [],
        "solo",
        "ready",
        "只审查不修改：读取当前源与真实渲染，提交 QualityReport。",
      ),
    );
  }

  if (a.collab === "required") {
    const last = routes[0]!;
    if (f.canDelegate) {
      routes.push({ ...last, id: `${last.id}+assist`, collab: "assist", why: `${last.why}；teammate 独立核对` });
    } else {
      routes.push({
        ...last,
        id: `${last.id}+assist`,
        collab: "blocked",
        availability: "unsupported",
        why: `${last.why}；多 Agent 工具不可用`,
        blockers: ["teammate 工具不可用"],
      });
    }
  }
  return routes;
}

function pickRoutes(
  routes: Route[],
  a: TaskAssessment,
  input: { selectedCandidateId?: string | null; selectionReason?: string },
): { recommendedId: string | null; selectedId: string | null; reason: string } {
  const executable = routes.filter((r) => r.availability !== "unsupported");
  const ready = executable.filter((r) => r.availability === "ready");
  const pool = ready.length ? ready : executable;

  let recommendedId: string | null = null;
  if (a.collab === "required") {
    const assist = pool.find((r) => r.collab === "assist");
    recommendedId =
      assist?.id ??
      routes.find((r) => r.collab !== "solo")?.id ??
      pool[0]?.id ??
      null;
  } else if (a.collab === "forbidden") {
    recommendedId = pool.find((r) => r.collab === "solo")?.id ?? pool[0]?.id ?? null;
  } else {
    recommendedId = pool.find((r) => r.collab === "solo")?.id ?? pool[0]?.id ?? null;
  }

  const recommended = routes.find((r) => r.id === recommendedId);
  let reason =
    input.selectionReason ??
    (recommended
      ? a.collab === "required"
        ? `用户要求多 Agent：优先协作路径。${recommended.why}`
        : `默认推荐最小充分路径：${recommended.why}`
      : "没有可推荐路径");

  let selectedId = input.selectedCandidateId ?? recommendedId ?? null;
  if (selectedId) {
    const selected = routes.find((r) => r.id === selectedId);
    if (!selected) {
      selectedId = recommendedId;
      reason = `候选 ${input.selectedCandidateId} 不存在，已回退推荐。${recommended?.why ?? ""}`;
    } else if (selected.availability === "unsupported") {
      selectedId = recommendedId;
      reason = `候选 ${selected.id} 不可执行（${selected.blockers.join("；") || "unsupported"}），已回退推荐。${
        recommended?.why ?? ""
      }`;
    } else if (a.collab === "required" && selected.collab === "solo") {
      selectedId = recommendedId;
      reason = `用户要求多 Agent：solo 不满足要求，已改选协作/阻断候选。${recommended?.why ?? ""}`;
    }
  }

  return { recommendedId, selectedId, reason };
}

export function resolveActiveRoute(plan: PptTaskPlan): Route | undefined {
  const selected = plan.routes.find((r) => r.id === plan.selectedId);
  if (selected && selected.availability !== "unsupported") return selected;
  return (
    plan.routes.find((r) => r.availability === "ready") ??
    plan.routes.find((r) => r.availability !== "unsupported") ??
    plan.routes.find((r) => r.collab !== "solo") ??
    plan.routes[0]
  );
}

export function resolveSkillTiers(plan: PptTaskPlan): SkillTiers {
  const route = resolveActiveRoute(plan);
  return { now: route?.now ?? [], later: route?.later ?? [] };
}

export function skillRecommendationForPlan(
  plan: PptTaskPlan | undefined,
  skillName: string,
): "now" | "later" | null {
  if (!plan) return null;
  const tiers = resolveSkillTiers(plan);
  if (tiers.now.includes(skillName)) return "now";
  if (tiers.later.includes(skillName)) return "later";
  return null;
}

export function formatPptTaskPlanProjection(plan: PptTaskPlan): string {
  const route = resolveActiveRoute(plan);
  const tiers = resolveSkillTiers(plan);
  return [
    `意图：${plan.operation} → ${plan.deliverable}`,
    `难度：${plan.difficulty}`,
    `推荐：${route?.why ?? "无"}`,
    `现在需要：${tiers.now.join("、") || "（无）"}`,
    `稍后：${tiers.later.join("、") || "（无）"}`,
    `协作：${route?.collab ?? "-"}${route?.availability && route.availability !== "ready" ? `（${route.availability}）` : ""}`,
    `计划：revision=${plan.revision}；recommended=${plan.recommendedId ?? "null"}；selected=${plan.selectedId ?? "null"}`,
    route?.blockers.length ? `阻断：${route.blockers.join("；")}` : "",
    "注意：路径是能力组合建议；锁文件、预览与提交校验仍然有效。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function capabilityGuidanceFromPlan(plan: PptTaskPlan | undefined): string | null {
  if (!plan) return null;
  const route = resolveActiveRoute(plan);
  const tiers = resolveSkillTiers(plan);
  const op = plan.operation;
  const nextStep =
    op === "create"
      ? "下一步必须先 BeginPptCapability(create)，再 ResolveProjectTemplate / 写锁文件；不要在 Begin 之前调用 Presentation 作者工具。"
      : op === "edit"
        ? "下一步先 BeginPptCapability(edit)，再改作者 SVG。"
        : op === "restyle"
          ? "下一步先 BeginPptCapability(restyle)，再改视觉。"
          : op === "review"
            ? "下一步先 BeginPptCapability(review)；review 只提交 QualityReport，不写 SVG、不调用 SubmitSvgDeck。"
            : op === "export"
              ? "导出走应用 UI，不调用 BeginPptCapability 的 export 枚举。"
              : "";
  return [
    `任务路径：${route?.why ?? "-"}`,
    `难度：${plan.difficulty}`,
    `现在需要：${tiers.now.join("、") || "（无）"}`,
    `稍后：${tiers.later.join("、") || "（无）"}`,
    `协作：${route?.collab ?? "-"}${route?.availability === "unsupported" ? "（当前不可执行）" : ""}`,
    nextStep,
    route?.blockers.length ? `阻断：${route.blockers.join("；")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
