import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectArtifactDiffRequestSchema,
  projectFileOpenRequestSchema,
  projectFileSaveRequestSchema,
} from "@app/shared/ipc";
import { FileSessionStore } from "@main/session-store";
import { afterEach, describe, expect, it, vi } from "vitest";

interface StoreFixture {
  store: FileSessionStore;
  databasePath: string;
  projectsPath: string;
  directory: string;
}

const temporaryDirectories: string[] = [];
const openStores = new Set<FileSessionStore>();

async function createStore(): Promise<StoreFixture> {
  const directory = await mkdtemp(join(tmpdir(), "ppt-project-file-editor-"));
  const databasePath = join(directory, "conversations.sqlite");
  const projectsPath = join(directory, "projects");
  const store = new FileSessionStore(databasePath, projectsPath);
  temporaryDirectories.push(directory);
  openStores.add(store);
  await store.initialize();
  return { store, databasePath, projectsPath, directory };
}

async function reopenStore(fixture: StoreFixture): Promise<StoreFixture> {
  fixture.store.close();
  openStores.delete(fixture.store);
  const store = new FileSessionStore(fixture.databasePath, fixture.projectsPath);
  openStores.add(store);
  await store.initialize();
  return { ...fixture, store };
}

async function createProject(
  fixture: StoreFixture,
  title = "Editable project",
): Promise<{ sessionId: string; rootPath: string }> {
  const created = await fixture.store.createSession({ title });
  const snapshot = created.activeSession!;
  return {
    sessionId: snapshot.session.id,
    rootPath: snapshot.project!.rootPath,
  };
}

