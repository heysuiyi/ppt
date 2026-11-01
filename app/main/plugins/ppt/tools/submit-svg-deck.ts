import { designSystemV2Schema } from "@design-system";
import type { PresentationCommand } from "@shared/commands";
import { type Slide, slideNarrativeSchema } from "@shared/presentation";
import { assertValidSvgPage } from "@shared/svg-page";
import { z } from "zod";
import {
  type AgentCommandProposalResult,
  agentCommandProposalResultSchema,
} from "../../../agent/runtime/runtime-types";
import { assumptionsSchema } from "../../../agent/tools/assumptions-schema";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";
import { requirePptCapability, requirePresentation } from "../context";
import {
  hasSvgPagePreviewReceipt,
  loadWorkspaceSvgPage,
  normalizeWorkspaceSvgPath,
} from "../svg-page-loader";
import { assertSvgPageLifecycleCurrent } from "./svg-deck-lifecycle";
import {
  assertSvgDeckLocksMatchSubmission,
  communicationContractSchema,
  readSvgDeckLocks,
  SVG_DECK_DESIGN_SPEC_PATH,
  SVG_DECK_PAGE_PLAN_PATH,
} from "./svg-deck-locks";

export {
  SVG_DECK_DESIGN_SPEC_PATH,
  SVG_DECK_PAGE_PLAN_PATH,
} from "./svg-deck-locks";

export const MAX_HYDRATED_SVG_DECK_BYTES = 128 * 1024 * 1024;

const submitSvgSlideSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(500),
    path: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Workspace-relative path to a complete 1280x720 SVG page, for example slides/svg/P01.svg.",
      ),
    speakerNotes: z.string().trim().max(20_000).optional(),
    narrative: slideNarrativeSchema,
  })
  .strict();

