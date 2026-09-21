import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFileService } from "@main/agent/tools/files/workspace-file-service";
import { readFileContract, writeFileContract } from "@main/plugins/ppt/workspace-files";
import { PresentationArtifactChangeObserver } from "@main/presentation-lifecycle/artifact-change-observer";
import type { ArtifactChangeObserverPort } from "@main/presentation-lifecycle/artifact-change-observer-types";
import { PresentationLifecycleOrchestrator } from "@main/presentation-lifecycle/presentation-lifecycle-orchestrator";
import { PresentationLifecycleRepository } from "@main/presentation-lifecycle/presentation-lifecycle-repository";
import { PresentationLifecycleToolBridge } from "@main/presentation-lifecycle/presentation-lifecycle-tool-bridge";
import { FileSessionStore } from "@main/session-store";
import { hashBytes } from "@ppt/core/artifact-hash";
import {
  type ArtifactDependency,
  type ArtifactPointer,
  asPresentationId,
  asProjectId,
  asQueryId,
  type ValidationReport,
} from "@shared/presentation-lifecycle";
import { afterEach, describe, expect, it, vi } from "vitest";

const NOW = "2026-07-30T00:00:00.000Z";
const temporaryDirectories: string[] = [];
const repositories: PresentationLifecycleRepository[] = [];
const sessionStores: FileSessionStore[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    try {
      repository.close();
    } catch {
      // Cleanup remains idempotent.
    }
  }
  for (const store of sessionStores.splice(0)) {
    try {
      store.close();
    } catch {
      // Cleanup remains idempotent.
    }
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("PresentationArtifactChangeObserver", () => {
  it("marks only the source asset's transitive consumers stale", async () => {
    const fixture = await createLifecycle("asset");
    await mkdir(join(fixture.workspaceRoot, "assets"), { recursive: true });
    const assetPath = "assets/chart.png";
    const original = Buffer.from([1, 2, 3, 4]);
    await writeFile(join(fixture.workspaceRoot, assetPath), original);

    const design = commit(fixture, {
      artifactId: "design-spec",
      kind: "design_spec",
      stage: "design_spec",
      value: { theme: "light" },
    });
    const plan = commit(fixture, {
      artifactId: "page-plan",
      kind: "page_plan",
      stage: "page_plan",
      value: { slides: ["P01", "P02"] },
      dependencies: [dependency(design)],
    });
    const asset = commit(fixture, {
      artifactId: `source-asset:${assetPath}`,
      kind: "source_asset",
      stage: "page_svg",
      value: {
        sourcePath: assetPath,
        sha256: digest(original),
      },
    });
    const page1 = commit(fixture, {
      artifactId: "page-svg:slides/svg/P01.svg",
      kind: "page_svg",
      stage: "page_svg",
      value: {
        sourcePath: "slides/svg/P01.svg",
        sha256: "1".repeat(64),
      },
      dependencies: [dependency(plan), dependency(asset)],
    });
    const preview1 = commit(fixture, {
      artifactId: "preview-receipt:slides/svg/P01.svg",
      kind: "preview_receipt",
      stage: "preview",
      value: { page: "P01" },
      dependencies: [dependency(page1)],
    });
    const page2 = commit(fixture, {
      artifactId: "page-svg:slides/svg/P02.svg",
      kind: "page_svg",
      stage: "page_svg",
      value: {
        sourcePath: "slides/svg/P02.svg",
        sha256: "2".repeat(64),
      },
      dependencies: [dependency(plan)],
    });

    const changed = Buffer.from([9, 8, 7, 6]);
    await writeFile(join(fixture.workspaceRoot, assetPath), changed);
    await fixture.observer.observe({
      presentationId: fixture.presentationId,
      workspaceRoot: fixture.workspaceRoot,
      paths: [assetPath],
      source: "agent_read",
      detectedAt: "2026-07-30T00:10:00.000Z",
    });

    const state = fixture.repository.getJob(fixture.jobId)!;
    expect(state.status).toBe("running");
    expect(state.staleArtifacts.map((item) => item.revisionId)).toEqual(
      expect.arrayContaining([asset.revisionId, page1.revisionId, preview1.revisionId]),
    );
    expect(state.staleArtifacts.map((item) => item.revisionId)).not.toContain(page2.revisionId);
    expect(
      state.staleArtifacts.find((item) => item.revisionId === asset.revisionId)
        ?.observedContentHash,
    ).toBe(hashBytes(changed));
  });

  it("ignores JSON key order but waits for the user after a real project edit", async () => {
    const fixture = await createLifecycle("json");
    await mkdir(join(fixture.workspaceRoot, "design"), { recursive: true });
    const designPath = join(fixture.workspaceRoot, "design", "design-spec.json");
    await writeFile(designPath, '{"b":2,"a":1}\n', "utf8");

    const design = commit(fixture, {
      artifactId: "design-spec",
      kind: "design_spec",
      stage: "design_spec",
      value: { a: 1, b: 2 },
    });
    const plan = commit(fixture, {
      artifactId: "page-plan",
      kind: "page_plan",
      stage: "page_plan",
      value: { slides: [] },
      dependencies: [dependency(design)],
    });
    const presentation = commit(fixture, {
      artifactId: "presentation:presentation-json",
      kind: "presentation_revision",
      stage: "presentation",
      value: { revision: 1 },
      dependencies: [dependency(plan)],
    });

    await fixture.observer.observe({
      presentationId: fixture.presentationId,
      workspaceRoot: fixture.workspaceRoot,
      paths: ["design/design-spec.json"],
      source: "project_read",
    });
    expect(fixture.repository.getJob(fixture.jobId)).toMatchObject({
      status: "running",
      staleArtifacts: [],
    });

    await writeFile(designPath, '{"a":1,"b":3}\n', "utf8");
    await fixture.observer.observe({
      presentationId: fixture.presentationId,
      workspaceRoot: fixture.workspaceRoot,
      paths: ["design/design-spec.json"],
      source: "project_edit",
      detectedAt: "2026-07-30T00:20:00.000Z",
    });

    const state = fixture.repository.getJob(fixture.jobId)!;
    expect(state).toMatchObject({
      status: "waiting_user",
      currentStage: "design_spec",
    });
    expect(state.waitingReason).toContain("Rerun from design_spec");
    expect(state.staleArtifacts.map((item) => item.revisionId)).toEqual(
      expect.arrayContaining([design.revisionId, plan.revisionId, presentation.revisionId]),
    );
    expect(state.committedArtifacts).toContainEqual(presentation);
  });

  it("does not treat an embedded data URI as a workspace file", async () => {
    const fixture = await createLifecycle("embedded");
    await mkdir(join(fixture.workspaceRoot, "slides", "svg"), {
      recursive: true,
    });
    const sourcePath = "slides/svg/P01.svg";
    const png = Buffer.from("iVBORw0KGgo=", "base64");
    const embeddedPath = `embedded:${digest(png)}`;
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">' +
      '<image href="data:image/png;base64,iVBORw0KGgo="/></svg>';
    await writeFile(join(fixture.workspaceRoot, sourcePath), markup, "utf8");
    const asset = commit(fixture, {
      artifactId: `source-asset:${embeddedPath}`,
      kind: "source_asset",
      stage: "page_svg",
      value: {
        sourcePath: embeddedPath,
        sha256: digest(png),
      },
    });
    commit(fixture, {
      artifactId: `page-svg:${sourcePath}`,
      kind: "page_svg",
      stage: "page_svg",
      value: {
        sourcePath,
        sha256: digest(Buffer.from(markup, "utf8")),
      },
      dependencies: [dependency(asset)],
    });

    await fixture.observer.observe({
      presentationId: fixture.presentationId,
      workspaceRoot: fixture.workspaceRoot,
      source: "submit",
    });
    expect(fixture.repository.getJob(fixture.jobId)).toMatchObject({
      status: "running",
      staleArtifacts: [],
    });
  });

  it.each(["preview", "submit"] as const)(
    "moves to waiting_user when %s first detects a changed SVG",
    async (source) => {
      const fixture = await createLifecycle(`svg-${source}`);
      await mkdir(join(fixture.workspaceRoot, "slides", "svg"), {
        recursive: true,
      });
      const sourcePath = "slides/svg/P01.svg";
      const original =
        '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">' +
        "<text>one</text></svg>";
      await writeFile(join(fixture.workspaceRoot, sourcePath), original, "utf8");
      const page = commit(fixture, {
        artifactId: `page-svg:${sourcePath}`,
        kind: "page_svg",
        stage: "page_svg",
        value: {
          sourcePath,
          sha256: digest(Buffer.from(original, "utf8")),
        },
      });

      await fixture.observer.observe({
        presentationId: fixture.presentationId,
        workspaceRoot: fixture.workspaceRoot,
        source,
      });
      expect(fixture.repository.getJob(fixture.jobId)).toMatchObject({
        status: "running",
        staleArtifacts: [],
      });

      await writeFile(
        join(fixture.workspaceRoot, sourcePath),
        original.replace("one", "two"),
        "utf8",
      );
      await fixture.observer.observe({
        presentationId: fixture.presentationId,
        workspaceRoot: fixture.workspaceRoot,
        source,
      });
      expect(fixture.repository.getJob(fixture.jobId)).toMatchObject({
        status: "waiting_user",
        staleArtifacts: [expect.objectContaining({ revisionId: page.revisionId })],
      });
    },
  );

  it("supersedes an active proposal when its source dependency becomes stale", async () => {
    const fixture = await createLifecycle("proposal");
    await mkdir(join(fixture.workspaceRoot, "design"), { recursive: true });
    const designPath = join(fixture.workspaceRoot, "design", "design-spec.json");
    await writeFile(designPath, '{"theme":"light"}\n', "utf8");
    const design = commit(fixture, {
      artifactId: "design-spec",
      kind: "design_spec",
      stage: "design_spec",
      value: { theme: "light" },
    });
    const proposalArtifact = commit(fixture, {
      artifactId: "proposal:active",
      kind: "command_proposal",
      stage: "proposal",
      value: { summary: "Apply current design" },
      dependencies: [dependency(design)],
    });
    const proposal = fixture.orchestrator.recordProposal({
      jobId: fixture.jobId,
      proposalArtifactRevisionId: proposalArtifact.revisionId,
      basePresentationRevisionNumber: 0,
      createdAt: "2026-07-30T00:05:00.000Z",
    });

    await writeFile(designPath, '{"theme":"dark"}\n', "utf8");
    await fixture.observer.observe({
      presentationId: fixture.presentationId,
      workspaceRoot: fixture.workspaceRoot,
      paths: ["design/design-spec.json"],
      source: "submit",
      detectedAt: "2026-07-30T00:06:00.000Z",
    });

    expect(fixture.repository.getProposal(proposal.proposalId)?.status).toBe("superseded");
    expect(fixture.repository.getJob(fixture.jobId)).toMatchObject({
      status: "waiting_user",
      staleArtifacts: [
        expect.objectContaining({ revisionId: design.revisionId }),
        expect.objectContaining({ revisionId: proposalArtifact.revisionId }),
      ],
    });
  });
});

describe("artifact change observer boundaries", () => {
  it("serializes lifecycle observations issued by concurrent tools", async () => {
    const fixture = await createLifecycle("bridge-queue");
    let active = 0;
    let peak = 0;
    const events: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const observer: ArtifactChangeObserverPort = {
      async observe(input) {
        const path = input.paths?.[0] ?? "unknown";
        active += 1;
        peak = Math.max(peak, active);
        events.push(`start:${path}`);
        if (path === "first.svg") {
          firstStarted();
          await gate;
        }
        events.push(`end:${path}`);
        active -= 1;
      },
    };
    const bridge = new PresentationLifecycleToolBridge(
      fixture.orchestrator,
      asProjectId("project-bridge-queue"),
      fixture.presentationId,
      asQueryId("query-bridge-queue"),
      "Create",
      undefined,
      observer,
    );

    const first = bridge.observeArtifactChanges({
      workspaceRoot: fixture.workspaceRoot,
      paths: ["first.svg"],
      source: "agent_write",
    });
    await started;
    const second = bridge.observeArtifactChanges({
      workspaceRoot: fixture.workspaceRoot,
      paths: ["second.svg"],
      source: "agent_write",
    });
    await Promise.resolve();
    expect(peak).toBe(1);
    expect(events).toEqual(["start:first.svg"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "start:first.svg",
      "end:first.svg",
      "start:second.svg",
      "end:second.svg",
    ]);
  });

  it("notifies the same observer for project reads and edits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppt-project-observer-"));
    temporaryDirectories.push(directory);
    const store = new FileSessionStore(
      join(directory, "conversations.sqlite"),
      join(directory, "projects"),
    );
    sessionStores.push(store);
    const observe = vi.fn(async () => undefined);
    store.setArtifactChangeObserver({ observe });
    await store.initialize();
    const bootstrap = await store.createSession({ title: "Observer" });
    const sessionId = bootstrap.activeSession!.session.id;
    const projectRoot = bootstrap.activeSession!.project!.rootPath;
    await mkdir(join(projectRoot, "design"), { recursive: true });
    await writeFile(join(projectRoot, "design", "design-spec.json"), "{}\n", "utf8");

    const opened = await store.openProjectFile(sessionId, "design/design-spec.json");
    await store.saveProjectFile(
      sessionId,
      opened.path,
      `${opened.content.trimEnd()}\n`,
      opened.editToken,
      opened.version,
    );

    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "project_read",
        paths: ["design/design-spec.json"],
      }),
    );
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "project_edit",
        paths: ["design/design-spec.json"],
      }),
    );
  });

  it("notifies the observer after Agent file reads and writes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-agent-observer-"));
    temporaryDirectories.push(workspaceRoot);
    await writeFile(join(workspaceRoot, "notes.txt"), "before", "utf8");
    const fileService = new WorkspaceFileService(workspaceRoot);
    const observeArtifactChanges = vi.fn(async () => undefined);
    const context = {
      workspaceRoot,
      fileService,
      presentationLifecycle: { observeArtifactChanges },
    };

    const read = await readFileContract.execute({ path: "notes.txt" }, context);
    await writeFileContract.execute(
      {
        path: "notes.txt",
        content: "after",
        expected_version: read.version,
      },
      context,
    );

    expect(observeArtifactChanges).toHaveBeenNthCalledWith(1, {
      workspaceRoot,
      paths: ["notes.txt"],
      source: "agent_read",
    });
    expect(observeArtifactChanges).toHaveBeenNthCalledWith(2, {
      workspaceRoot,
      paths: ["notes.txt"],
      source: "agent_write",
    });
  });
});

