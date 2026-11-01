import type { DesktopApi } from "@app/shared/ipc";
import type { PptJobProjection } from "@shared/presentation-lifecycle";
import {
  getPrimaryProjectArtifactPath,
  isProjectArtifactId,
  type ProjectArtifactId,
  primaryProjectArtifactPaths,
  projectArtifactIds,
} from "@shared/project";
import {
  createDefaultBriefMarkdown,
  createDefaultOutlineMarkdown,
  createDefaultResearchMarkdown,
} from "@shared/project-artifacts";
import type { ProjectArtifact } from "@shared/session";
import { create } from "zustand";
import { saveExistingProjectFile } from "../app/project/projectFileMutations";

export interface Artifact {
  id: ProjectArtifactId;
  name: string;
  path: string;
  content: string;
  lastUpdatedBy: "user" | "agent";
  updatedAt: number;
  isHydrated: boolean;
  lastWriteError?: string;
}

export interface ActiveProject {
  id: string;
  name: string;
  presentationId?: string;
  artifacts: Record<ProjectArtifactId, Artifact>;
  history: {
    commitId: string;
    timestamp: number;
    description: string;
    snapshot: Record<ProjectArtifactId, string>;
  }[];
}

interface ProjectState {
  activeProject: ActiveProject | null;
  pptJob: PptJobProjection | null;
  pptJobLoading: boolean;
  pptJobError?: string;

  initializeProject: (
    id: string,
    name: string,
    backendArtifacts?: ProjectArtifact[],
    presentationId?: string,
  ) => void;
  hydrateProjectArtifacts: (sessionId?: string) => Promise<void>;
  hydratePptJob: (sessionId?: string) => Promise<void>;
  applyPptJobProjection: (projection: PptJobProjection) => void;
  updateArtifactContent: (id: ProjectArtifactId, content: string, by?: "user" | "agent") => void;
  resetProject: () => void;
}

const ARTIFACT_NAMES: Record<ProjectArtifactId, string> = {
  "design-spec": "设计规范 (Design Spec)",
  "template-policy": "模板策略 (Template Policy)",
  "page-plan": "逐页规划 (Page Plan)",
  "page-svg": "页面 SVG",
  assets: "本地素材 (Assets)",
  deck: "已应用演示文稿 (Deck)",
  "export-history": "导出记录 (Export History)",
  brief: "可选资料 · Brief",
  outline: "可选资料 · Outline",
  research: "可选资料 · Research",
};

export const DEFAULT_CONTENTS: Record<ProjectArtifactId, string> = {
  "design-spec": "",
  "template-policy": "",
  "page-plan": "",
  "page-svg": "",
  assets: "",
  deck: JSON.stringify(
    {
      title: "新演示文稿",
      slides: [],
    },
    null,
    2,
  ),
  "export-history": JSON.stringify({ exports: [] }, null, 2),
  brief: createDefaultBriefMarkdown(),
  outline: createDefaultOutlineMarkdown(),
  research: createDefaultResearchMarkdown(),
};

const writeTimers = new Map<string, number>();

function getDesktopApi(): DesktopApi | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as unknown as { desktopApi: DesktopApi }).desktopApi;
}

function projectStoreWriteError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message =
    error instanceof Error && error.message.trim()
      ? error.message
      : typeof error === "string" && error.trim()
        ? error
        : "写入项目产物失败";
  if (
    code === "STALE_FILE" ||
    /stale|conflict|changed|read it again|expected_version|edit session.+(?:missing|expired|match)/i.test(
      message,
    )
  ) {
    return "文件已在磁盘上变化，当前草稿已保留；请重新读取后再保存。";
  }
  return message;
}

