import { isDeepStrictEqual } from "node:util";
import { ARGUMENT_MODES, designSystemV2Schema, READING_MODES, VISUAL_STYLES } from "@design-system";
import { getBuiltinTemplate } from "@shared/template-catalog";
import { resolvedTemplateSelectionSchema } from "@shared/template-protocol";
import { assertDesignSystemMatchesTemplate } from "@shared/template-resolver";
import { z } from "zod";
import { normalizeWorkspaceSvgPath } from "../../../deck/svg-page-loader";
import type { ToolContext } from "../tool-definition";
import { assertDesignSpecMatchesTemplatePolicy } from "./project-template-state";

export const SVG_DECK_DESIGN_SPEC_PATH = "design/design-spec.json";
export const SVG_DECK_PAGE_PLAN_PATH = "slides/page-plan.json";

const MAX_SVG_DECK_LOCK_BYTES = 1024 * 1024;

export const communicationContractSchema = z
  .object({
    audience: z.string().trim().min(1).max(1_000),
    objective: z.string().trim().min(1).max(1_000),
    desiredOutcome: z.string().trim().min(1).max(1_000),
    coreMessage: z.string().trim().min(1).max(2_000),
    deliveryContext: z.string().trim().min(1).max(1_000),
    afterUse: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const svgDeckDesignSpecSchema = z
  .object({
    version: z.literal(1),
    canvas: z
      .object({
        width: z.literal(1280),
        height: z.literal(720),
      })
      .strict(),
    communicationContract: communicationContractSchema,
    presentationDesignSystem: designSystemV2Schema,
    argumentMode: z.enum(ARGUMENT_MODES),
    visualStyle: z
      .object({
        id: z.enum(VISUAL_STYLES),
      })
      .passthrough(),
    readingMode: z.enum(READING_MODES),
    resolvedTemplate: resolvedTemplateSelectionSchema.optional(),
  })
  .passthrough()
  .superRefine((spec, context) => {
    if (spec.argumentMode !== spec.presentationDesignSystem.argumentMode) {
      context.addIssue({
        code: "custom",
        path: ["argumentMode"],
        message: "argumentMode must match presentationDesignSystem.argumentMode.",
      });
    }
    if (spec.visualStyle.id !== spec.presentationDesignSystem.visualStyle) {
      context.addIssue({
        code: "custom",
        path: ["visualStyle", "id"],
        message: "visualStyle.id must match presentationDesignSystem.visualStyle.",
      });
    }
    if (spec.readingMode !== spec.presentationDesignSystem.readingMode) {
      context.addIssue({
        code: "custom",
        path: ["readingMode"],
        message: "readingMode must match presentationDesignSystem.readingMode.",
      });
    }
    if (spec.resolvedTemplate) {
      const builtin = getBuiltinTemplate(spec.resolvedTemplate.templateId);
      if (builtin) {
        try {
          assertDesignSystemMatchesTemplate(spec.presentationDesignSystem, builtin);
        } catch (error) {
          context.addIssue({
            code: "custom",
            path: ["presentationDesignSystem"],
            message: error instanceof Error ? error.message : String(error),
          });
        }
        if (spec.resolvedTemplate.templateRevisionId !== builtin.revisionId) {
          context.addIssue({
            code: "custom",
            path: ["resolvedTemplate", "templateRevisionId"],
            message: `resolvedTemplate.templateRevisionId must be ${builtin.revisionId}.`,
          });
        }
        if (spec.resolvedTemplate.supportLevel !== builtin.supportLevel) {
          context.addIssue({
            code: "custom",
            path: ["resolvedTemplate", "supportLevel"],
            message: `resolvedTemplate.supportLevel must be ${builtin.supportLevel}.`,
          });
        }
      }
      // Uploaded templates and project policy pins are enforced asynchronously
      // via assertDesignSpecMatchesTemplatePolicy on WriteFile / lock reads.
    }
  });

const finalCopySchema = z.union([
  z.string(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

const svgDeckPagePlanSlideSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    path: z.string().trim().min(1),
    narrativeRole: z.string().trim().min(1).max(80),
    finalCopy: finalCopySchema,
    coreMessage: z.string().trim().min(1).max(1_000),
    audienceMove: z.string().trim().min(1).max(1_000),
    rhythm: z.enum(["anchor", "dense", "breathing"]),
    layoutIntent: z.string().trim().min(1).max(2_000),
  })
  .passthrough();

export const svgDeckPagePlanSchema = z
  .object({
    version: z.literal(1),
    designSpec: z.literal(SVG_DECK_DESIGN_SPEC_PATH),
    slides: z.array(svgDeckPagePlanSlideSchema).min(1).max(100),
  })
  .passthrough();

export type SvgDeckDesignSpec = z.infer<typeof svgDeckDesignSpecSchema>;
export type SvgDeckPagePlan = z.infer<typeof svgDeckPagePlanSchema>;

/** Minimal valid shapes shown to the model on write/preview/prompt recovery. */
export const SVG_DECK_DESIGN_SPEC_MINI_SCHEMA = `{
  "version": 1,
  "canvas": {"width": 1280, "height": 720},
  "communicationContract": {
    "audience": "...",
    "objective": "...",
    "desiredOutcome": "...",
    "coreMessage": "...",
    "deliveryContext": "...",
    "afterUse": "..."
  },
  "presentationDesignSystem": {
    "version": 2,
    "argumentMode": "pyramid",
    "visualStyle": "swiss-minimal",
    "colorScheme": "business-blue",
    "readingMode": "balanced"
  },
  "argumentMode": "pyramid",
  "visualStyle": {"id": "swiss-minimal"},
  "readingMode": "balanced",
  "resolvedTemplate": {
    "templateId": "builtin/swiss-minimal",
    "templateRevisionId": "1",
    "source": "auto",
    "reasons": ["..."],
    "supportLevel": "native"
  }
}`;

export const SVG_DECK_PAGE_PLAN_MINI_SCHEMA = `{
  "version": 1,
  "designSpec": "design/design-spec.json",
  "slides": [
    {
      "id": "P01",
      "path": "slides/svg/P01.svg",
      "narrativeRole": "cover",
      "finalCopy": {"title": "..."},
      "coreMessage": "...",
      "audienceMove": "...",
      "rhythm": "anchor",
      "layoutIntent": "..."
    }
  ]
}`;

export function isSvgDeckLockPath(path: string): boolean {
  const normalized = normalizeLockPath(path);
  return normalized === SVG_DECK_DESIGN_SPEC_PATH || normalized === SVG_DECK_PAGE_PLAN_PATH;
}

export function svgDeckLockRecoveryHint(path: string): string {
  const normalized = normalizeLockPath(path);
  if (normalized === SVG_DECK_DESIGN_SPEC_PATH) {
    return (
      `Call ResolveProjectTemplate (and LoadSkill("ppt-design") if needed) before rewriting ` +
      `${SVG_DECK_DESIGN_SPEC_PATH}. Required top-level fields: version=1, canvas{width:1280,height:720}, ` +
      "communicationContract{audience,objective,desiredOutcome,coreMessage,deliveryContext,afterUse}, " +
      "presentationDesignSystem (Design System v2), argumentMode, visualStyle.id, readingMode " +
      "(axes must match presentationDesignSystem). Include resolvedTemplate from " +
      "ResolveProjectTemplate selection (do not invent template ids or override an active " +
      "design/template-pack.json palette/fonts/chrome)."
    );
  }
  if (normalized === SVG_DECK_PAGE_PLAN_PATH) {
    return (
      `LoadSkill("ppt-design-layout") before rewriting ${SVG_DECK_PAGE_PLAN_PATH}. ` +
      'Required top-level fields: version=1, designSpec="design/design-spec.json", ' +
      "slides[].{id,path,narrativeRole,finalCopy,coreMessage,audienceMove,rhythm,layoutIntent}."
    );
  }
  return `LoadSkill("ppt-design") and LoadSkill("ppt-design-layout") for SVG deck lock schemas.`;
}

export function svgDeckLockMiniSchemaForPath(path: string): string | undefined {
  const normalized = normalizeLockPath(path);
  if (normalized === SVG_DECK_DESIGN_SPEC_PATH) return SVG_DECK_DESIGN_SPEC_MINI_SCHEMA;
  if (normalized === SVG_DECK_PAGE_PLAN_PATH) return SVG_DECK_PAGE_PLAN_MINI_SCHEMA;
  return undefined;
}

export function formatSvgDeckLockIssues(zodError: z.ZodError, limit = 12): string {
  return zodError.issues
    .slice(0, limit)
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    .join("; ");
}

export function formatSvgDeckLockContractBlock(): string {
  return [
    "### SVG Deck Lock Contract",
    "锁文件契约与预览/提交校验仍然有效；任务路径只推荐能力组合，不绕过锁或凭据。",
    `写 ${SVG_DECK_DESIGN_SPEC_PATH} 前先 LoadSkill("ppt-design")；` +
      `写 ${SVG_DECK_PAGE_PLAN_PATH} 前先 LoadSkill("ppt-design-layout")。已有有效锁文件时复用，不整套重做。`,
    "可同批加载多个 Skill（例如同时 LoadSkill ppt-design 与 ppt-design-layout），" +
      "不必一技能一轮。依赖上一步正文结果的写入仍须等 tool_result。",
    "新建作者链的依赖建议（尽量合并独立调用，减少模型往返）：" +
      "BeginPptCapability →（可选 SetPptTaskAssessment）→ ResolveProjectTemplate → (optional GetDesignReference) → " +
      "LoadSkill(s) → WriteFile design-spec → WriteFile page-plan → " +
      "WriteFile P01 + PreviewSvgPage →（看图校准后）按可完整输出的规模分批写剩余 SVG → " +
      "同批 PreviewSvgPage → SubmitSvgDeck（独批）。" +
      "若 design/template-pack.json 已 verified，Resolve 后必须沿用 pack，不得另选 visualStyle。" +
      "局部编辑/美化/只审查/只导出不走完整 create 锁 bootstrap。",
    `非法锁文件不会通过 WriteFile、PreviewSvgPage 或 SubmitSvgDeck。`,
    "",
    `${SVG_DECK_DESIGN_SPEC_PATH} 最低结构：`,
    "```json",
    SVG_DECK_DESIGN_SPEC_MINI_SCHEMA,
    "```",
    "",
    `${SVG_DECK_PAGE_PLAN_PATH} 最低结构：`,
    "```json",
    SVG_DECK_PAGE_PLAN_MINI_SCHEMA,
    "```",
  ].join("\n");
}

export function formatSvgDeckLockBootstrapGuidance(): string {
  return [
    "SVG-native create bootstrap (authoring chain; reuse valid locks instead of rewriting them):",
    '1. Batch LoadSkill("ppt-design") (and LoadSkill("ppt-design-layout") when you already know you need both); ' +
      "after skill bodies return, WriteFile design/design-spec.json.",
    "2. WriteFile slides/page-plan.json in the earliest turn whose parameters do not depend on unread skill text.",
    "3. Same turn when possible: WriteFile slides/svg/P01.svg then PreviewSvgPage; do not start P02 until P01 passes.",
    "4. After P01 passes: write manageable batches of remaining SVGs and preview each batch. Complete the next page rather than planning the whole deck in one response; call SubmitSvgDeck alone when all pages pass.",
    "5. Preview/Submit/lock checks remain mandatory. A task-plan route does not waive credentials or allow review capability to SubmitSvgDeck.",
    "",
    formatSvgDeckLockContractBlock(),
  ].join("\n");
}

/**
 * Validate lock-file content before WriteFile/EditFile commits.
 * Returns parsed data on success; throws Error with recovery hint on failure.
 */
export function validateSvgDeckLockContent(
  path: string,
  content: string,
): SvgDeckDesignSpec | SvgDeckPagePlan {
  const normalized = normalizeLockPath(path);
  const schema = schemaForLockPath(normalized);
  if (!schema) {
    throw new Error(`${path} is not an SVG deck lock file.`);
  }

  let source: unknown;
  try {
    source = JSON.parse(content);
  } catch (error) {
    throw new Error(
      formatLockValidationFailure(
        normalized,
        `${normalized} must contain valid JSON: ${errorMessage(error)}`,
      ),
    );
  }

  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(
      formatLockValidationFailure(
        normalized,
        `${normalized} does not satisfy the SVG deck lock schema: ` +
          formatSvgDeckLockIssues(result.error),
      ),
    );
  }
  return result.data;
}

export function assertSvgPageBelongsToPlan(sourcePath: string, pagePlan: SvgDeckPagePlan): void {
  const normalized = normalizeWorkspaceSvgPath(sourcePath);
  if (!pagePlan.slides.some((slide) => normalizeWorkspaceSvgPath(slide.path) === normalized)) {
    throw new Error(`${sourcePath} is not present in the current ${SVG_DECK_PAGE_PLAN_PATH}.`);
  }
}

/** Read and validate both locks, then ensure the SVG page is listed in page-plan. */
export async function precheckSvgPagePreviewLocks(
  fileService: NonNullable<ToolContext["fileService"]>,
  sourcePath: string,
  caller = "PreviewSvgPage",
): Promise<{
  designSpec: SvgDeckDesignSpec;
  pagePlan: SvgDeckPagePlan;
}> {
  try {
    const locks = await readSvgDeckLocks(fileService, caller);
    assertSvgPageBelongsToPlan(sourcePath, locks.pagePlan);
    return locks;
  } catch (error) {
    const detail = errorMessage(error);
    throw new Error(`${caller} lock precheck failed: ${detail}`);
  }
}

export async function readSvgDeckLocks(
  fileService: NonNullable<ToolContext["fileService"]>,
  caller = "SubmitSvgDeck",
): Promise<{
  designSpec: SvgDeckDesignSpec;
  pagePlan: SvgDeckPagePlan;
}> {
  // Keep canonical validation order so malformed design intent is reported
  // before the downstream page plan.
  const designSpec = (await readSvgDeckLock(
    fileService,
    SVG_DECK_DESIGN_SPEC_PATH,
    caller,
  )) as SvgDeckDesignSpec;
  const pagePlan = (await readSvgDeckLock(
    fileService,
    SVG_DECK_PAGE_PLAN_PATH,
    caller,
  )) as SvgDeckPagePlan;
  return { designSpec, pagePlan };
}

export function assertSvgDeckLocksMatchSubmission<
  T extends {
    communication: z.infer<typeof communicationContractSchema>;
    designSystem: z.infer<typeof designSystemV2Schema>;
    slides: Array<{
      id: string;
      path: string;
      narrative: {
        role: string;
        coreMessage: string;
        audienceMove: string;
        rhythm: string;
        layoutIntent: string;
      };
    }>;
  },
>(args: T, designSpec: SvgDeckDesignSpec, pagePlan: SvgDeckPagePlan): void {
  for (const key of Object.keys(designSpec.communicationContract) as Array<
    keyof typeof designSpec.communicationContract
  >) {
    if (args.communication[key] !== designSpec.communicationContract[key]) {
      throw new Error(
        `SubmitSvgDeck communication.${key} must exactly match ` +
          `${SVG_DECK_DESIGN_SPEC_PATH}.communicationContract.${key}.`,
      );
    }
  }

  for (const axis of ["argumentMode", "visualStyle", "readingMode"] as const) {
    if (args.designSystem[axis] !== designSpec.presentationDesignSystem[axis]) {
      throw new Error(
        `SubmitSvgDeck designSystem.${axis} must exactly match ` +
          `${SVG_DECK_DESIGN_SPEC_PATH}.presentationDesignSystem.${axis}.`,
      );
    }
  }
  if (!isDeepStrictEqual(args.designSystem, designSpec.presentationDesignSystem)) {
    throw new Error(
      `SubmitSvgDeck designSystem must exactly match ` +
        `${SVG_DECK_DESIGN_SPEC_PATH}.presentationDesignSystem.`,
    );
  }

  if (args.slides.length !== pagePlan.slides.length) {
    throw new Error(
      `SubmitSvgDeck slides must contain exactly ${pagePlan.slides.length} page(s) ` +
        `in ${SVG_DECK_PAGE_PLAN_PATH} order; received ${args.slides.length}.`,
    );
  }

  const narrativeKeys = ["role", "coreMessage", "audienceMove", "rhythm", "layoutIntent"] as const;
  args.slides.forEach((slide, index) => {
    const planned = pagePlan.slides[index];
    if (!planned) return;
    const pageLabel = `slides[${index}]`;
    if (slide.id !== planned.id) {
      throw new Error(
        `SubmitSvgDeck ${pageLabel}.id must exactly match ` +
          `${SVG_DECK_PAGE_PLAN_PATH}.slides[${index}].id (${planned.id}).`,
      );
    }
    let submittedPath: string;
    let plannedPath: string;
    try {
      submittedPath = normalizeWorkspaceSvgPath(slide.path);
      plannedPath = normalizeWorkspaceSvgPath(planned.path);
    } catch (error) {
      throw new Error(
        `${SVG_DECK_PAGE_PLAN_PATH}.slides[${index}].path is invalid: ${errorMessage(error)}`,
      );
    }
    if (submittedPath !== plannedPath) {
      throw new Error(
        `SubmitSvgDeck ${pageLabel}.path must exactly match ` +
          `${SVG_DECK_PAGE_PLAN_PATH}.slides[${index}].path (${plannedPath}).`,
      );
    }

    const plannedNarrative = {
      role: planned.narrativeRole,
      coreMessage: planned.coreMessage,
      audienceMove: planned.audienceMove,
      rhythm: planned.rhythm,
      layoutIntent: planned.layoutIntent,
    };
    for (const key of narrativeKeys) {
      if (slide.narrative[key] !== plannedNarrative[key]) {
        const planKey = key === "role" ? "narrativeRole" : key;
        throw new Error(
          `SubmitSvgDeck ${pageLabel}.narrative.${key} must exactly match ` +
            `${SVG_DECK_PAGE_PLAN_PATH}.slides[${index}].${planKey}.`,
        );
      }
    }
  });
}

async function readSvgDeckLock(
  fileService: NonNullable<ToolContext["fileService"]>,
  path: typeof SVG_DECK_DESIGN_SPEC_PATH | typeof SVG_DECK_PAGE_PLAN_PATH,
  caller: string,
): Promise<SvgDeckDesignSpec | SvgDeckPagePlan> {
  let content: string;
  try {
    content = (
      await fileService.inspect(path, {
        maxBytes: MAX_SVG_DECK_LOCK_BYTES,
      })
    ).content;
  } catch (error) {
    throw new Error(`${caller} requires readable lock file ${path}: ${errorMessage(error)}`);
  }
  const validated = validateSvgDeckLockContent(path, content);
  if (path === SVG_DECK_DESIGN_SPEC_PATH) {
    await assertDesignSpecMatchesTemplatePolicy(fileService, validated as SvgDeckDesignSpec);
  }
  return validated;
}

function schemaForLockPath(
  path: string,
): typeof svgDeckDesignSpecSchema | typeof svgDeckPagePlanSchema | undefined {
  if (path === SVG_DECK_DESIGN_SPEC_PATH) return svgDeckDesignSpecSchema;
  if (path === SVG_DECK_PAGE_PLAN_PATH) return svgDeckPagePlanSchema;
  return undefined;
}

function formatLockValidationFailure(path: string, details: string): string {
  const mini = svgDeckLockMiniSchemaForPath(path);
  const parts = [details, svgDeckLockRecoveryHint(path)];
  if (mini) {
    parts.push(`Minimum valid shape:\n${mini}`);
  }
  return parts.join("\n");
}

function normalizeLockPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function formatIssuePath(path: PropertyKey[]): string {
  if (path.length === 0) return "<root>";
  return path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : String(segment)))
    .join(".");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
