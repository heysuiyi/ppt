import type { ColorScheme, DesignSystemV2 } from "@design-system";
import { getBuiltinTemplate } from "@shared/template-catalog";
import {
  createDefaultProjectTemplatePolicy,
  type ProjectTemplatePolicy,
  projectTemplatePolicySchema,
  type ResolvedTemplateSelection,
  TEMPLATE_LIBRARY_INDEX_PATH,
  TEMPLATE_PACK_PATH,
  TEMPLATE_POLICY_PATH,
  type TemplateDescriptor,
  type TemplatePack,
  templateDescriptorSchema,
  templatePackSchema,
  templateRevisionPath,
} from "@shared/template-protocol";
import {
  assertDesignSystemMatchesTemplate,
  resolveProjectTemplate,
} from "@shared/template-resolver";
import type { WorkspaceFileService } from "../../../agent/tools/files/workspace-file-service";

export interface WorkspaceTemplateState {
  policy: ProjectTemplatePolicy;
  uploadedTemplates: TemplateDescriptor[];
  pack?: TemplatePack;
}

async function readJsonIfExists<T>(
  fileService: WorkspaceFileService | undefined,
  path: string,
  parse: (value: unknown) => T,
): Promise<T | undefined> {
  if (!fileService) return undefined;
  try {
    const result = await fileService.read(path);
    return parse(JSON.parse(result.content));
  } catch {
    return undefined;
  }
}

export async function loadProjectTemplatePolicy(
  fileService: WorkspaceFileService | undefined,
): Promise<ProjectTemplatePolicy> {
  const policy = await readJsonIfExists(fileService, TEMPLATE_POLICY_PATH, (value) =>
    projectTemplatePolicySchema.parse(value),
  );
  return policy ?? createDefaultProjectTemplatePolicy();
}

export async function loadUploadedTemplateDescriptors(
  fileService: WorkspaceFileService | undefined,
): Promise<TemplateDescriptor[]> {
  if (!fileService) return [];
  const index = await readJsonIfExists(
    fileService,
    TEMPLATE_LIBRARY_INDEX_PATH,
    (value) => value as { templates?: Array<{ id: string; revisionId: string }> },
  );
  if (!index?.templates?.length) return [];

  const descriptors: TemplateDescriptor[] = [];
  for (const entry of index.templates) {
    const relative = `${templateRevisionPath(entry.id, entry.revisionId)}/descriptor.json`;
    const descriptor = await readJsonIfExists(fileService, relative, (value) =>
      templateDescriptorSchema.parse(value),
    );
    if (descriptor) descriptors.push(descriptor);
  }
  return descriptors;
}

export async function loadProjectTemplatePack(
  fileService: WorkspaceFileService | undefined,
): Promise<TemplatePack | undefined> {
  return readJsonIfExists(fileService, TEMPLATE_PACK_PATH, (value) =>
    templatePackSchema.parse(value),
  );
}

export async function readWorkspaceTemplateState(
  fileService: WorkspaceFileService | undefined,
): Promise<WorkspaceTemplateState> {
  const [policy, uploadedTemplates, pack] = await Promise.all([
    loadProjectTemplatePolicy(fileService),
    loadUploadedTemplateDescriptors(fileService),
    loadProjectTemplatePack(fileService),
  ]);
  return { policy, uploadedTemplates, pack };
}

/**
 * The template the project policy pins regardless of communication signals.
 * `auto` stays unpinned because the winning candidate depends on the signals
 * only ResolveProjectTemplate sees.
 */
export function pinnedProjectTemplate(
  state: WorkspaceTemplateState,
): TemplateDescriptor | undefined {
  if (state.policy.mode === "auto") return undefined;
  if (state.policy.mode === "custom") {
    const customId = state.policy.customTemplateId;
    const customRevision = state.policy.customTemplateRevisionId;
    if (!customId || !customRevision) {
      throw new Error(
        `${TEMPLATE_POLICY_PATH} mode=custom requires customTemplateId and ` +
          "customTemplateRevisionId.",
      );
    }
    const custom = findProjectTemplate(state, customId, customRevision);
    if (!custom) {
      throw new Error(
        `${TEMPLATE_POLICY_PATH} mode=custom pins ${customId}@${customRevision}, ` +
          "but that revision is missing under design/templates/**. " +
          "Re-import the package or switch the policy away from custom.",
      );
    }
    return custom;
  }
  return resolveProjectTemplate({
    policy: state.policy,
    uploadedTemplates: state.uploadedTemplates,
  }).template;
}

export function findProjectTemplate(
  state: WorkspaceTemplateState,
  templateId: string,
  revisionId?: string,
): TemplateDescriptor | undefined {
  const uploaded = state.uploadedTemplates.find(
    (item) => item.id === templateId && (!revisionId || item.revisionId === revisionId),
  );
  if (uploaded) return uploaded;
  const builtin = getBuiltinTemplate(templateId);
  if (builtin && (!revisionId || builtin.revisionId === revisionId)) return builtin;
  return undefined;
}

