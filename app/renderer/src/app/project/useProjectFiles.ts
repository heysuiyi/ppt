import type { ArtifactDiff, ProjectFileEditorReadResult } from "@app/shared/ipc";
import type { ProjectArtifact } from "@shared/session";
import { useCallback, useEffect, useRef, useState } from "react";
import { useProjectStore } from "../../components/project-store";
import {
  isBinaryProjectFile,
  projectFileErrorMessage,
  projectFileRequiresReload,
  reconcileProjectFileSave,
} from "./projectFilesState";

export interface ProjectFilesController {
  artifacts: ProjectArtifact[];
  files: string[];
  selectedPath: string | null;
  openedFile: ProjectFileEditorReadResult | null;
  draft: string;
  diff: ArtifactDiff | null;
  dirty: boolean;
  binary: boolean;
  isLoadingProject: boolean;
  isOpening: boolean;
  isSaving: boolean;
  isLoadingDiff: boolean;
  error: string | null;
  requiresReload: boolean;
  refresh: () => Promise<void>;
  selectFile: (path: string) => Promise<void>;
  reloadSelected: () => Promise<void>;
  setDraft: (content: string) => void;
  discardDraft: () => void;
  requestDiff: () => Promise<void>;
  save: () => Promise<void>;
}

interface UseProjectFilesOptions {
  sessionId?: string;
  busy: boolean;
  notify: (message: string) => void;
}

function confirmDiscardDraft(): boolean {
  return window.confirm("当前文件有未保存修改。要放弃草稿并继续吗？");
}

