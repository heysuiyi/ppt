import type { ProjectFileEditorReadResult, ProjectFileEditorWriteResult } from "@app/shared/ipc";
import type { ProjectArtifact } from "@shared/session";

const BINARY_FILE_EXTENSIONS = new Set([
  "7z",
  "avi",
  "bin",
  "bmp",
  "doc",
  "docx",
  "eot",
  "gif",
  "gz",
  "ico",
  "jpeg",
  "jpg",
  "mov",
  "mp3",
  "mp4",
  "otf",
  "pdf",
  "ppt",
  "pptx",
  "rar",
  "tar",
  "tif",
  "tiff",
  "ttf",
  "wav",
  "webm",
  "webp",
  "woff",
  "woff2",
  "xls",
  "xlsx",
  "zip",
]);

export interface ProjectFileGroup {
  id: string;
  title: string;
  rootPath: string;
  files: string[];
}

function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function artifactContainsPath(artifact: ProjectArtifact, path: string): boolean {
  const normalizedArtifactPath = normalizeProjectPath(artifact.path);
  const normalizedPath = normalizeProjectPath(path);
  return artifact.path.endsWith("/")
    ? normalizedPath.startsWith(`${normalizedArtifactPath}/`)
    : normalizedPath === normalizedArtifactPath;
}

export function groupProjectFiles(
  paths: readonly string[],
  artifacts: readonly ProjectArtifact[],
): ProjectFileGroup[] {
  const normalizedPaths = [...new Set(paths.map(normalizeProjectPath).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
  const filesByArtifact = new Map(artifacts.map((artifact) => [artifact.id, [] as string[]]));
  const otherFiles: string[] = [];

  for (const path of normalizedPaths) {
    const artifact = artifacts.find((candidate) => artifactContainsPath(candidate, path));
    if (!artifact) {
      otherFiles.push(path);
      continue;
    }
    filesByArtifact.get(artifact.id)?.push(path);
  }

  const groups: ProjectFileGroup[] = artifacts.map((artifact) => ({
    id: artifact.id,
    title: artifact.title,
    rootPath: normalizeProjectPath(artifact.path),
    files: filesByArtifact.get(artifact.id) ?? [],
  }));
  if (otherFiles.length > 0) {
    groups.push({
      id: "__other__",
      title: "其他项目文件",
      rootPath: "",
      files: otherFiles,
    });
  }
  return groups;
}

export function isBinaryProjectFile(path: string): boolean {
  const fileName = normalizeProjectPath(path).split("/").at(-1) ?? "";
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex <= 0 || extensionIndex === fileName.length - 1) return false;
  return BINARY_FILE_EXTENSIONS.has(fileName.slice(extensionIndex + 1).toLowerCase());
}

export function formatProjectFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function projectFileErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "项目文件操作失败，请重试。";
}

export function projectFileRequiresReload(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (code === "STALE_FILE") return true;

  const message = projectFileErrorMessage(error);
  return /stale|conflict|changed|read it again|expected_version|edit session.+(?:missing|expired|match)/i.test(
    message,
  );
}

export function reconcileProjectFileSave(
  previous: ProjectFileEditorReadResult,
  result: ProjectFileEditorWriteResult,
  savedContent: string,
  latestDraft: string,
): {
  openedFile: ProjectFileEditorReadResult;
  draft: string;
  dirty: boolean;
} {
  return {
    openedFile: {
      path: result.path,
      content: savedContent,
      version: result.version,
      mtimeMs: result.mtimeMs,
      size: result.size,
      encoding: result.encoding,
      newline: result.newline,
      editToken: result.editToken,
      editable: previous.editable,
      readOnlyReason: previous.readOnlyReason,
    },
    draft: latestDraft,
    dirty: latestDraft !== savedContent,
  };
}

export function confirmProjectFileNavigation(
  dirty: boolean,
  confirmDiscard: () => boolean,
): boolean {
  return !dirty || confirmDiscard();
}