function formatColorScheme(scheme: ColorScheme): string {
  if (typeof scheme === "string") return scheme;
  const entries = Object.entries(scheme)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

function assertAgainstPack(
  pack: TemplatePack,
  spec: {
    presentationDesignSystem: DesignSystemV2;
    resolvedTemplate?: ResolvedTemplateSelection;
    typography?: unknown;
  },
): void {
  const declared = spec.resolvedTemplate;
  if (!declared) {
    throw new Error(
      `${TEMPLATE_PACK_PATH} pins ${pack.templateId}@${pack.revisionId}; ` +
        "call ResolveProjectTemplate and copy its selection → resolvedTemplate " +
        "and designSystem into design/design-spec.json. " +
        "Do not invent a conflicting builtin visualStyle.",
    );
  }
  if (declared.templateId !== pack.templateId || declared.templateRevisionId !== pack.revisionId) {
    throw new Error(
      `resolvedTemplate ${declared.templateId}@${declared.templateRevisionId} contradicts ` +
        `${TEMPLATE_PACK_PATH} which pins ${pack.templateId}@${pack.revisionId}.`,
    );
  }
  if (
    formatColorScheme(spec.presentationDesignSystem.colorScheme) !==
    formatColorScheme(pack.designSystem.colorScheme)
  ) {
    throw new Error(
      `presentationDesignSystem.colorScheme must match ${TEMPLATE_PACK_PATH} palette; ` +
        "copy designSystem from ResolveProjectTemplate / the pack verbatim.",
    );
  }
  if (
    spec.presentationDesignSystem.visualStyle !== pack.designSystem.visualStyle ||
    spec.presentationDesignSystem.argumentMode !== pack.designSystem.argumentMode ||
    spec.presentationDesignSystem.readingMode !== pack.designSystem.readingMode
  ) {
    throw new Error(
      `presentationDesignSystem axes must match ${TEMPLATE_PACK_PATH} ` +
        `(${pack.designSystem.argumentMode}/${pack.designSystem.visualStyle}/` +
        `${pack.designSystem.readingMode}).`,
    );
  }
  if (spec.typography && typeof spec.typography === "object") {
    const roles = spec.typography as Record<string, unknown>;
    for (const key of ["title", "body", "emphasis", "data"] as const) {
      if (roles[key] && roles[key] !== pack.typography[key]) {
        throw new Error(
          `design-spec typography.${key} must match ${TEMPLATE_PACK_PATH} ` +
            `(expected ${pack.typography[key]}).`,
        );
      }
    }
  }
}

/**
 * Rejects a design-spec that ignores the project template binding. Without this
 * an imported design-reference template is silently dropped: the model can lock
 * any palette it likes and design/template-policy.json becomes decoration.
 */
export function assertDesignSpecMatchesTemplateState(
  state: WorkspaceTemplateState,
  spec: {
    presentationDesignSystem: DesignSystemV2;
    resolvedTemplate?: ResolvedTemplateSelection;
    typography?: unknown;
  },
): void {
  if (state.pack) {
    assertAgainstPack(state.pack, spec);
    return;
  }

  const pinned = pinnedProjectTemplate(state);
  const declared = spec.resolvedTemplate;

  if (pinned && !declared) {
    throw new Error(
      `${TEMPLATE_POLICY_PATH} mode=${state.policy.mode} pins template ` +
        `${pinned.id}@${pinned.revisionId}; call ResolveProjectTemplate and copy its ` +
        "resolvedTemplate + designSystem into design/design-spec.json. " +
        `Also ensure ${TEMPLATE_PACK_PATH} was materialized via ApplyTemplate.`,
    );
  }
  if (
    pinned &&
    declared &&
    (declared.templateId !== pinned.id || declared.templateRevisionId !== pinned.revisionId)
  ) {
    throw new Error(
      `resolvedTemplate ${declared.templateId}@${declared.templateRevisionId} contradicts ` +
        `${TEMPLATE_POLICY_PATH} mode=${state.policy.mode}, which pins ` +
        `${pinned.id}@${pinned.revisionId}.`,
    );
  }
  if (!declared) return;

  const template =
    pinned ?? findProjectTemplate(state, declared.templateId, declared.templateRevisionId);
  if (!template) {
    throw new Error(
      `resolvedTemplate.templateId ${declared.templateId}@${declared.templateRevisionId} ` +
        "is not in the builtin catalog or design/templates/**. Use ResolveProjectTemplate " +
        "instead of inventing template ids.",
    );
  }
  if (declared.supportLevel !== template.supportLevel) {
    throw new Error(
      `resolvedTemplate.supportLevel must be ${template.supportLevel} for ${template.id}.`,
    );
  }
  assertDesignSystemMatchesTemplate(spec.presentationDesignSystem, template);

  if (
    template.kind === "uploaded" &&
    formatColorScheme(spec.presentationDesignSystem.colorScheme) !==
      formatColorScheme(template.designSystem.colorScheme)
  ) {
    throw new Error(
      `presentationDesignSystem.colorScheme must be the palette extracted from uploaded ` +
        `template ${template.id}; copy designSystem from ResolveProjectTemplate verbatim.`,
    );
  }
}

export async function assertDesignSpecMatchesTemplatePolicy(
  fileService: WorkspaceFileService | undefined,
  spec: {
    presentationDesignSystem: DesignSystemV2;
    resolvedTemplate?: ResolvedTemplateSelection;
    typography?: unknown;
  },
): Promise<void> {
  if (!fileService) return;
  assertDesignSpecMatchesTemplateState(await readWorkspaceTemplateState(fileService), spec);
}