function contentVersion(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

afterEach(async () => {
  for (const store of openStores) store.close();
  openStores.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("project file editor safety boundary", () => {
  it("lists every artifact child recursively, including nested history files", async () => {
    const fixture = await createStore();
    const { sessionId, rootPath } = await createProject(fixture);
    await mkdir(join(rootPath, "history", "versions"), { recursive: true });
    await writeFile(
      join(rootPath, "history", "versions", "001-initial.md"),
      "# Initial version\n",
      "utf8",
    );

    const files = await fixture.store.listProjectFiles(sessionId);
    const expectedFiles = [
      "assets/.gitkeep",
      "brief.md",
      "deck/snapshot.json",
      "design/template-policy.json",
      "history/exports.json",
      "history/versions/001-initial.md",
      "outline.md",
      "research/assets/.gitkeep",
      "research/notes.md",
      "research/sources.md",
      "slides/svg/.gitkeep",
    ];

    expect(new Set(files)).toEqual(new Set(expectedFiles));
    expect(files).toHaveLength(expectedFiles.length);
  });

  it("updates the receipt across saves without persisting workflow status", async () => {
    let fixture = await createStore();
    const { sessionId } = await createProject(fixture);

    const opened = await fixture.store.openProjectFile(sessionId, "brief.md");
    expect(opened).toMatchObject({
      path: "brief.md",
      editable: true,
      encoding: "utf8",
    });
    expect(opened.readOnlyReason).toBeUndefined();
    expect(opened.editToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(opened.version).toBe(contentVersion(opened.content));

    const firstContent = "# Revised brief\n\nFirst editor save.\n";
    const firstSave = await fixture.store.saveProjectFile(
      sessionId,
      "brief.md",
      firstContent,
      opened.editToken,
      opened.version,
    );
    expect(firstSave).toMatchObject({
      path: "brief.md",
      editToken: opened.editToken,
      changed: true,
      changedArtifactId: "brief",
      characterCount: firstContent.length,
    });
    expect(firstSave.version).toBe(contentVersion(firstContent));
    expect(firstSave.version).not.toBe(opened.version);

    const secondContent = `${firstContent}\nSecond editor save.\n`;
    const secondSave = await fixture.store.saveProjectFile(
      sessionId,
      "brief.md",
      secondContent,
      opened.editToken,
      firstSave.version,
    );
    expect(secondSave.version).toBe(contentVersion(secondContent));
    expect(secondSave.editToken).toBe(opened.editToken);
    expect((await fixture.store.openProjectFile(sessionId, "brief.md")).content).toBe(
      secondContent,
    );

    fixture = await reopenStore(fixture);
    expect(fixture.store.listProjectArtifacts(sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "design-spec" }),
        expect.objectContaining({ id: "page-plan" }),
        expect.objectContaining({ id: "page-svg" }),
        expect.objectContaining({ id: "assets" }),
        expect.objectContaining({ id: "deck" }),
        expect.objectContaining({ id: "export-history" }),
      ]),
    );
    expect(
      fixture.store.listProjectArtifacts(sessionId).every((artifact) => !("status" in artifact)),
    ).toBe(true);
    expect((await fixture.store.openProjectFile(sessionId, "brief.md")).content).toBe(
      secondContent,
    );
  });

  it("reports post-commit persistence failures without describing the file save as failed", async () => {
    const fixture = await createStore();
    const { sessionId, rootPath } = await createProject(fixture);
    const opened = await fixture.store.openProjectFile(sessionId, "brief.md");
    const committedContent = "# Committed with follow-up warnings\n";
    const storeInternals = fixture.store as unknown as {
      persist: () => Promise<void>;
      syncWorkspacePersistence: () => Promise<void>;
    };
    storeInternals.persist = async () => {
      throw new Error("database unavailable");
    };
    storeInternals.syncWorkspacePersistence = async () => {
      throw new Error("workspace metadata unavailable");
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await fixture.store.saveProjectFile(
        sessionId,
        "brief.md",
        committedContent,
        opened.editToken,
        opened.version,
      );
      expect(result.postCommitWarnings).toEqual([
        "session-state-persistence-failed",
        "workspace-metadata-sync-failed",
      ]);
      expect(await readFile(join(rootPath, "brief.md"), "utf8")).toBe(committedContent);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects a save after an external write without overwriting external content", async () => {
    const fixture = await createStore();
    const { sessionId, rootPath } = await createProject(fixture);
    const opened = await fixture.store.openProjectFile(sessionId, "outline.md");
    const externalContent = "# External outline\n\nExternal writer wins.\n";
    await writeFile(join(rootPath, "outline.md"), externalContent, "utf8");

    await expect(
      fixture.store.saveProjectFile(
        sessionId,
        "outline.md",
        "# Stale editor payload\n",
        opened.editToken,
        opened.version,
      ),
    ).rejects.toMatchObject({ code: "STALE_FILE" });
    expect(await readFile(join(rootPath, "outline.md"), "utf8")).toBe(externalContent);

    await expect(
      fixture.store.saveProjectFile(
        sessionId,
        "outline.md",
        "# Retry with consumed token\n",
        opened.editToken,
        opened.version,
      ),
    ).rejects.toThrow("edit session is missing");
    expect(await readFile(join(rootPath, "outline.md"), "utf8")).toBe(externalContent);
  });

  it("scopes edit tokens to one path and one project session", async () => {
    const fixture = await createStore();
    const first = await createProject(fixture, "First project");
    const second = await createProject(fixture, "Second project");
    const opened = await fixture.store.openProjectFile(first.sessionId, "brief.md");
    const firstOutlineBefore = await readFile(join(first.rootPath, "outline.md"), "utf8");
    const secondBriefBefore = await readFile(join(second.rootPath, "brief.md"), "utf8");

    await expect(
      fixture.store.saveProjectFile(
        first.sessionId,
        "outline.md",
        "# Wrong path\n",
        opened.editToken,
        opened.version,
      ),
    ).rejects.toThrow("does not match this file");
    await expect(
      fixture.store.saveProjectFile(
        second.sessionId,
        "brief.md",
        "# Wrong session\n",
        opened.editToken,
        opened.version,
      ),
    ).rejects.toThrow("does not match this file");

    expect(await readFile(join(first.rootPath, "outline.md"), "utf8")).toBe(firstOutlineBefore);
    expect(await readFile(join(second.rootPath, "brief.md"), "utf8")).toBe(secondBriefBefore);

    const validContent = "# First project only\n";
    await expect(
      fixture.store.saveProjectFile(
        first.sessionId,
        "brief.md",
        validContent,
        opened.editToken,
        opened.version,
      ),
    ).resolves.toMatchObject({
      path: "brief.md",
      version: contentVersion(validContent),
    });
    expect(await readFile(join(first.rootPath, "brief.md"), "utf8")).toBe(validContent);
    expect(await readFile(join(second.rootPath, "brief.md"), "utf8")).toBe(secondBriefBefore);
  }, 10_000);

  it("opens deck, export history, and unregistered files read-only and refuses their saves", async () => {
    const fixture = await createStore();
    const { sessionId, rootPath } = await createProject(fixture);
    await mkdir(join(rootPath, "misc"), { recursive: true });
    await writeFile(join(rootPath, "misc", "notes.md"), "# Unregistered\n", "utf8");

    for (const relativePath of ["deck/snapshot.json", "history/exports.json", "misc/notes.md"]) {
      const opened = await fixture.store.openProjectFile(sessionId, relativePath);
      const before = await readFile(join(rootPath, relativePath), "utf8");
      expect(opened.editable).toBe(false);
      expect(opened.readOnlyReason).toContain("只能预览");

      await expect(
        fixture.store.saveProjectFile(
          sessionId,
          relativePath,
          "must not be written",
          opened.editToken,
          opened.version,
        ),
      ).rejects.toThrow("只能预览");
      expect(await readFile(join(rootPath, relativePath), "utf8")).toBe(before);
    }
  });

  it("allows Renderer saves only for existing registered editable files", async () => {
    const fixture = await createStore();
    const { sessionId, rootPath } = await createProject(fixture);
    const editableContent = "# Canonical editor brief\n";
    const opened = await fixture.store.openProjectFile(sessionId, "brief.md");
    await expect(
      fixture.store.saveProjectFile(
        sessionId,
        "brief.md",
        editableContent,
        opened.editToken,
        opened.version,
      ),
    ).resolves.toMatchObject({
      path: "brief.md",
      changed: true,
      changedArtifactId: "brief",
    });
    expect(await readFile(join(rootPath, "brief.md"), "utf8")).toBe(editableContent);

    await expect(
      fixture.store.openProjectFile(sessionId, "misc/unregistered.md"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(rootPath, "misc", "unregistered.md"), "utf8")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("returns a diff against the complete current artifact content", async () => {
    const fixture = await createStore();
    const { sessionId, rootPath } = await createProject(fixture);
    const before = "# Brief\n\nKeep this line.\nReplace this line.\n";
    const after = "# Brief\n\nKeep this line.\nReplacement is visible.\n";
    await writeFile(join(rootPath, "brief.md"), before, "utf8");

    const diff = await fixture.store.getProjectArtifactDiff(sessionId, "brief.md", after);
    expect(diff).toMatchObject({
      path: "brief.md",
      before,
      after,
      changed: true,
    });
    expect(diff.unifiedDiff).toContain("--- a/brief.md");
    expect(diff.unifiedDiff).toContain("+++ b/brief.md");
    expect(diff.unifiedDiff).toContain("-Replace this line.");
    expect(diff.unifiedDiff).toContain("+Replacement is visible.");
  });

  it("expires an edit token after thirty minutes", async () => {
    const fixture = await createStore();
    const { sessionId, rootPath } = await createProject(fixture);
    const before = await readFile(join(rootPath, "brief.md"), "utf8");
    const openedAt = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(openedAt);

    try {
      const opened = await fixture.store.openProjectFile(sessionId, "brief.md");
      now.mockReturnValue(openedAt + 30 * 60 * 1_000 + 1);

      await expect(
        fixture.store.saveProjectFile(
          sessionId,
          "brief.md",
          "# Expired editor payload\n",
          opened.editToken,
          opened.version,
        ),
      ).rejects.toThrow("missing, expired");
      expect(await readFile(join(rootPath, "brief.md"), "utf8")).toBe(before);
    } finally {
      now.mockRestore();
    }
  });

  it("refuses to open files larger than five MiB in the editor", async () => {
    const fixture = await createStore();
    const { sessionId, rootPath } = await createProject(fixture);
    const relativePath = "research/oversized.txt";
    await writeFile(join(rootPath, relativePath), "x".repeat(5 * 1024 * 1024 + 1), "utf8");

    await expect(fixture.store.openProjectFile(sessionId, relativePath)).rejects.toThrow(
      "too large for the editor",
    );
  });

  it("rejects invalid UTF-8 files and invalid Unicode editor content", async () => {
    const fixture = await createStore();
    const { sessionId, rootPath } = await createProject(fixture);
    await writeFile(join(rootPath, "research", "invalid-utf8.bin"), Uint8Array.from([0xc3, 0x28]));

    expect(await fixture.store.listProjectFiles(sessionId)).toContain("research/invalid-utf8.bin");
    await expect(
      fixture.store.openProjectFile(sessionId, "research/invalid-utf8.bin"),
    ).rejects.toMatchObject({ code: "INVALID_UTF8" });

    const opened = await fixture.store.openProjectFile(sessionId, "brief.md");
    const before = await readFile(join(rootPath, "brief.md"), "utf8");
    await expect(
      fixture.store.saveProjectFile(
        sessionId,
        "brief.md",
        "\ud800",
        opened.editToken,
        opened.version,
      ),
    ).rejects.toMatchObject({ code: "INVALID_UTF8" });
    expect(await readFile(join(rootPath, "brief.md"), "utf8")).toBe(before);
  });

  it.skipIf(process.platform === "win32")(
    "omits symlinks from listings and refuses to open them",
    async () => {
      const fixture = await createStore();
      const { sessionId, rootPath } = await createProject(fixture);
      await symlink("brief.md", join(rootPath, "linked-brief.md"));

      expect(await fixture.store.listProjectFiles(sessionId)).not.toContain("linked-brief.md");
      await expect(
        fixture.store.openProjectFile(sessionId, "linked-brief.md"),
      ).rejects.toMatchObject({ code: "UNSAFE_FILE_TYPE" });
    },
  );

  it("validates project file IPC receipts before they reach Main", () => {
    const sessionId = "session-1";
    const relativePath = "brief.md";
    const editToken = randomUUID();
    const expectedVersion = `sha256:${"a".repeat(64)}`;

    expect(projectFileOpenRequestSchema.parse({ sessionId, relativePath })).toEqual({
      sessionId,
      relativePath,
    });
    expect(
      projectFileSaveRequestSchema.parse({
        sessionId,
        relativePath,
        content: "# Brief\n",
        editToken,
        expectedVersion,
      }),
    ).toMatchObject({ editToken, expectedVersion });

    expect(
      projectFileSaveRequestSchema.safeParse({
        sessionId,
        relativePath,
        content: "# Brief\n",
        editToken: "not-a-uuid",
        expectedVersion,
      }).success,
    ).toBe(false);
    expect(
      projectFileSaveRequestSchema.safeParse({
        sessionId,
        relativePath,
        content: "# Brief\n",
        editToken,
        expectedVersion: "sha256:not-a-receipt",
      }).success,
    ).toBe(false);
    expect(
      projectFileOpenRequestSchema.safeParse({
        sessionId,
        relativePath,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("rejects unsafe artifact diff IPC payloads", () => {
    const sessionId = "session-1";
    const relativePath = "brief.md";
    const oversizedContent = "x".repeat(5 * 1024 * 1024 + 1);

    expect(
      projectArtifactDiffRequestSchema.parse({
        sessionId,
        relativePath,
        nextContent: "# Next brief\n",
      }),
    ).toEqual({ sessionId, relativePath, nextContent: "# Next brief\n" });

    expect(
      projectArtifactDiffRequestSchema.safeParse({
        sessionId,
        relativePath: "../outside.md",
        nextContent: "escape",
      }).success,
    ).toBe(false);

    expect(
      projectArtifactDiffRequestSchema.safeParse({
        sessionId,
        relativePath,
        nextContent: oversizedContent,
      }).success,
    ).toBe(false);

    expect(
      projectArtifactDiffRequestSchema.safeParse({
        sessionId,
        relativePath,
        nextContent: "# Next brief\n",
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});
