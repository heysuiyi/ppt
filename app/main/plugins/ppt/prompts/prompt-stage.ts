import type { Presentation } from "@shared/presentation";

import type { WorkspaceArtifacts } from "../presentation/workspace-artifacts";

/**
 * Merged prompt stages (6). Replaces the former 9-stage machine:
 *
 * | New       | Former |
 * |-----------|--------|
 * | discover  | routing + planning |
 * | author    | integrated content + visual authoring |
 * | design    | autonomous layout-design |
 * | style     | layout-exec + review |
 * | edit      | light-edit |
 * | export    | export |
 */
export const PROMPT_STAGES = ["discover", "author", "design", "style", "edit", "export"] as const;

export type PromptStage = (typeof PROMPT_STAGES)[number];

/** Former 9-stage identifiers → merged stage (for tests, stageHint, old SKILL frontmatter). */
export const LEGACY_PROMPT_STAGE_MAP: Record<string, PromptStage> = {
  routing: "discover",
  planning: "discover",
  content: "author",
  "layout-choice": "design",
  "layout-design": "design",
  "layout-exec": "style",
  review: "style",
  "light-edit": "edit",
};

export function normalizePromptStage(stage: string): PromptStage {
  if ((PROMPT_STAGES as readonly string[]).includes(stage)) {
    return stage as PromptStage;
  }
  const legacy = LEGACY_PROMPT_STAGE_MAP[stage];
  if (legacy) return legacy;
  throw new Error(`Unknown prompt stage: ${stage}`);
}

export interface PromptStageResolveInput {
  request: string;
  presentation: Presentation;
  artifacts: WorkspaceArtifacts;
  messageHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Explicit override from harness (e.g. tests). Accepts legacy stage names. */
  stageHint?: string;
}

/**
 * Derive an advisory capability stage from durable facts.
 *
 * Natural-language intent is deliberately not classified with keyword/regex
 * routing here. The model sees the actual request and the complete tool set,
 * while this hint only ranks skills and describes the current artifact shape.
 */
export function resolvePromptStage(input: PromptStageResolveInput): PromptStage {
  if (input.stageHint) return normalizePromptStage(input.stageHint);

  const slideCount = input.presentation.slides?.length ?? 0;
  const hasUnstyledSlides = input.presentation.slides.some(
    (slide) => slide.visualSource?.kind !== "svg",
  );

  if (hasUnstyledSlides) {
    return "design";
  }

  if (input.artifacts.pageSvg) {
    return slideCount > 0 ? "edit" : "style";
  }

  if (
    input.artifacts.pagePlan ||
    input.artifacts.designSpec ||
    input.artifacts.outline ||
    input.artifacts.brief ||
    input.artifacts.research
  ) {
    return "author";
  }

  return slideCount > 0 ? "edit" : "discover";
}

export function describePromptStage(stage: PromptStage): string {
  const labels: Record<PromptStage, string> = {
    discover: "确认演示目标与 SVG-native 创作路径",
    author: "设计规范、逐页规划与页面 SVG 创作",
    design: "为已有页面补全设计与视觉来源",
    style: "SVG 页面预览、质量检查与提交",
    edit: "轻量单页修改",
    export: "导出交付",
  };
  return labels[stage];
}
