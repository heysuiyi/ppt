/**
 * Minimal PPT task-plan model (advisory).
 * Intent → deliverable terminal; difficulty dims → skill measures; facts → reuse/gaps;
 * collab preference → solo vs assist vs blocked. Not business completion or ACL.
 */

export type Level = "low" | "medium" | "high" | "unknown";

export type Operation =
  | "answer"
  | "content"
  | "create"
  | "edit"
  | "restyle"
  | "review"
  | "export";

export type Deliverable = "answer" | "content" | "deck" | "review-report" | "pptx";

export type CollabPreference = "required" | "allowed" | "forbidden" | "unspecified";

export type CollabMode = "solo" | "assist" | "blocked";

export type RouteAvailability = "ready" | "needs-input" | "unsupported";

export type DifficultySummary = "simple" | "standard" | "complex" | "undetermined";

export type OpenQuestionResolveBy = "read" | "tool" | "user";

export interface DifficultyDims {
  workload: Level;
  factBurden: Level;
  visual: Level;
  coupling: Level;
  uncertainty: Level;
}

export interface OpenQuestion {
  question: string;
  resolveBy: OpenQuestionResolveBy;
}

/** Model-supplied assessment. Every field feeds composition. */
export interface TaskAssessment {
  operation: Operation;
  deliverable: Deliverable;
  dims: DifficultyDims;
  collab: CollabPreference;
  /** Model interprets NL; composer does not regex request text. */
  wantsFix?: boolean;
  wantsExport?: boolean;
  wantsRedesign?: boolean;
  openQuestions: OpenQuestion[];
}

/** Runtime-owned facts. Not overridable by model input. */
export interface TaskFacts {
  queryId: string;
  inputRevision: string;
  hasDesign: boolean;
  hasPlan: boolean;
  hasPages: boolean;
  canDelegate: boolean;
  hasStaleEvidence?: boolean;
}

export interface Route {
  id: string;
  now: string[];
  later: string[];
  collab: CollabMode;
  availability: RouteAvailability;
  why: string;
  blockers: string[];
}

export interface PptTaskPlan {
  revision: number;
  queryId: string;
  operation: Operation;
  deliverable: Deliverable;
  difficulty: DifficultySummary;
  routes: Route[];
  recommendedId: string | null;
  selectedId: string | null;
  reason: string;
}

export interface SkillTiers {
  now: string[];
  later: string[];
}

export function emptyDims(level: Level = "unknown"): DifficultyDims {
  return {
    workload: level,
    factBurden: level,
    visual: level,
    coupling: level,
    uncertainty: level,
  };
}
