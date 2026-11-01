import type { DesktopApi, ProjectFileEditorWriteResult } from "@app/shared/ipc";

export type ProjectFileMutationResult = Pick<
  ProjectFileEditorWriteResult,
  "path" | "changed" | "changedArtifactId"
> & {
  postCommitWarnings?: ProjectFileEditorWriteResult["postCommitWarnings"];
};

export async function saveExistingProjectFile(
  api: DesktopApi,
  sessionId: string,
  relativePath: string,
  content: string,
  expectedContent?: string,
): Promise<ProjectFileMutationResult> {
  const opened = await api.openProjectFile(sessionId, relativePath);
  if (!opened.editable) {
    throw new Error(opened.readOnlyReason ?? "This project file is read-only.");
  }
  if (expectedContent !== undefined && opened.content !== expectedContent) {
    throw Object.assign(
      new Error(
        `Project file changed after the proposed content was read: ${opened.path}. ` +
          "Reload it and create a new patch.",
      ),
      { code: "STALE_FILE" },
    );
  }
  if (opened.content === content) {
    return {
      path: opened.path,
      changed: false,
    };
  }
  return await api.saveProjectFile(
    sessionId,
    opened.path,
    content,
    opened.editToken,
    opened.version,
  );
}
