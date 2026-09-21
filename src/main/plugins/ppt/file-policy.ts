import { posix } from "node:path";
import type { WorkspaceFilePolicy } from "../../agent/tools/files/workspace-file-policy";
import {
  WorkspaceFileError,
  type WorkspaceFileService,
} from "../../agent/tools/files/workspace-file-service";
import type { PptLifecycleToolBridge } from "../../agent/tools/tool-definition";
import { assertDesignSpecMatchesTemplatePolicy } from "./tools/project-template-state";
import {
  isSvgDeckLockPath,
  SVG_DECK_DESIGN_SPEC_PATH,
  type SvgDeckDesignSpec,
  validateSvgDeckLockContent,
} from "./tools/svg-deck-locks";

export function createPptFilePolicy(
  lifecycle?: Pick<PptLifecycleToolBridge, "observeArtifactChanges">,
): WorkspaceFilePolicy {
  return {
    requiresContentValidation: isSvgDeckLockPath,
    validateContent,
    observe: lifecycle ? (input) => lifecycle.observeArtifactChanges(input) : undefined,
  };
}

export function isPresentationOwnedWorkspacePath(input: string): boolean {
  const path = posix.normalize(input.replace(/\\/g, "/")).replace(/^\.\//, "").toLowerCase();
  return (
    path === "design/design-spec.json" ||
    path === "slides/page-plan.json" ||
    path === "slides/storyboard.json" ||
    path === "deck/snapshot.json" ||
    path.startsWith("slides/svg/") ||
    path.startsWith("assets/")
  );
}

async function validateContent(
  path: string,
  content: string,
  fileService: WorkspaceFileService,
): Promise<void> {
  if (!isSvgDeckLockPath(path)) return;
  try {
    const validated = validateSvgDeckLockContent(path, content);
    const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalized === SVG_DECK_DESIGN_SPEC_PATH) {
      await assertDesignSpecMatchesTemplatePolicy(fileService, validated as SvgDeckDesignSpec);
    }
  } catch (error) {
    throw new WorkspaceFileError(
      "LOCK_SCHEMA_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
}
