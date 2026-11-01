import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../app/renderer/src/components/project-store";
import {
  asPptCapabilityRequestId,
  asPptJobId,
  asPresentationId,
  asProposalId,
  type PptJobProjection,
} from "../src/shared/presentation-lifecycle";

const mockDesktopApi = {
  listProjectFiles: vi.fn(),
  readProjectArtifact: vi.fn(),
  openProjectFile: vi.fn(),
  saveProjectFile: vi.fn(),
  getPptJob: vi.fn(),
  onPptJobChanged: vi.fn(),
};

const FILE_VERSION = `sha256:${"a".repeat(64)}`;
const ALL_ARTIFACT_FILES = [
  "design/design-spec.json",
  "slides/page-plan.json",
  "slides/svg/.gitkeep",
  "assets/.gitkeep",
  "deck/snapshot.json",
  "history/exports.json",
  "brief.md",
  "outline.md",
  "research/notes.md",
];

function pptJobProjection(overrides: Partial<PptJobProjection> = {}): PptJobProjection {
  return {
    jobId: asPptJobId("job-1"),
    presentationId: asPresentationId("presentation-1"),
    capability: "create",
    requestId: asPptCapabilityRequestId("request-1"),
    status: "running",
    stage: "page_svg",
    stateRevision: 2,
    committedArtifacts: [],
    staleArtifacts: [],
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

function openedProjectFile(
  path: string,
  content: string,
  version = FILE_VERSION,
  editToken = "11111111-1111-4111-8111-111111111111",
) {
  return {
    path,
    content,
    version,
    mtimeMs: 1,
    size: content.length,
    encoding: "utf8" as const,
    newline: content.includes("\n") ? ("lf" as const) : ("none" as const),
    editToken,
    editable: true,
  };
}

beforeAll(() => {
  global.window = {
    desktopApi: mockDesktopApi,
    clearTimeout: (timer: any) => clearTimeout(timer),
    setTimeout: (cb: any, ms: any) => setTimeout(cb, ms),
  } as any;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  useProjectStore.getState().resetProject();
});

describe("project-store zustand store", () => {
  it("initializes project correctly", () => {
    const store = useProjectStore.getState();
    store.initializeProject("test-session", "Test Project");

    const state = useProjectStore.getState();
    expect(state.activeProject).not.toBeNull();
    expect(state.activeProject?.id).toBe("test-session");
    expect(state.activeProject?.name).toBe("Test Project");

    const briefArtifact = state.activeProject?.artifacts.brief;
    expect(briefArtifact?.id).toBe("brief");
    expect(briefArtifact?.isHydrated).toBe(false);
    expect(briefArtifact?.content).toContain("演示文稿 Brief");
  });

  it("initializes all artifact shells with default template content", () => {
    const store = useProjectStore.getState();
    store.initializeProject("test-session", "Test Project");

    const state = useProjectStore.getState();
    expect(state.activeProject?.artifacts.outline.content).toContain("演示大纲");
    expect(state.activeProject?.artifacts.deck.content).toContain("新演示文稿");
  });

  it("hydrates project artifacts correctly from backend", async () => {
    mockDesktopApi.listProjectFiles.mockResolvedValue(ALL_ARTIFACT_FILES);
    mockDesktopApi.readProjectArtifact.mockImplementation(async (_sessionId, path) => {
      if (path === "brief.md") {
        return { type: "file", content: "# Custom Brief Content" };
      }
      if (path === "outline.md") {
        return { type: "file", content: "# Custom Outline Content" };
      }
      return { type: "file", content: "" };
    });

    const store = useProjectStore.getState();
    store.initializeProject("test-session", "Test Project");
    await store.hydrateProjectArtifacts("test-session");

    const state = useProjectStore.getState();
    const brief = state.activeProject?.artifacts.brief;
    const outline = state.activeProject?.artifacts.outline;

    expect(brief?.content).toBe("# Custom Brief Content");
    expect(brief?.isHydrated).toBe(true);
    expect(outline?.content).toBe("# Custom Outline Content");
    expect(outline?.isHydrated).toBe(true);
    expect(mockDesktopApi.listProjectFiles).toHaveBeenCalledWith("test-session");
    expect(mockDesktopApi.readProjectArtifact).toHaveBeenCalledTimes(9);
  });

  it("skips optional workflow artifacts that do not exist yet", async () => {
    mockDesktopApi.listProjectFiles.mockResolvedValue(
      ALL_ARTIFACT_FILES.filter(
        (path) => path !== "design/design-spec.json" && path !== "slides/page-plan.json",
      ),
    );
    mockDesktopApi.readProjectArtifact.mockResolvedValue({ type: "file", content: "" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const store = useProjectStore.getState();
      store.initializeProject("test-session", "Test Project");
      await store.hydrateProjectArtifacts("test-session");

      const state = useProjectStore.getState();
      expect(state.activeProject?.artifacts["design-spec"].isHydrated).toBe(false);
      expect(state.activeProject?.artifacts["page-plan"].isHydrated).toBe(false);
      expect(mockDesktopApi.readProjectArtifact).not.toHaveBeenCalledWith(
        "test-session",
        "design/design-spec.json",
      );
      expect(mockDesktopApi.readProjectArtifact).not.toHaveBeenCalledWith(
        "test-session",
        "slides/page-plan.json",
      );
      expect(mockDesktopApi.readProjectArtifact).toHaveBeenCalledTimes(7);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("still reports a real read failure for an artifact that exists", async () => {
    mockDesktopApi.listProjectFiles.mockResolvedValue(["brief.md"]);
    const readError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    mockDesktopApi.readProjectArtifact.mockRejectedValue(readError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const store = useProjectStore.getState();
      store.initializeProject("test-session", "Test Project");
      await store.hydrateProjectArtifacts("test-session");

      expect(mockDesktopApi.readProjectArtifact).toHaveBeenCalledWith("test-session", "brief.md");
      expect(consoleError).toHaveBeenCalledWith("读取项目产物失败: brief.md", readError);
      expect(useProjectStore.getState().activeProject?.artifacts.brief.isHydrated).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("autosaves artifact content without manufacturing workflow status", async () => {
    vi.useFakeTimers();

    const store = useProjectStore.getState();
    store.initializeProject("test-session", "Test Project");
    mockDesktopApi.openProjectFile.mockResolvedValue(
      openedProjectFile("brief.md", "# Previous Brief"),
    );
    mockDesktopApi.saveProjectFile.mockResolvedValue({
      path: "brief.md",
      changed: true,
      changedArtifactId: "brief",
      version: `sha256:${"b".repeat(64)}`,
      mtimeMs: 2,
      size: 19,
      encoding: "utf8",
      newline: "none",
      characterCount: 19,
      editToken: "11111111-1111-4111-8111-111111111111",
    });

    store.updateArtifactContent("brief", "# New Brief Content", "user");

    let state = useProjectStore.getState();
    expect(state.activeProject?.artifacts.brief.content).toBe("# New Brief Content");
    expect(state.activeProject?.artifacts.brief).not.toHaveProperty("status");
    expect(state.activeProject?.artifacts.outline).not.toHaveProperty("status");

    vi.advanceTimersByTime(400);
    await vi.runAllTimersAsync();

    expect(mockDesktopApi.openProjectFile).toHaveBeenCalledWith("test-session", "brief.md");
    expect(mockDesktopApi.saveProjectFile).toHaveBeenCalledWith(
      "test-session",
      "brief.md",
      "# New Brief Content",
      "11111111-1111-4111-8111-111111111111",
      FILE_VERSION,
    );

    state = useProjectStore.getState();
    expect(state.activeProject?.artifacts.brief.lastWriteError).toBeUndefined();
  });

  it("hydrates and updates the current lifecycle projection independently of chat status", async () => {
    const initial = pptJobProjection();
    mockDesktopApi.getPptJob.mockResolvedValue(initial);

    const store = useProjectStore.getState();
    store.initializeProject("test-session", "Test Project", undefined, "presentation-1");
    await store.hydratePptJob("test-session");

    expect(mockDesktopApi.getPptJob).toHaveBeenCalledWith("test-session");
    expect(useProjectStore.getState().pptJob).toEqual(initial);

    store.applyPptJobProjection(
      pptJobProjection({
        status: "waiting_user",
        stage: "preview",
        stateRevision: 3,
        waitingReason: "请确认预览",
      }),
    );
    expect(useProjectStore.getState().pptJob).toMatchObject({
      status: "waiting_user",
      stage: "preview",
      waitingReason: "请确认预览",
    });

    store.applyPptJobProjection(
      pptJobProjection({
        status: "running",
        stateRevision: 1,
      }),
    );
    expect(useProjectStore.getState().pptJob?.stateRevision).toBe(3);

    store.applyPptJobProjection(
      pptJobProjection({
        presentationId: asPresentationId("other-presentation"),
        status: "failed",
        stateRevision: 4,
      }),
    );
    expect(useProjectStore.getState().pptJob?.status).toBe("waiting_user");
  });

  it("does not let an older hydration response replace a newer change projection", async () => {
    let resolveHydration!: (projection: PptJobProjection | undefined) => void;
    mockDesktopApi.getPptJob.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHydration = resolve;
      }),
    );

    const store = useProjectStore.getState();
    store.initializeProject("test-session", "Test Project", undefined, "presentation-1");
    const hydration = store.hydratePptJob("test-session");

    store.applyPptJobProjection(
      pptJobProjection({
        status: "waiting_approval",
        stage: "proposal",
        stateRevision: 3,
        proposalId: asProposalId("proposal-3"),
      }),
    );
    resolveHydration(
      pptJobProjection({
        status: "running",
        stage: "intent",
        stateRevision: 1,
      }),
    );
    await hydration;

    expect(useProjectStore.getState()).toMatchObject({
      pptJobLoading: false,
      pptJob: {
        status: "waiting_approval",
        stage: "proposal",
        stateRevision: 3,
        proposalId: "proposal-3",
      },
    });
  });

  it("ignores a hydration projection that belongs to another presentation", async () => {
    mockDesktopApi.getPptJob.mockResolvedValueOnce(
      pptJobProjection({
        presentationId: asPresentationId("other-presentation"),
      }),
    );

    const store = useProjectStore.getState();
    store.initializeProject("test-session", "Test Project", undefined, "presentation-1");
    await store.hydratePptJob("test-session");

    expect(useProjectStore.getState()).toMatchObject({
      pptJob: null,
      pptJobLoading: false,
      pptJobError: undefined,
    });
  });

  it("opens each autosave baseline and uses the next receipt for continued edits", async () => {
    vi.useFakeTimers();
    const nextVersion = `sha256:${"b".repeat(64)}`;
    const firstToken = "11111111-1111-4111-8111-111111111111";
    const secondToken = "22222222-2222-4222-8222-222222222222";
    mockDesktopApi.openProjectFile
      .mockResolvedValueOnce(openedProjectFile("brief.md", "# Disk\n", FILE_VERSION, firstToken))
      .mockResolvedValueOnce(openedProjectFile("brief.md", "# First\n", nextVersion, secondToken));
    mockDesktopApi.saveProjectFile
      .mockResolvedValueOnce({
        path: "brief.md",
        changed: true,
        changedArtifactId: "brief",
        version: nextVersion,
        mtimeMs: 2,
        size: 8,
        encoding: "utf8",
        newline: "lf",
        characterCount: 8,
        editToken: firstToken,
      })
      .mockResolvedValueOnce({
        path: "brief.md",
        changed: true,
        changedArtifactId: "brief",
        version: `sha256:${"c".repeat(64)}`,
        mtimeMs: 3,
        size: 9,
        encoding: "utf8",
        newline: "lf",
        characterCount: 9,
        editToken: secondToken,
      });

    const store = useProjectStore.getState();
    store.initializeProject("test-session", "Test Project");
    store.updateArtifactContent("brief", "# First\n", "user");
    vi.advanceTimersByTime(400);
    await vi.runAllTimersAsync();

    useProjectStore.getState().updateArtifactContent("brief", "# Second\n", "user");
    vi.advanceTimersByTime(400);
    await vi.runAllTimersAsync();

    expect(mockDesktopApi.saveProjectFile).toHaveBeenNthCalledWith(
      1,
      "test-session",
      "brief.md",
      "# First\n",
      firstToken,
      FILE_VERSION,
    );
    expect(mockDesktopApi.saveProjectFile).toHaveBeenNthCalledWith(
      2,
      "test-session",
      "brief.md",
      "# Second\n",
      secondToken,
      nextVersion,
    );
  });

  it("keeps the current autosave draft and requires a reread after a conflict", async () => {
    vi.useFakeTimers();
    mockDesktopApi.openProjectFile.mockResolvedValue(
      openedProjectFile("brief.md", "# Disk baseline\n"),
    );
    mockDesktopApi.saveProjectFile.mockRejectedValue(
      Object.assign(new Error("stale editor version"), { code: "STALE_FILE" }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const store = useProjectStore.getState();
      store.initializeProject("test-session", "Test Project");
      store.updateArtifactContent("brief", "# Unsaved current draft\n", "user");
      vi.advanceTimersByTime(400);
      await vi.runAllTimersAsync();

      const brief = useProjectStore.getState().activeProject?.artifacts.brief;
      expect(brief?.content).toBe("# Unsaved current draft\n");
      expect(brief?.lastWriteError).toBe(
        "文件已在磁盘上变化，当前草稿已保留；请重新读取后再保存。",
      );
      expect(mockDesktopApi.saveProjectFile).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });
});