async function createLifecycle(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `ppt-observer-${name}-`));
  temporaryDirectories.push(directory);
  const workspaceRoot = join(directory, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const repository = new PresentationLifecycleRepository(join(directory, "conversations.sqlite"));
  repositories.push(repository);
  const orchestrator = new PresentationLifecycleOrchestrator(repository);
  const presentationId = asPresentationId(`presentation-${name}`);
  const state = orchestrator.beginCapability({
    projectId: asProjectId(`project-${name}`),
    presentationId,
    queryId: asQueryId(`query-${name}`),
    capability: "create",
    instruction: "Create",
    requestedAt: NOW,
  });
  return {
    workspaceRoot,
    repository,
    orchestrator,
    observer: new PresentationArtifactChangeObserver(orchestrator),
    presentationId,
    jobId: state.jobId,
  };
}

function commit(
  fixture: Awaited<ReturnType<typeof createLifecycle>>,
  input: {
    artifactId: string;
    kind:
      | "design_spec"
      | "page_plan"
      | "source_asset"
      | "page_svg"
      | "preview_receipt"
      | "command_proposal"
      | "presentation_revision";
    stage: "design_spec" | "page_plan" | "page_svg" | "preview" | "proposal" | "presentation";
    value: unknown;
    dependencies?: ArtifactDependency[];
  },
): ArtifactPointer {
  return fixture.orchestrator.commitArtifact({
    jobId: fixture.jobId,
    ...input,
    validation: passed(),
    idempotencyKey: `test:${input.artifactId}`,
    committedAt: NOW,
  }).pointer;
}

function dependency(pointer: ArtifactPointer): ArtifactDependency {
  return {
    artifactId: pointer.artifactId,
    revisionId: pointer.revisionId,
    contentHash: pointer.contentHash,
  };
}

function digest(bytes: Uint8Array): string {
  return hashBytes(bytes).slice("sha256:".length);
}

function passed(): ValidationReport {
  return {
    status: "passed",
    validator: "test",
    issues: [],
    validatedAt: NOW,
  };
}