export const submitSvgDeckSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    designSpecPath: z.literal(SVG_DECK_DESIGN_SPEC_PATH),
    pagePlanPath: z.literal(SVG_DECK_PAGE_PLAN_PATH),
    communication: communicationContractSchema,
    designSystem: designSystemV2Schema,
    slides: z.array(submitSvgSlideSchema).min(1).max(100),
    summary: z.string().trim().min(1),
    risk: z.enum(["low", "medium", "high"]).default("medium"),
    assumptions: assumptionsSchema,
  })
  .strict()
  .superRefine((deck, context) => {
    const paths = new Set<string>();
    const ids = new Set<string>();
    deck.slides.forEach((slide, index) => {
      let normalizedPath: string;
      try {
        normalizedPath = normalizeWorkspaceSvgPath(slide.path);
      } catch (error) {
        context.addIssue({
          code: "custom",
          path: ["slides", index, "path"],
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (paths.has(normalizedPath)) {
        context.addIssue({
          code: "custom",
          path: ["slides", index, "path"],
          message: `Duplicate SVG page path: ${slide.path}`,
        });
      }
      paths.add(normalizedPath);
      if (slide.id && ids.has(slide.id)) {
        context.addIssue({
          code: "custom",
          path: ["slides", index, "id"],
          message: `Duplicate slide id: ${slide.id}`,
        });
      }
      if (slide.id) ids.add(slide.id);
    });
  });

/**
 * Terminal creation boundary for the SVG-native deck pipeline.
 *
 * The model authors one complete page per workspace SVG file. This tool
 * localizes raster dependencies, validates the resulting self-contained SVG,
 * and proposes replacing the current deck with those exact page sources.
 */
export const submitSvgDeckTool: ToolDefinition<
  typeof submitSvgDeckSchema,
  AgentCommandProposalResult
> = {
  name: "SubmitSvgDeck",
  description:
    "新建或重做整套 PPT 的唯一 SVG-native 提交入口。先用 WriteFile 写完整页面 SVG，" +
    "逐页用 PreviewSvgPage 成功渲染当前版本，再传入有序路径；工具会验证每页预览凭据、" +
    `强制读取 ${SVG_DECK_DESIGN_SPEC_PATH} 与 ${SVG_DECK_PAGE_PLAN_PATH} 并核对提交参数，` +
    "内联本地图片、严格校验，并用同一 SVG 建立预览与导出所需的 Command Proposal。",
  category: "core",
  loadPolicy: "core",
  inputSchema: submitSvgDeckSchema,
  outputSchema: agentCommandProposalResultSchema,
  isEnabled: (context) => Boolean(context.workspaceRoot && context.fileService),
  validateContext: requirePptCapability(["create", "edit", "restyle"]),
  behavior: {
    capabilities: ["command_proposal"],
    completion: {
      terminalResult: "command_proposal",
      expectation: "always",
      exclusiveBatch: true,
    },
  },
  risk: "low",
  execute: async (args, context) => {
    if (!context.workspaceRoot || !context.fileService) {
      throw new Error("SubmitSvgDeck requires a configured workspace.");
    }
    context.presentationLifecycle?.requireActiveCapability(["create", "edit", "restyle"]);
    await context.presentationLifecycle?.observeArtifactChanges({
      workspaceRoot: context.workspaceRoot,
      source: "submit",
    });
    const { designSpec, pagePlan } = await readSvgDeckLocks(context.fileService);
    assertSvgDeckLocksMatchSubmission(args, designSpec, pagePlan);

    const committedPageKeys = new Set(
      requirePresentation(context).slides.flatMap((slide) =>
        slide.visualSource?.kind === "svg"
          ? [`${slide.visualSource.sourcePath}\0${slide.visualSource.sha256}`]
          : [],
      ),
    );
    const slides: Slide[] = [];
    let hydratedDeckBytes = 0;
    for (const [index, input] of args.slides.entries()) {
      const hydrated = await loadWorkspaceSvgPage({
        requestedPath: input.path,
        workspaceRoot: context.workspaceRoot,
        fileService: context.fileService,
      });
      hydratedDeckBytes += hydrated.byteSize;
      if (hydratedDeckBytes > MAX_HYDRATED_SVG_DECK_BYTES) {
        throw new Error(
          `Hydrated SVG deck exceeds ${MAX_HYDRATED_SVG_DECK_BYTES} bytes. ` +
            "Reduce embedded raster size or split the presentation.",
        );
      }
      assertValidSvgPage(hydrated.markup);
      const alreadyCommitted = committedPageKeys.has(`${hydrated.sourcePath}\0${hydrated.sha256}`);
      if (context.presentationLifecycle) {
        await assertSvgPageLifecycleCurrent({
          lifecycle: context.presentationLifecycle,
          fileService: context.fileService,
          page: hydrated,
          locks: { designSpec, pagePlan },
        });
      } else if (!alreadyCommitted && !hasSvgPagePreviewReceipt(context.fileService, hydrated)) {
        const pageLabel = `P${String(index + 1).padStart(2, "0")}`;
        throw new Error(
          `${pageLabel} preview gate is missing or stale for ${hydrated.sourcePath}. ` +
            "Call PreviewSvgPage with includeThumbnail=true, inspect the rendered page, " +
            "and retry without changing that SVG afterward.",
        );
      }
      slides.push({
        id: input.id,
        title: input.title,
        ...(input.speakerNotes !== undefined ? { speakerNotes: input.speakerNotes } : {}),
        visualSource: {
          kind: "svg" as const,
          markup: hydrated.markup,
          width: 1280 as const,
          height: 720 as const,
          sha256: hydrated.sha256,
          sourcePath: hydrated.sourcePath,
          resources: hydrated.resources,
        },
        narrative: input.narrative,
      });
    }

    const commands: PresentationCommand[] = [
      ...requirePresentation(context).slides.map((slide) => ({
        id: crypto.randomUUID(),
        type: "remove-slide" as const,
        slideId: slide.id,
      })),
      {
        id: crypto.randomUUID(),
        type: "set-presentation-title",
        title: args.title,
      },
      {
        id: crypto.randomUUID(),
        type: "set-design-system",
        designSystem: args.designSystem,
      },
      ...slides.map((slide, index) => ({
        id: crypto.randomUUID(),
        type: "add-slide" as const,
        slide,
        index,
      })),
    ];

    return {
      type: "command_proposal",
      summary: args.summary,
      commands,
      risk: args.risk,
      assumptions: [
        ...(args.assumptions ?? []),
        `Communication contract — audience: ${args.communication.audience}; ` +
          `objective: ${args.communication.objective}; desired outcome: ${args.communication.desiredOutcome}; ` +
          `core message: ${args.communication.coreMessage}; delivery: ${args.communication.deliveryContext}; ` +
          `after-use: ${args.communication.afterUse}.`,
      ],
    };
  },
};
