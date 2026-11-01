import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { deckExportHistoryFileSchema } from "@shared/deck-persistence";
import { presentationSchema } from "@shared/presentation";
import {
  hasMeaningfulArtifactContent,
  isDefaultArtifactContent,
} from "@shared/project-artifact-state";
import {
  isDefaultBriefMarkdown,
  isDefaultOutlineMarkdown,
  parseOutlineItems,
} from "@shared/project-artifacts";
import { validateSvgPage } from "@shared/svg-page";
import {
  createDefaultProjectTemplatePolicy,
  formatProjectTemplatePolicy,
  projectTemplatePolicySchema,
  TEMPLATE_PACK_PATH,
  TEMPLATE_POLICY_PATH,
  templatePackSchema,
} from "@shared/template-protocol";
import type { ZodType } from "zod";
import {
  formatSvgDeckLockIssues,
  SVG_DECK_DESIGN_SPEC_PATH,
  SVG_DECK_PAGE_PLAN_PATH,
  type SvgDeckPagePlan,
  svgDeckDesignSpecSchema,
  svgDeckPagePlanSchema,
} from "../tools/svg-deck-locks";

export interface WorkspaceArtifacts {
  designSpec: boolean;
  templatePolicy: boolean;
  templatePack: boolean;
  pagePlan: boolean;
  pageSvg: boolean;
  assets: boolean;
  deck: boolean;
  exportHistory: boolean;
  brief: boolean;
  outline: boolean;
  research: boolean;
}

export type WorkspaceArtifactStatus = "missing" | "empty" | "default" | "invalid" | "verified";

export interface WorkspaceArtifactProbe {
  path: string;
  status: WorkspaceArtifactStatus;
  verified: boolean;
  reason?: string;
}

export interface WorkspaceArtifactProbeDetails {
  designSpec: WorkspaceArtifactProbe;
  templatePolicy: WorkspaceArtifactProbe;
  templatePack: WorkspaceArtifactProbe;
  pagePlan: WorkspaceArtifactProbe;
  pageSvg: WorkspaceArtifactProbe;
  assets: WorkspaceArtifactProbe;
  deck: WorkspaceArtifactProbe;
  exportHistory: WorkspaceArtifactProbe;
  brief: WorkspaceArtifactProbe;
  outline: WorkspaceArtifactProbe;
  research: WorkspaceArtifactProbe;
}

const EMPTY_ARTIFACTS: WorkspaceArtifacts = {
  designSpec: false,
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
};

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function missingProbe(path: string): WorkspaceArtifactProbe {
  return { path, status: "missing", verified: false, reason: "File does not exist." };
}

function invalidProbe(path: string, reason: string): WorkspaceArtifactProbe {
  return { path, status: "invalid", verified: false, reason };
}

function validateBriefContent(path: string, content: string | undefined): WorkspaceArtifactProbe {
  if (content === undefined) return missingProbe(path);
  const trimmed = content.trim();
  if (!trimmed) return { path, status: "empty", verified: false, reason: "Brief is empty." };
  if (isDefaultBriefMarkdown(trimmed)) {
    return {
      path,
      status: "default",
      verified: false,
      reason: "Brief still matches the optional scaffold.",
    };
  }

  const hasHeading = /^#\s+/m.test(trimmed);
  const hasBriefSignal = /目的|受众|听众|页|页面|幻灯片|规划|大纲|要点|背景|痛点|风格/.test(
    trimmed,
  );
  if (!hasHeading || !hasBriefSignal) {
    return invalidProbe(path, "Brief lacks recognizable planning signals.");
  }

  return { path, status: "verified", verified: true };
}