export function useProjectFiles({
  sessionId,
  busy,
  notify,
}: UseProjectFilesOptions): ProjectFilesController {
  const [artifacts, setArtifacts] = useState<ProjectArtifact[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [openedFile, setOpenedFile] = useState<ProjectFileEditorReadResult | null>(null);
  const [draft, setDraftState] = useState("");
  const [diff, setDiff] = useState<ArtifactDiff | null>(null);
  const [isLoadingProject, setIsLoadingProject] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requiresReload, setRequiresReload] = useState(false);

  const sessionRef = useRef(sessionId);
  const selectedPathRef = useRef<string | null>(null);
  const openedFileRef = useRef<ProjectFileEditorReadResult | null>(null);
  const draftRef = useRef("");
  const dirtyRef = useRef(false);
  const listRequestRef = useRef(0);
  const openRequestRef = useRef(0);
  const saveRequestRef = useRef(0);
  const diffRequestRef = useRef(0);

  sessionRef.current = sessionId;
  selectedPathRef.current = selectedPath;
  openedFileRef.current = openedFile;
  draftRef.current = draft;
  dirtyRef.current = Boolean(openedFile && draft !== openedFile.content);

  const invalidateFileRequests = useCallback(() => {
    openRequestRef.current += 1;
    saveRequestRef.current += 1;
    diffRequestRef.current += 1;
  }, []);

  const clearSelection = useCallback(() => {
    invalidateFileRequests();
    selectedPathRef.current = null;
    openedFileRef.current = null;
    draftRef.current = "";
    dirtyRef.current = false;
    setSelectedPath(null);
    setOpenedFile(null);
    setDraftState("");
    setDiff(null);
    setIsOpening(false);
    setIsSaving(false);
    setIsLoadingDiff(false);
    setRequiresReload(false);
  }, [invalidateFileRequests]);

  const loadProjectIndex = useCallback(
    async (targetSessionId: string, showLoading: boolean, reportError = true): Promise<boolean> => {
      const requestId = ++listRequestRef.current;
      if (showLoading) setIsLoadingProject(true);
      setError(null);

      try {
        const [nextFiles, nextArtifacts] = await Promise.all([
          window.desktopApi.listProjectFiles(targetSessionId),
          window.desktopApi.listProjectArtifacts(targetSessionId),
        ]);
        if (sessionRef.current !== targetSessionId || listRequestRef.current !== requestId)
          return false;

        setFiles(nextFiles);
        setArtifacts(nextArtifacts);
        const currentPath = selectedPathRef.current;
        if (currentPath && !nextFiles.includes(currentPath) && !dirtyRef.current) {
          clearSelection();
        }
        return true;
      } catch (nextError) {
        if (sessionRef.current !== targetSessionId || listRequestRef.current !== requestId)
          return false;
        if (!reportError) throw nextError;
        setError(projectFileErrorMessage(nextError));
        return false;
      } finally {
        if (sessionRef.current === targetSessionId && listRequestRef.current === requestId) {
          setIsLoadingProject(false);
        }
      }
    },
    [clearSelection],
  );

  useEffect(() => {
    listRequestRef.current += 1;
    invalidateFileRequests();
    setArtifacts([]);
    setFiles([]);
    clearSelection();
    setError(null);
    setIsLoadingProject(false);

    if (!sessionId) return;
    void loadProjectIndex(sessionId, true);
  }, [clearSelection, invalidateFileRequests, loadProjectIndex, sessionId]);

  const refresh = useCallback(async () => {
    const targetSessionId = sessionRef.current;
    if (!targetSessionId) return;
    await loadProjectIndex(targetSessionId, true);
  }, [loadProjectIndex]);

  const openFile = useCallback(
    async (path: string, shouldConfirmDiscard: boolean) => {
      const targetSessionId = sessionRef.current;
      if (!targetSessionId) return;

      const switchingFiles = selectedPathRef.current !== path;
      if (shouldConfirmDiscard && switchingFiles && dirtyRef.current && !confirmDiscardDraft()) {
        return;
      }

      invalidateFileRequests();
      const requestId = ++openRequestRef.current;
      selectedPathRef.current = path;
      openedFileRef.current = null;
      draftRef.current = "";
      dirtyRef.current = false;
      setSelectedPath(path);
      setOpenedFile(null);
      setDraftState("");
      setDiff(null);
      setError(null);
      setRequiresReload(false);

      if (isBinaryProjectFile(path)) {
        setIsOpening(false);
        return;
      }

      setIsOpening(true);
      try {
        const result = await window.desktopApi.openProjectFile(targetSessionId, path);
        if (
          sessionRef.current !== targetSessionId ||
          openRequestRef.current !== requestId ||
          selectedPathRef.current !== path
        )
          return;

        openedFileRef.current = result;
        draftRef.current = result.content;
        setOpenedFile(result);
        setDraftState(result.content);
      } catch (nextError) {
        if (
          sessionRef.current !== targetSessionId ||
          openRequestRef.current !== requestId ||
          selectedPathRef.current !== path
        )
          return;
        setError(projectFileErrorMessage(nextError));
      } finally {
        if (
          sessionRef.current === targetSessionId &&
          openRequestRef.current === requestId &&
          selectedPathRef.current === path
        ) {
          setIsOpening(false);
        }
      }
    },
    [invalidateFileRequests],
  );

  const selectFile = useCallback(
    async (path: string) => {
      if (selectedPathRef.current === path && openedFileRef.current) return;
      await openFile(path, true);
    },
    [openFile],
  );

  const reloadSelected = useCallback(async () => {
    const path = selectedPathRef.current;
    if (!path) return;
    if (dirtyRef.current && !confirmDiscardDraft()) return;
    await openFile(path, false);
  }, [openFile]);

  const setDraft = useCallback((content: string) => {
    draftRef.current = content;
    dirtyRef.current = content !== openedFileRef.current?.content;
    setDraftState(content);
    setDiff(null);
    setError(null);
  }, []);

  const discardDraft = useCallback(() => {
    const currentFile = openedFileRef.current;
    if (!currentFile) return;
    draftRef.current = currentFile.content;
    dirtyRef.current = false;
    setDraftState(currentFile.content);
    setDiff(null);
    setError(null);
  }, []);

  const requestDiff = useCallback(async () => {
    const targetSessionId = sessionRef.current;
    const path = selectedPathRef.current;
    if (!targetSessionId || !path || isBinaryProjectFile(path)) return;

    const nextContent = draftRef.current;
    const requestId = ++diffRequestRef.current;
    setIsLoadingDiff(true);
    setError(null);
    try {
      const result = await window.desktopApi.getProjectArtifactDiff(
        targetSessionId,
        path,
        nextContent,
      );
      if (
        sessionRef.current !== targetSessionId ||
        diffRequestRef.current !== requestId ||
        selectedPathRef.current !== path ||
        draftRef.current !== nextContent
      )
        return;
      setDiff(result);
    } catch (nextError) {
      if (
        sessionRef.current !== targetSessionId ||
        diffRequestRef.current !== requestId ||
        selectedPathRef.current !== path
      )
        return;
      setError(projectFileErrorMessage(nextError));
    } finally {
      if (
        sessionRef.current === targetSessionId &&
        diffRequestRef.current === requestId &&
        selectedPathRef.current === path
      ) {
        setIsLoadingDiff(false);
      }
    }
  }, []);

  const save = useCallback(async () => {
    const targetSessionId = sessionRef.current;
    const path = selectedPathRef.current;
    const currentFile = openedFileRef.current;
    const content = draftRef.current;
    if (
      !targetSessionId ||
      !path ||
      !currentFile ||
      busy ||
      requiresReload ||
      !currentFile.editable ||
      isBinaryProjectFile(path) ||
      content === currentFile.content
    )
      return;

    const requestId = ++saveRequestRef.current;
    const token = currentFile.editToken;
    const expectedVersion = currentFile.version;
    setIsSaving(true);
    setError(null);

    try {
      const result = await window.desktopApi.saveProjectFile(
        targetSessionId,
        path,
        content,
        token,
        expectedVersion,
      );
      if (
        sessionRef.current !== targetSessionId ||
        saveRequestRef.current !== requestId ||
        selectedPathRef.current !== path ||
        openedFileRef.current?.editToken !== token
      )
        return;

      const reconciled = reconcileProjectFileSave(currentFile, result, content, draftRef.current);
      openedFileRef.current = reconciled.openedFile;
      draftRef.current = reconciled.draft;
      dirtyRef.current = reconciled.dirty;
      setOpenedFile(reconciled.openedFile);
      setDraftState(reconciled.draft);
      setDiff(null);
      setRequiresReload(false);

      const postCommitWarnings: string[] = [];
      if (result.postCommitWarnings?.includes("session-state-persistence-failed")) {
        postCommitWarnings.push("会话状态未能持久化");
      }
      if (result.postCommitWarnings?.includes("workspace-metadata-sync-failed")) {
        postCommitWarnings.push("工作区元数据未能同步");
      }
      try {
        await Promise.all([
          loadProjectIndex(targetSessionId, false, false),
          useProjectStore.getState().hydrateProjectArtifacts(targetSessionId),
        ]);
      } catch (refreshError) {
        postCommitWarnings.push(`项目状态刷新失败：${projectFileErrorMessage(refreshError)}`);
      }
      if (sessionRef.current === targetSessionId && selectedPathRef.current === path) {
        if (postCommitWarnings.length > 0) {
          setError(`文件内容已保存，但${postCommitWarnings.join("；")}。`);
          notify("文件已保存，但部分项目状态需要稍后重试");
        } else {
          notify("项目文件已保存");
        }
      }
    } catch (nextError) {
      if (
        sessionRef.current !== targetSessionId ||
        saveRequestRef.current !== requestId ||
        selectedPathRef.current !== path
      )
        return;

      setRequiresReload(true);
      setError(
        projectFileRequiresReload(nextError)
          ? "文件已在磁盘上变化，草稿已保留。请查看差异后重新载入。"
          : `保存失败，草稿已保留；请重新载入后重试。${projectFileErrorMessage(nextError)}`,
      );
    } finally {
      if (
        sessionRef.current === targetSessionId &&
        saveRequestRef.current === requestId &&
        selectedPathRef.current === path
      ) {
        setIsSaving(false);
      }
    }
  }, [busy, loadProjectIndex, notify, requiresReload]);

  return {
    artifacts,
    files,
    selectedPath,
    openedFile,
    draft,
    diff,
    dirty: Boolean(openedFile && draft !== openedFile.content),
    binary: Boolean(selectedPath && isBinaryProjectFile(selectedPath)),
    isLoadingProject,
    isOpening,
    isSaving,
    isLoadingDiff,
    error,
    requiresReload,
    refresh,
    selectFile,
    reloadSelected,
    setDraft,
    discardDraft,
    requestDiff,
    save,
  };
}