function createArtifactShell(
  id: ProjectArtifactId,
  backendArtifacts?: ProjectArtifact[],
): Artifact {
  const backend = backendArtifacts?.find((artifact) => artifact.id === id);
  return {
    id,
    name: backend?.title ?? ARTIFACT_NAMES[id],
    path: backend ? getPrimaryProjectArtifactPath(backend) : primaryProjectArtifactPaths[id],
    content: DEFAULT_CONTENTS[id],
    lastUpdatedBy: "user",
    updatedAt: Date.now(),
    isHydrated: false,
  };
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  activeProject: null,
  pptJob: null,
  pptJobLoading: false,
  pptJobError: undefined,

  initializeProject: (id, name, backendArtifacts, presentationId) => {
    const artifacts = Object.fromEntries(
      projectArtifactIds.map((artifactId) => [
        artifactId,
        createArtifactShell(artifactId, backendArtifacts),
      ]),
    ) as Record<ProjectArtifactId, Artifact>;

    set({
      activeProject: {
        id,
        name,
        presentationId,
        artifacts,
        history: [],
      },
      pptJob: null,
      pptJobLoading: false,
      pptJobError: undefined,
    });
  },

  hydrateProjectArtifacts: async (sessionId) => {
    const project = get().activeProject;
    const targetSessionId = sessionId ?? project?.id;
    const api = getDesktopApi();
    if (!project || !targetSessionId || targetSessionId === "draft_id" || !api) return;

    const projectFiles = await api.listProjectFiles(targetSessionId);
    const loadedEntries = await Promise.all(
      projectArtifactIds.map(async (artifactId) => {
        const artifact = get().activeProject?.artifacts[artifactId];
        if (!artifact) return [artifactId, undefined] as const;
        const exists = artifact.path.endsWith("/")
          ? projectFiles.some((path) => path.startsWith(artifact.path))
          : projectFiles.includes(artifact.path);
        if (!exists) return [artifactId, undefined] as const;
        try {
          const result = await api.readProjectArtifact(targetSessionId, artifact.path);
          return [artifactId, result.type === "file" ? (result.content ?? "") : ""] as const;
        } catch (error) {
          console.error(`读取项目产物失败: ${artifact.path}`, error);
          return [artifactId, undefined] as const;
        }
      }),
    );

    set((state) => {
      if (!state.activeProject || state.activeProject.id !== targetSessionId) return {};
      const artifacts = { ...state.activeProject.artifacts };
      for (const [artifactId, content] of loadedEntries) {
        if (content === undefined) continue;
        artifacts[artifactId] = {
          ...artifacts[artifactId],
          content,
          isHydrated: true,
          lastWriteError: undefined,
          updatedAt: Date.now(),
        };
      }
      return {
        activeProject: {
          ...state.activeProject,
          artifacts,
        },
      };
    });
  },

  updateArtifactContent: (id, content, by = "user") => {
    const project = get().activeProject;
    if (!project || !isProjectArtifactId(id)) return;
    const artifact = project.artifacts[id];

    set((state) => {
      if (!state.activeProject) return {};
      return {
        activeProject: {
          ...state.activeProject,
          artifacts: {
            ...state.activeProject.artifacts,
            [id]: {
              ...state.activeProject.artifacts[id],
              content,
              lastUpdatedBy: by,
              updatedAt: Date.now(),
              lastWriteError: undefined,
            },
          },
        },
      };
    });

    const api = getDesktopApi();
    if (!api || project.id === "draft_id") return;

    const timerKey = `${project.id}:${id}`;
    const existingTimer = writeTimers.get(timerKey);
    if (existingTimer) window.clearTimeout(existingTimer);

    writeTimers.set(
      timerKey,
      window.setTimeout(() => {
        writeTimers.delete(timerKey);
        void saveExistingProjectFile(api, project.id, artifact.path, content)
          .then(() => {
            set((state) => {
              if (!state.activeProject || state.activeProject.id !== project.id) return {};
              return {
                activeProject: {
                  ...state.activeProject,
                  artifacts: {
                    ...state.activeProject.artifacts,
                    [id]: {
                      ...state.activeProject.artifacts[id],
                      updatedAt: Date.now(),
                      lastWriteError: undefined,
                    },
                  },
                },
              };
            });
          })
          .catch((error: unknown) => {
            const message = projectStoreWriteError(error);
            console.error(`写入项目产物失败: ${artifact.path}`, error);
            set((state) => {
              if (!state.activeProject || state.activeProject.id !== project.id) return {};
              return {
                activeProject: {
                  ...state.activeProject,
                  artifacts: {
                    ...state.activeProject.artifacts,
                    [id]: {
                      ...state.activeProject.artifacts[id],
                      lastWriteError: message,
                    },
                  },
                },
              };
            });
          });
      }, 400),
    );
  },

  hydratePptJob: async (sessionId) => {
    const project = get().activeProject;
    const targetSessionId = sessionId ?? project?.id;
    const api = getDesktopApi();
    if (!project || !targetSessionId || targetSessionId === "draft_id" || !api) return;

    set({ pptJobLoading: true, pptJobError: undefined });
    try {
      const projection = await api.getPptJob(targetSessionId);
      set((state) => {
        if (!state.activeProject || state.activeProject.id !== targetSessionId) return {};
        if (
          projection &&
          state.activeProject.presentationId &&
          projection.presentationId !== state.activeProject.presentationId
        ) {
          return {
            pptJobLoading: false,
            pptJobError: undefined,
          };
        }
        if (
          state.pptJob &&
          (!projection ||
            (projection.presentationId === state.pptJob.presentationId &&
              projection.stateRevision < state.pptJob.stateRevision))
        ) {
          return {
            pptJobLoading: false,
            pptJobError: undefined,
          };
        }
        return {
          pptJob: projection ?? null,
          pptJobLoading: false,
          pptJobError: undefined,
        };
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim() ? error.message : "读取演示文稿生命周期失败";
      set((state) => {
        if (!state.activeProject || state.activeProject.id !== targetSessionId) return {};
        return {
          pptJobLoading: false,
          pptJobError: message,
        };
      });
      throw error;
    }
  },

  applyPptJobProjection: (projection) => {
    set((state) => {
      const project = state.activeProject;
      if (!project) return {};
      const matchesCurrentProject = project.presentationId
        ? projection.presentationId === project.presentationId
        : state.pptJob?.jobId === projection.jobId;
      if (!matchesCurrentProject) return {};
      if (state.pptJob && projection.stateRevision < state.pptJob.stateRevision) return {};
      return {
        pptJob: projection,
        pptJobLoading: false,
        pptJobError: undefined,
      };
    });
  },

  resetProject: () => {
    for (const timer of writeTimers.values()) {
      window.clearTimeout(timer);
    }
    writeTimers.clear();
    set({
      activeProject: null,
      pptJob: null,
      pptJobLoading: false,
      pptJobError: undefined,
    });
  },
}));