function validateOutlineContent(path: string, content: string | undefined): WorkspaceArtifactProbe {
  if (content === undefined) return missingProbe(path);
  const trimmed = content.trim();
  if (!trimmed) return { path, status: "empty", verified: false, reason: "Outline is empty." };
  if (isDefaultOutlineMarkdown(trimmed)) {
    return {
      path,
      status: "default",
      verified: false,
      reason: "Outline still matches the optional scaffold.",
    };
  }

  const hasOutlineShape = /^##\s+\d+[.、]/m.test(trimmed) || /^\d+[.、]\s+/m.test(trimmed);
  const hasSectionGuidance =
    /section|分隔页|章节|预计\s*\d+\s*页|Hook|Context|Core|Shift|Takeaway/i.test(trimmed);
  const items = parseOutlineItems(trimmed);
  const hasDetailedNumberedSections =
    items.length >= 2 &&
    items.every((item) => item.title.trim() && item.points.some((point) => point.trim()));
  if (
    items.length < 1 ||
    !hasOutlineShape ||
    (!hasSectionGuidance && !hasDetailedNumberedSections)
  ) {
    return invalidProbe(path, "Outline lacks slide structure or section guidance.");
  }

  return { path, status: "verified", verified: true };
}

function validateJsonArtifact<T>(
  path: string,
  content: string | undefined,
  schema: ZodType<T>,
): { probe: WorkspaceArtifactProbe; value?: T } {
  if (content === undefined) return { probe: missingProbe(path) };
  if (!content.trim()) {
    return {
      probe: { path, status: "empty", verified: false, reason: "File is empty." },
    };
  }

  let source: unknown;
  try {
    source = JSON.parse(content);
  } catch (error) {
    return {
      probe: invalidProbe(
        path,
        error instanceof Error ? error.message : "File does not contain valid JSON.",
      ),
    };
  }
  const result = schema.safeParse(source);
  if (!result.success) {
    return { probe: invalidProbe(path, formatSvgDeckLockIssues(result.error, 6)) };
  }
  return {
    probe: { path, status: "verified", verified: true },
    value: result.data,
  };
}

function validateTemplatePolicyContent(
  path: string,
  content: string | undefined,
): WorkspaceArtifactProbe {
  const result = validateJsonArtifact(path, content, projectTemplatePolicySchema);
  if (!result.probe.verified || !result.value) return result.probe;
  const defaultPolicy = formatProjectTemplatePolicy(createDefaultProjectTemplatePolicy());
  if (content?.trim() === defaultPolicy.trim()) {
    return {
      path,
      status: "default",
      verified: true,
      reason: `mode=${result.value.mode}; defaultTemplateId=${result.value.defaultTemplateId}`,
    };
  }
  const customSuffix =
    result.value.mode === "custom"
      ? `; custom=${result.value.customTemplateId}@${result.value.customTemplateRevisionId}`
      : "";
  return {
    path,
    status: "verified",
    verified: true,
    reason: `mode=${result.value.mode}; defaultTemplateId=${result.value.defaultTemplateId}${customSuffix}`,
  };
}

function validateTemplatePackContent(
  path: string,
  content: string | undefined,
): WorkspaceArtifactProbe {
  const result = validateJsonArtifact(path, content, templatePackSchema);
  if (!result.probe.verified || !result.value) return result.probe;
  const pack = result.value;
  const scheme = pack.designSystem.colorScheme;
  const palette =
    typeof scheme === "string" ? scheme : `${scheme.primary}/${scheme.accent}/${scheme.background}`;
  return {
    path,
    status: "verified",
    verified: true,
    reason:
      `${pack.name} · ${pack.templateId}@${pack.revisionId} · palette=${palette}` +
      ` · fonts=${pack.typography.sourceMajor ?? "mapped"}` +
      ` · assets=${pack.assets.length}` +
      ` · headerFooter=${pack.inheritance.headerFooter}` +
      ` · titleFrame=${pack.inheritance.titleFrame}`,
  };
}

