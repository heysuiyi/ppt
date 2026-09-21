import { composePptTaskPlan } from "./ppt-task-composer";
import type { PptTaskPlan, TaskAssessment, TaskFacts } from "./ppt-task-types";

/** Per-thread advisory plan session. Mutated only by SetPptTaskAssessment. */
export interface PptTaskPlanSession {
  plan?: PptTaskPlan;
}

export function createPptTaskSession(input?: { plan?: PptTaskPlan }): PptTaskPlanSession {
  return { plan: input?.plan ? structuredClone(input.plan) : undefined };
}

export function applyPptTaskAssessment(
  session: PptTaskPlanSession,
  input: {
    assessment: TaskAssessment;
    facts: TaskFacts;
    selectedCandidateId?: string | null;
    selectionReason?: string;
  },
): PptTaskPlan {
  const plan = composePptTaskPlan({
    assessment: input.assessment,
    facts: input.facts,
    previousPlan: session.plan,
    selectedCandidateId: input.selectedCandidateId,
    selectionReason: input.selectionReason,
  });
  session.plan = plan;
  return plan;
}
