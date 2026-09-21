import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { hashArtifactValue, hashBytes } from "@ppt/core/artifact-hash";
import type {
  ArtifactPointer,
  ArtifactRevision,
  ContentHash,
} from "@shared/presentation-lifecycle";
import { WorkspaceFileService } from "../agent/tools/files/workspace-file-service";
import { loadWorkspaceSvgPage } from "../plugins/ppt/svg-page-loader";
import type {
  ArtifactChangeObserverPort,
  ObserveArtifactChangesInput,
} from "./artifact-change-observer-types";
import type { PresentationLifecycleOrchestrator } from "./presentation-lifecycle-orchestrator";

const DESIGN_SPEC_PATH = "design/design-spec.json";
const PAGE_PLAN_PATH = "slides/page-plan.json";

type ObservableArtifactKind = "design_spec" | "page_plan" | "source_asset" | "page_svg";

interface ObservableHead {
  pointer: ArtifactPointer;
  revision: ArtifactRevision;
  sourcePath: string;
}

interface FileObservation {
  changed: boolean;
  contentHash: ContentHash;
  detail?: string;
}

/**
 * Re-checks committed authoring sources only at explicit read/write/probe
 * boundaries. It deliberately owns no watcher and never creates revisions:
 * changed files only invalidate the immutable revision that proved the old
 * bytes, then repository dependencies determine the exact downstream set.
 */
export class PresentationArtifactChangeObserver implements ArtifactChangeObserverPort {
  constructor(private readonly orchestrator: PresentationLifecycleOrchestrator) {}

  async observe(input: ObserveArtifactChangesInput): Promise<void> {
    const initial = this.orchestrator.getState(input.presentationId);
    if (!initial) return;
    const requestedPaths = normalizeRequestedPaths(input.paths);
    const heads = initial.committedArtifacts
      .map((pointer) => this.toObservableHead(pointer))
      .filter((head): head is ObservableHead => Boolean(head))
      .filter(
        (head) =>
          requestedPaths.length === 0 ||
          requestedPaths.some((requested) => requested.matches(head.sourcePath)),
      )
      .sort(
        (left, right) =>
          observationOrder(left.revision.kind) - observationOrder(right.revision.kind),
      );
    if (heads.length === 0) return;

    const workspaceRoot = resolve(input.workspaceRoot);
    const fileService = new WorkspaceFileService(workspaceRoot);
    for (const head of heads) {
      const observation = await observeHead(workspaceRoot, fileService, head);
      if (!observation.changed) continue;
      const reason = observation.detail
        ? `${head.sourcePath} no longer matches committed revision ` +
          `${head.pointer.revisionId}: ${observation.detail}`
        : `${head.sourcePath} no longer matches committed revision ` +
          `${head.pointer.revisionId}.`;
      this.orchestrator.markArtifactSourceChanged({
        jobId: initial.jobId,
        artifactId: head.pointer.artifactId,
        expectedRevisionId: head.pointer.revisionId,
        observedContentHash: observation.contentHash,
        reason,
        waitForUser:
          input.source === "project_read" ||
          input.source === "project_edit" ||
          input.source === "preview" ||
          input.source === "submit",
        detectedAt: input.detectedAt,
      });
    }
  }

  private toObservableHead(pointer: ArtifactPointer): ObservableHead | undefined {
    if (!isObservableKind(pointer.kind)) return undefined;
    const revision = this.orchestrator.repository.getArtifactRevision(pointer.revisionId);
    if (!revision || revision.kind !== pointer.kind) return undefined;
    const sourcePath = sourcePathFor(revision);
    return sourcePath ? { pointer, revision, sourcePath } : undefined;
  }
}

async function observeHead(
  workspaceRoot: string,
  fileService: WorkspaceFileService,
  head: ObservableHead,
): Promise<FileObservation> {
  try {
    if (head.revision.kind === "design_spec" || head.revision.kind === "page_plan") {
      const bytes = await readContainedFile(workspaceRoot, head.sourcePath);
      let contentHash: ContentHash;
      try {
        contentHash = hashArtifactValue(JSON.parse(bytes.toString("utf8")));
      } catch {
        contentHash = hashBytes(bytes);
      }
      return {
        changed: contentHash !== head.revision.contentHash,
        contentHash,
      };
    }

    if (head.revision.kind === "source_asset") {
      const bytes = await readContainedFile(workspaceRoot, head.sourcePath);
      const contentHash = hashBytes(bytes);
      const expected = rawContentHash(head.revision);
      return {
        changed: !expected || contentHash !== expected,
        contentHash,
      };
    }

    const page = await loadWorkspaceSvgPage({
      requestedPath: head.sourcePath,
      workspaceRoot,
      fileService,
    });
    const contentHash = hashBytes(Buffer.from(page.markup, "utf8"));
    const expected = rawContentHash(head.revision);
    return {
      changed: !expected || contentHash !== expected,
      contentHash,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      changed: true,
      contentHash: hashArtifactValue({
        unavailableSource: head.sourcePath,
        detail,
      }),
      detail,
    };
  }
}

async function readContainedFile(workspaceRoot: string, sourcePath: string): Promise<Buffer> {
  const absolutePath = resolve(workspaceRoot, sourcePath);
  assertContained(workspaceRoot, absolutePath, sourcePath);
  const stats = await lstat(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Lifecycle source is not a regular file: ${sourcePath}`);
  }
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(workspaceRoot),
    realpath(absolutePath),
  ]);
  assertContained(canonicalRoot, canonicalPath, sourcePath);
  return readFile(canonicalPath);
}

function assertContained(root: string, target: string, sourcePath: string): void {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`Lifecycle source is outside the workspace: ${sourcePath}`);
  }
}

function rawContentHash(revision: ArtifactRevision): ContentHash | undefined {
  if (
    typeof revision.value !== "object" ||
    revision.value === null ||
    !("sha256" in revision.value) ||
    typeof revision.value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(revision.value.sha256)
  ) {
    return undefined;
  }
  return `sha256:${revision.value.sha256}` as ContentHash;
}

function sourcePathFor(revision: ArtifactRevision): string | undefined {
  if (revision.kind === "design_spec") return DESIGN_SPEC_PATH;
  if (revision.kind === "page_plan") return PAGE_PLAN_PATH;
  if (
    typeof revision.value === "object" &&
    revision.value !== null &&
    "sourcePath" in revision.value &&
    typeof revision.value.sourcePath === "string"
  ) {
    if (revision.value.sourcePath.startsWith("embedded:")) {
      return undefined;
    }
    return normalizeWorkspacePath(revision.value.sourcePath);
  }
  return undefined;
}

function isObservableKind(kind: ArtifactPointer["kind"]): kind is ObservableArtifactKind {
  return (
    kind === "design_spec" || kind === "page_plan" || kind === "source_asset" || kind === "page_svg"
  );
}

function observationOrder(kind: ArtifactPointer["kind"]): number {
  if (kind === "source_asset") return 0;
  if (kind === "page_svg") return 1;
  if (kind === "page_plan") return 2;
  if (kind === "design_spec") return 3;
  return 4;
}

function normalizeRequestedPaths(
  paths: readonly string[] | undefined,
): Array<{ matches: (sourcePath: string) => boolean }> {
  return (paths ?? []).map((path) => {
    const directory = /[\\/]$/.test(path);
    const normalized = normalizeWorkspacePath(path);
    return {
      matches: (sourcePath: string) =>
        sourcePath === normalized || (directory && sourcePath.startsWith(`${normalized}/`)),
    };
  });
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}