async function listFilesRecursively(directory: string): Promise<string[] | undefined> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not supported in project artifacts: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      const nested = await listFilesRecursively(entryPath);
      if (nested) files.push(...nested);
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function probeDirectory(
  path: string,
  meaningfulFile: (filePath: string) => boolean = (filePath) => !filePath.endsWith(".gitkeep"),
): Promise<WorkspaceArtifactProbe> {
  try {
    const files = await listFilesRecursively(path);
    if (files === undefined) {
      return { ...missingProbe(path), reason: "Directory does not exist." };
    }
    if (!files.some(meaningfulFile)) {
      return {
        path,
        status: "empty",
        verified: false,
        reason: "Directory contains no authored files.",
      };
    }
    return { path, status: "verified", verified: true };
  } catch (error) {
    return invalidProbe(path, error instanceof Error ? error.message : "Directory probe failed.");
  }
}

async function probeSvgPages(
  workspaceRoot: string,
  directory: string,
  pagePlan?: SvgDeckPagePlan,
): Promise<WorkspaceArtifactProbe> {
  let files: string[] | undefined;
  try {
    files = await listFilesRecursively(directory);
  } catch (error) {
    return invalidProbe(directory, error instanceof Error ? error.message : "SVG probe failed.");
  }
  if (files === undefined) {
    return { ...missingProbe(directory), reason: "SVG page directory does not exist." };
  }
  const svgFiles = files.filter((filePath) => filePath.toLowerCase().endsWith(".svg"));
  if (svgFiles.length === 0) {
    return {
      path: directory,
      status: "empty",
      verified: false,
      reason: "No SVG pages have been authored.",
    };
  }
  if (!pagePlan) {
    return invalidProbe(directory, "SVG pages require a verified slides/page-plan.json.");
  }

  const actualPaths = svgFiles.map((filePath) =>
    relative(workspaceRoot, filePath).replace(/\\/g, "/"),
  );
  const plannedPaths = pagePlan.slides.map((slide) => slide.path.replace(/\\/g, "/"));
  const missing = plannedPaths.filter((plannedPath) => !actualPaths.includes(plannedPath));
  const unexpected = actualPaths.filter((actualPath) => !plannedPaths.includes(actualPath));
  if (missing.length > 0 || unexpected.length > 0) {
    return invalidProbe(
      directory,
      [
        missing.length > 0 ? `Missing planned SVG pages: ${missing.join(", ")}.` : "",
        unexpected.length > 0 ? `Unexpected SVG pages: ${unexpected.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  for (const filePath of svgFiles) {
    const validation = validateSvgPage(await readFile(filePath, "utf8"));
    if (!validation.valid) {
      const projectPath = relative(workspaceRoot, filePath).replace(/\\/g, "/");
      return invalidProbe(
        directory,
        `${projectPath}: ${validation.issues[0]?.message ?? "SVG validation failed."}`,
      );
    }
  }
  return { path: directory, status: "verified", verified: true };
}

async function probeResearch(directory: string): Promise<WorkspaceArtifactProbe> {
  const directoryProbe = await probeDirectory(directory);
  if (!directoryProbe.verified) return directoryProbe;

  const notesPath = join(directory, "notes.md");
  const notes = await readOptionalText(notesPath);
  if (notes !== undefined && isDefaultArtifactContent("research", notes)) {
    const files = await listFilesRecursively(directory);
    const otherMeaningful = files?.some(
      (filePath) =>
        !filePath.endsWith(".gitkeep") &&
        filePath !== notesPath &&
        !filePath.endsWith("sources.md"),
    );
    if (!otherMeaningful) {
      return {
        path: directory,
        status: "default",
        verified: false,
        reason: "Research still matches the optional scaffold.",
      };
    }
  }
  if (notes !== undefined && hasMeaningfulArtifactContent("research", notes)) {
    return { path: directory, status: "verified", verified: true };
  }
  return directoryProbe;
}

export async function probeWorkspaceArtifactDetails(
  workspaceRoot?: string,
): Promise<WorkspaceArtifactProbeDetails> {
  const root = workspaceRoot ?? "";
  const paths = {
    designSpec: join(root, SVG_DECK_DESIGN_SPEC_PATH),
    templatePolicy: join(root, TEMPLATE_POLICY_PATH),
    templatePack: join(root, TEMPLATE_PACK_PATH),
    pagePlan: join(root, SVG_DECK_PAGE_PLAN_PATH),
    pageSvg: join(root, "slides/svg"),
    assets: join(root, "assets"),
    deck: join(root, "deck/snapshot.json"),
    exportHistory: join(root, "history/exports.json"),
    brief: join(root, "brief.md"),
    outline: join(root, "outline.md"),
    research: join(root, "research"),
  };

  if (!workspaceRoot) {
    return {
      designSpec: missingProbe(paths.designSpec),
      templatePolicy: missingProbe(paths.templatePolicy),
      templatePack: missingProbe(paths.templatePack),
      pagePlan: missingProbe(paths.pagePlan),
      pageSvg: missingProbe(paths.pageSvg),
      assets: missingProbe(paths.assets),
      deck: missingProbe(paths.deck),
      exportHistory: missingProbe(paths.exportHistory),
      brief: missingProbe(paths.brief),
      outline: missingProbe(paths.outline),
      research: missingProbe(paths.research),
    };
  }

  const [
    designSpecContent,
    templatePolicyContent,
    templatePackContent,
    pagePlanContent,
    deckContent,
    exportHistoryContent,
    briefContent,
    outlineContent,
  ] = await Promise.all([
    readOptionalText(paths.designSpec),
    readOptionalText(paths.templatePolicy),
    readOptionalText(paths.templatePack),
    readOptionalText(paths.pagePlan),
    readOptionalText(paths.deck),
    readOptionalText(paths.exportHistory),
    readOptionalText(paths.brief),
    readOptionalText(paths.outline),
  ]);

  const designSpecResult = validateJsonArtifact(
    paths.designSpec,
    designSpecContent,
    svgDeckDesignSpecSchema,
  );
  const templatePolicy = validateTemplatePolicyContent(paths.templatePolicy, templatePolicyContent);
  const templatePack = validateTemplatePackContent(paths.templatePack, templatePackContent);
  const pagePlanResult = validateJsonArtifact(
    paths.pagePlan,
    pagePlanContent,
    svgDeckPagePlanSchema,
  );
  let pagePlan = pagePlanResult.probe;
  if (pagePlan.verified && !designSpecResult.probe.verified) {
    pagePlan = invalidProbe(
      paths.pagePlan,
      "Page plan requires a verified design/design-spec.json.",
    );
  }

  const [pageSvg, assets, research] = await Promise.all([
    probeSvgPages(
      workspaceRoot,
      paths.pageSvg,
      pagePlan.verified ? pagePlanResult.value : undefined,
    ),
    probeDirectory(paths.assets),
    probeResearch(paths.research),
  ]);

  const deckResult = validateJsonArtifact(paths.deck, deckContent, presentationSchema);
  const deck =
    deckResult.probe.verified && deckResult.value?.slides.length === 0
      ? {
          path: paths.deck,
          status: "default" as const,
          verified: false,
          reason: "Presentation snapshot contains no applied slides.",
        }
      : deckResult.probe;

  const exportResult = validateJsonArtifact(
    paths.exportHistory,
    exportHistoryContent,
    deckExportHistoryFileSchema,
  );
  const exportHistory =
    exportResult.probe.verified && exportResult.value?.exports.length === 0
      ? {
          path: paths.exportHistory,
          status: "default" as const,
          verified: false,
          reason: "No export has been recorded.",
        }
      : exportResult.probe;

  return {
    designSpec: designSpecResult.probe,
    templatePolicy,
    templatePack,
    pagePlan,
    pageSvg,
    assets,
    deck,
    exportHistory,
    brief: validateBriefContent(paths.brief, briefContent),
    outline: validateOutlineContent(paths.outline, outlineContent),
    research,
  };
}

/** Probe current workspace files; lifecycle completion is projected from PptJob, not these booleans. */
export async function probeWorkspaceArtifacts(workspaceRoot?: string): Promise<WorkspaceArtifacts> {
  if (!workspaceRoot) return { ...EMPTY_ARTIFACTS };

  const details = await probeWorkspaceArtifactDetails(workspaceRoot);
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
