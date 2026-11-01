import { join } from "node:path";
import { createDefaultExportHistoryFile } from "@shared/deck-persistence";
import type { Presentation } from "@shared/presentation";
import { defaultProjectArtifacts } from "@shared/project";
import {
  createDefaultBriefMarkdown,
  createDefaultOutlineMarkdown,
  createDefaultResearchMarkdown,
} from "@shared/project-artifacts";
import type { ProjectSandbox, SessionSnapshot } from "@shared/session";
import { getBuiltinTemplate } from "@shared/template-catalog";
import {
  APPLICATION_DEFAULT_TEMPLATE_ID,
  createDefaultProjectTemplatePolicy,
  formatProjectTemplatePolicy,
} from "@shared/template-protocol";

export interface ProjectFileTemplate {
  path: string;
  content: string;
}

export interface CreateDefaultProjectFilesOptions {
  /** Application default template id snapshotted into new projects only. */
  defaultTemplateId?: string;
}

export function createProjectSandbox(
  snapshot: SessionSnapshot,
  projectRootPath: string,
): ProjectSandbox {
  const rootPath =
    snapshot.project?.rootPath ?? join(projectRootPath, `session-${snapshot.session.id}`);
  const artifacts = defaultProjectArtifacts.map((artifact) => ({ ...artifact }));

  return { rootPath, artifacts };
}

export function createDefaultProjectFiles(
  snapshot: SessionSnapshot,
  options: CreateDefaultProjectFilesOptions = {},
): ProjectFileTemplate[] {
  const requestedDefault = options.defaultTemplateId ?? APPLICATION_DEFAULT_TEMPLATE_ID;
  const resolved = getBuiltinTemplate(requestedDefault);
  const defaultTemplateId = resolved ? requestedDefault : APPLICATION_DEFAULT_TEMPLATE_ID;

  return [
    {
      path: "design/template-policy.json",
      content: formatProjectTemplatePolicy(createDefaultProjectTemplatePolicy(defaultTemplateId)),
    },
    {
      path: "brief.md",
      content: createBriefTemplate(snapshot.session.title),
    },
    {
      path: "outline.md",
      content: createOutlineTemplate(snapshot.session.title),
    },
    {
      path: "research/sources.md",
      content: createResearchSourcesTemplate(),
    },
    {
      path: "research/notes.md",
      content: createResearchNotesTemplate(),
    },
    {
      path: "research/assets/.gitkeep",
      content: "",
    },
    {
      path: "slides/svg/.gitkeep",
      content: "",
    },
    {
      path: "assets/.gitkeep",
      content: "",
    },
    {
      path: "deck/snapshot.json",
      content: `${JSON.stringify(snapshot.presentation, null, 2)}\n`,
    },
    {
      path: "history/exports.json",
      content: `${JSON.stringify(createExportHistoryTemplate(), null, 2)}\n`,
    },
  ];
}

export function createDeckSnapshotContent(presentation: Presentation): string {
  return `${JSON.stringify(presentation, null, 2)}\n`;
}

function createBriefTemplate(title: string): string {
  return createDefaultBriefMarkdown(title);
}

function createOutlineTemplate(title: string): string {
  return createDefaultOutlineMarkdown(title);
}

function createResearchSourcesTemplate(): string {
  return `# Sources

记录外部资料、链接、访谈、数据来源和使用约束。
`;
}

function createResearchNotesTemplate(): string {
  return createDefaultResearchMarkdown();
}

function createExportHistoryTemplate() {
  return createDefaultExportHistoryFile();
}
