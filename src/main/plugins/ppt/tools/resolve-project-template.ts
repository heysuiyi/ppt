import { TEMPLATE_PACK_PATH, templateCommunicationSignalsSchema } from "@shared/template-protocol";
import { resolveProjectTemplate } from "@shared/template-resolver";
import type { z } from "zod";
import type { WorkspaceFileService } from "../../../agent/tools/files/workspace-file-service";
import type { ToolDefinition } from "../../../agent/tools/tool-definition";
import { requirePptCapability } from "../context";
import { readWorkspaceTemplateState } from "./project-template-state";

export const resolveProjectTemplateSchema = templateCommunicationSignalsSchema;

/**
 * Resolves the project template policy + communication signals into a locked
 * template selection and executable Design System. Models must copy this into
 * design/design-spec.json instead of inventing a conflicting visualStyle.
 */
export const resolveProjectTemplateTool: ToolDefinition<
  typeof resolveProjectTemplateSchema,
  Awaited<ReturnType<typeof executeResolve>>
> = {
  name: "ResolveProjectTemplate",
  description:
    "在写入 design/design-spec.json 之前，根据 design/template-policy.json、" +
    "design/template-pack.json 与沟通信号确定性解析模板。" +
    "若项目已物化 template-pack，直接返回该 pack 的 designSystem / typography / chrome / assets，" +
    "禁止另选冲突 builtin visualStyle。" +
    "返回 selection（写入 resolvedTemplate）、designSystem 与 authoringGuidance。" +
    "上传模板仅作 design-reference（参考风格重生 SVG），不代表 PowerPoint 母版保真。",
  category: "core",
  loadPolicy: "core",
  inputSchema: resolveProjectTemplateSchema,
  validateContext: requirePptCapability(["create", "edit", "restyle"]),
  risk: "low",
  execute: async (args, context) => executeResolve(args, context.fileService),
};

async function executeResolve(
  signals: z.infer<typeof resolveProjectTemplateSchema>,
  fileService: WorkspaceFileService | undefined,
) {
  const state = await readWorkspaceTemplateState(fileService);

  if (state.pack) {
    if (signals.explicitTemplateId && signals.explicitTemplateId !== state.pack.templateId) {
      throw new Error(
        `${TEMPLATE_PACK_PATH} is active (${state.pack.templateId}@${state.pack.revisionId}); ` +
          `cannot resolve explicitTemplateId=${signals.explicitTemplateId}. ` +
          "Clear the pack / switch policy before selecting another template.",
      );
    }
    if (
      signals.explicitVisualStyle &&
      signals.explicitVisualStyle !== state.pack.designSystem.visualStyle
    ) {
      throw new Error(
        `${TEMPLATE_PACK_PATH} is active; explicitVisualStyle=` +
          `${signals.explicitVisualStyle} contradicts pack visualStyle=` +
          `${state.pack.designSystem.visualStyle}. Keep the pack designSystem axes.`,
      );
    }

    return {
      policy: state.policy,
      selection: {
        templateId: state.pack.templateId,
        templateRevisionId: state.pack.revisionId,
        source: "explicit-custom" as const,
        reasons: [
          `Active ${TEMPLATE_PACK_PATH} → ${state.pack.templateId}@${state.pack.revisionId}`,
        ],
        supportLevel: "design-reference" as const,
      },
      designSystem: state.pack.designSystem,
      typography: state.pack.typography,
      chrome: state.pack.chrome ?? null,
      assets: state.pack.assets,
      inheritance: state.pack.inheritance,
      authoringGuidance: state.pack.authoringGuidance,
      template: {
        id: state.pack.templateId,
        revisionId: state.pack.revisionId,
        kind: "uploaded" as const,
        supportLevel: "design-reference" as const,
        name: state.pack.name,
        description: "Uploaded PPTX/POTX design-reference pack. Pages regenerate as SVG.",
      },
      scores: [],
      supportLevelNote:
        "参考模板 pack 已激活：必须使用返回的 designSystem / typography / chrome / assets；" +
        "不要用 GetDesignReference 的内置样板覆盖配色或字体。",
      packPath: TEMPLATE_PACK_PATH,
    };
  }

  const resolved = resolveProjectTemplate({
    policy: state.policy,
    signals,
    uploadedTemplates: state.uploadedTemplates,
  });

  return {
    policy: state.policy,
    selection: resolved.selection,
    designSystem: resolved.template.designSystem,
    typography: null,
    chrome: null,
    assets: [],
    inheritance: null,
    authoringGuidance: resolved.template.authoringGuidance ?? null,
    template: {
      id: resolved.template.id,
      revisionId: resolved.template.revisionId,
      kind: resolved.template.kind,
      supportLevel: resolved.template.supportLevel,
      name: resolved.template.name,
      description: resolved.template.description,
    },
    scores: resolved.scores.slice(0, 5),
    supportLevelNote:
      resolved.template.supportLevel === "design-reference"
        ? "参考模板：按提取的主题色/字体/结构指引重新生成 SVG，不保留原 PPT 母版与占位符。"
        : resolved.template.supportLevel === "native"
          ? "内置模板：锁定 Design System 与构图指引；页面仍由 page-plan + SVG 创作。"
          : "母版保真尚未启用。",
    packPath: null,
  };
}
