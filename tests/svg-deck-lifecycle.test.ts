import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPptToolRegistry } from "@main/plugins/ppt/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESIGN_SYSTEM } from "../src/design-system";
import { WorkspaceFileService } from "../src/main/agent/tools/files/workspace-file-service";
import type { PptLifecycleToolBridge, ToolContext } from "../src/main/agent/tools/tool-definition";
import { slideThumbnailService } from "../src/main/plugins/ppt/adapters/electron-thumbnail-service";
import { previewSvgPageTool } from "../src/main/plugins/ppt/tools/preview-svg-page";
import { submitSvgDeckTool } from "../src/main/plugins/ppt/tools/submit-svg-deck";
import { ContentAddressedBlobStore } from "../src/main/presentation-lifecycle/content-addressed-blob-store";
import { PresentationLifecycleOrchestrator } from "../src/main/presentation-lifecycle/presentation-lifecycle-orchestrator";
import { PresentationLifecycleRepository } from "../src/main/presentation-lifecycle/presentation-lifecycle-repository";
import { PresentationLifecycleToolBridge } from "../src/main/presentation-lifecycle/presentation-lifecycle-tool-bridge";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";
import {
  asPresentationId,
  asProjectId,
  asQueryId,
  type BlobReference,
} from "../src/shared/presentation-lifecycle";

const temporaryRoots: string[] = [];
const repositories: PresentationLifecycleRepository[] = [];
const VALID_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

afterEach(async () => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0)) repository.close();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SVG deck lifecycle tools", () => {
  it("requires an active authoring capability when a lifecycle bridge exists", async () => {
    const { root, fileService, lifecycle } = await createHarness(false);
    await fileService.write("slides/svg/P01.svg", svgPage("First"));

    await expect(
      previewSvgPageTool.execute(
        {
          path: "slides/svg/P01.svg",
          includeThumbnail: false,
        },
        createContext(root, fileService, lifecycle),
      ),
    ).rejects.toThrow("Call BeginPptCapability");
  });

  it("allows a review capability to render and durably record the current SVG", async () => {
    const { root, fileService, lifecycle } = await createHarness(false);
    const args = submitArgs();
    await writeSubmissionFiles(fileService, args, root);
    lifecycle.beginCapability({
      capability: "review",
      instruction: "Review the current SVG deck",
    });
    vi.spyOn(slideThumbnailService, "captureSlide").mockResolvedValue({
      pngBase64: "rendered-page",
      width: 640,
      height: 360,
      mimeType: "image/png",
    });

    const preview = await previewSvgPageTool.execute(
      {
        path: "slides/svg/P01.svg",
        includeThumbnail: true,
      },
      createContext(root, fileService, lifecycle),
    );

    expect(preview.preview.previewGatePassed).toBe(true);
    expect(lifecycle.requireActiveCapability(["review"]).committedArtifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "page_svg" }),
        expect.objectContaining({ kind: "preview_receipt" }),
      ]),
    );
  });

  it("persists current lock, page, and preview receipts across file services", async () => {
    const { root, fileService, lifecycle, orchestrator, repository, blobStore } =
      await createHarness(true);
    const args = submitArgs();
    await writeSubmissionFiles(fileService, args, root, true);
    vi.spyOn(slideThumbnailService, "captureSlide").mockResolvedValue({
      pngBase64: "rendered-page",
      width: 640,
      height: 360,
      mimeType: "image/png",
    });

    const preview = await previewSvgPageTool.execute(
      {
        path: "slides/svg/P01.svg",
        includeThumbnail: true,
      },
      createContext(root, fileService, lifecycle),
    );
    expect(preview.preview.previewGatePassed).toBe(true);

    const projection = lifecycle.requireActiveCapability();
    expect(projection.committedArtifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["design_spec", "page_plan", "page_svg", "preview_receipt"]),
    );
    const pagePointer = projection.committedArtifacts.find(
      (artifact) => artifact.kind === "page_svg",
    )!;
    const pageRevision = repository.getArtifactRevision<{
      blob: BlobReference;
      markup?: string;
    }>(pagePointer.revisionId)!;
    expect(pageRevision.value.blob).toMatchObject({
      mediaType: "image/svg+xml",
      byteLength: expect.any(Number),
    });
    expect(pageRevision.value).not.toHaveProperty("markup");
    expect((await blobStore.get(pageRevision.value.blob)).toString("utf8")).toContain(
      "data:image/png;base64,",
    );

    const assetPointer = projection.committedArtifacts.find(
      (artifact) => artifact.kind === "source_asset",
    )!;
    const assetRevision = repository.getArtifactRevision<{
      blob: BlobReference;
      bytes?: unknown;
    }>(assetPointer.revisionId)!;
    expect(assetRevision.value).not.toHaveProperty("bytes");
    expect(await blobStore.get(assetRevision.value.blob)).toEqual(
      Buffer.from(VALID_PIXEL_PNG, "base64"),
    );

    const submitFileService = new WorkspaceFileService(root);
    const result = await submitSvgDeckTool.execute(
      args,
      createContext(root, submitFileService, lifecycle),
    );
    expect(result.type).toBe("command_proposal");

    await submitFileService.readWindow("slides/svg/P01.svg");
    await submitFileService.write("slides/svg/P01.svg", `${svgPage("First")} `);
    await expect(
      submitSvgDeckTool.execute(args, createContext(root, submitFileService, lifecycle)),
    ).rejects.toThrow("PPT capability request is waiting_user");

    expect(orchestrator.getProjection(asPresentationId("presentation-1"))?.status).toBe(
      "waiting_user",
    );
  });

  it("allows waiting-user recovery only once at a resumed Query boundary", async () => {
    const { orchestrator, repository, blobStore } = await createHarness(true);
    const presentationId = asPresentationId("presentation-1");
    const active = orchestrator.getProjection(presentationId)!;
    orchestrator.waitForUser(active.jobId, "Need user input.");

    const resumed = new PresentationLifecycleToolBridge(
      orchestrator,
      asProjectId("project-1"),
      presentationId,
      asQueryId("query-1"),
      "Continue the SVG deck",
      blobStore,
      undefined,
      true,
    );
    expect(resumed.requireActiveCapability().status).toBe("running");

    orchestrator.waitForUser(active.jobId, "External source changed.");
    expect(() => resumed.requireActiveCapability()).toThrow(
      "PPT capability request is waiting_user",
    );
    expect(repository.getJob(active.jobId)?.status).toBe("waiting_user");
  });

  it("commits a fresh revision when a later capability restores old SVG bytes", async () => {
    const { root, fileService, lifecycle, orchestrator, repository, blobStore } =
      await createHarness(true);
    const args = submitArgs();
    await writeSubmissionFiles(fileService, args, root);
    vi.spyOn(slideThumbnailService, "captureSlide").mockResolvedValue({
      pngBase64: "rendered-page",
      width: 640,
      height: 360,
      mimeType: "image/png",
    });
    const context = createContext(root, fileService, lifecycle);
    await previewSvgPageTool.execute(
      {
        path: "slides/svg/P01.svg",
        includeThumbnail: true,
      },
      context,
    );
    const firstPage = lifecycle
      .requireActiveCapability()
      .committedArtifacts.find((artifact) => artifact.kind === "page_svg")!;

    await fileService.write("slides/svg/P01.svg", svgPage("Second"));
    const secondLifecycle = new PresentationLifecycleToolBridge(
      orchestrator,
      asProjectId("project-1"),
      "presentation-1",
      asQueryId("query-2"),
      "Revise the SVG deck",
      blobStore,
    );
    secondLifecycle.beginCapability({
      capability: "edit",
      instruction: "Revise the SVG deck",
    });
    await secondLifecycle.observeArtifactChanges({
      workspaceRoot: root,
      source: "capability_probe",
    });
    await previewSvgPageTool.execute(
      {
        path: "slides/svg/P01.svg",
        includeThumbnail: true,
      },
      createContext(root, fileService, secondLifecycle),
    );
    const secondPage = secondLifecycle
      .requireActiveCapability()
      .committedArtifacts.find((artifact) => artifact.kind === "page_svg")!;
    expect(secondPage.revisionId).not.toBe(firstPage.revisionId);

    await fileService.write("slides/svg/P01.svg", svgPage("First"));
    const restoredLifecycle = new PresentationLifecycleToolBridge(
      orchestrator,
      asProjectId("project-1"),
      "presentation-1",
      asQueryId("query-3"),
      "Restore the first SVG version",
      blobStore,
    );
    restoredLifecycle.beginCapability({
      capability: "edit",
      instruction: "Restore the first SVG version",
    });
    await restoredLifecycle.observeArtifactChanges({
      workspaceRoot: root,
      source: "capability_probe",
    });
    await previewSvgPageTool.execute(
      {
        path: "slides/svg/P01.svg",
        includeThumbnail: true,
      },
      createContext(root, fileService, restoredLifecycle),
    );
    const restoredProjection = restoredLifecycle.requireActiveCapability();
    const restoredPage = restoredProjection.committedArtifacts.find(
      (artifact) => artifact.kind === "page_svg",
    )!;
    expect(restoredPage.contentHash).toBe(firstPage.contentHash);
    expect(restoredPage.revisionId).not.toBe(firstPage.revisionId);
    expect(restoredProjection.staleArtifacts).not.toContainEqual(
      expect.objectContaining({ revisionId: restoredPage.revisionId }),
    );
    await expect(
      submitSvgDeckTool.execute(args, createContext(root, fileService, restoredLifecycle)),
    ).resolves.toMatchObject({ type: "command_proposal" });
    expect(
      repository
        .listArtifactRevisions(orchestrator.getState(asPresentationId("presentation-1"))!.jobId)
        .filter((artifact) => artifact.kind === "page_svg"),
    ).toHaveLength(3);
  });

  it("rejects submit when the durable SVG blob is missing or corrupted", async () => {
    const { root, fileService, lifecycle, repository, blobStore } = await createHarness(true);
    const args = submitArgs();
    await writeSubmissionFiles(fileService, args, root);
    vi.spyOn(slideThumbnailService, "captureSlide").mockResolvedValue({
      pngBase64: "rendered-page",
      width: 640,
      height: 360,
      mimeType: "image/png",
    });
    await previewSvgPageTool.execute(
      {
        path: "slides/svg/P01.svg",
        includeThumbnail: true,
      },
      createContext(root, fileService, lifecycle),
    );

    const pagePointer = lifecycle
      .requireActiveCapability()
      .committedArtifacts.find((artifact) => artifact.kind === "page_svg")!;
    const pageRevision = repository.getArtifactRevision<{
      blob: BlobReference;
    }>(pagePointer.revisionId)!;
    const blobPath = blobStore.pathFor(pageRevision.value.blob.contentHash);
    await rm(blobPath);
    await expect(
      submitSvgDeckTool.execute(
        args,
        createContext(root, new WorkspaceFileService(root), lifecycle),
      ),
    ).rejects.toThrow("SVG lifecycle blob is missing or invalid");

    await previewSvgPageTool.execute(
      {
        path: "slides/svg/P01.svg",
        includeThumbnail: true,
      },
      createContext(root, fileService, lifecycle),
    );
    await writeFile(blobPath, Buffer.alloc(pageRevision.value.blob.byteLength));

    await expect(
      submitSvgDeckTool.execute(
        args,
        createContext(root, new WorkspaceFileService(root), lifecycle),
      ),
    ).rejects.toThrow("SVG lifecycle blob is missing or invalid");
  });
});

async function createHarness(begin: boolean): Promise<{
  root: string;
  fileService: WorkspaceFileService;
  lifecycle: PptLifecycleToolBridge;
  orchestrator: PresentationLifecycleOrchestrator;
  repository: PresentationLifecycleRepository;
  blobStore: ContentAddressedBlobStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-ppt-svg-lifecycle-"));
  temporaryRoots.push(root);
  const repository = new PresentationLifecycleRepository(join(root, "lifecycle.sqlite"));
  repositories.push(repository);
  const orchestrator = new PresentationLifecycleOrchestrator(repository);
  const blobStore = new ContentAddressedBlobStore(join(root, "blobs"));
  const lifecycle = new PresentationLifecycleToolBridge(
    orchestrator,
    asProjectId("project-1"),
    "presentation-1",
    asQueryId("query-1"),
    "Create the SVG deck",
    blobStore,
  );
  if (begin) {
    lifecycle.beginCapability({
      capability: "create",
      instruction: "Create the SVG deck",
    });
  }
  return {
    root,
    fileService: new WorkspaceFileService(root),
    lifecycle,
    orchestrator,
    repository,
    blobStore,
  };
}

function createContext(
  workspaceRoot: string,
  fileService: WorkspaceFileService,
  lifecycle: PptLifecycleToolBridge,
): ToolContext {
  return {
    presentation: createStarterPresentation(),
    selectedElementIds: [],
    discoverySession: { discoveredToolNames: new Set() },
    registry: createPptToolRegistry(),
    messageHistory: [],
    workspaceRoot,
    fileService,
    presentationLifecycle: lifecycle,
  };
}

type SubmissionArgs = Parameters<typeof submitSvgDeckTool.execute>[0];

function submitArgs(): SubmissionArgs {
  return {
    title: "Lifecycle deck",
    designSpecPath: "design/design-spec.json",
    pagePlanPath: "slides/page-plan.json",
    communication: {
      audience: "Executive team",
      objective: "Make a decision",
      desiredOutcome: "Approve",
      coreMessage: "The plan is ready",
      deliveryContext: "Board meeting",
      afterUse: "Decision record",
    },
    designSystem: DEFAULT_DESIGN_SYSTEM,
    slides: [
      {
        id: "P01",
        title: "First",
        path: "slides/svg/P01.svg",
        narrative: {
          role: "cover",
          coreMessage: "The plan is ready",
          audienceMove: "Create confidence",
          rhythm: "anchor",
          layoutIntent: "One dominant statement.",
        },
      },
    ],
    summary: "Create one SVG page.",
    risk: "medium",
  };
}

async function writeSubmissionFiles(
  fileService: WorkspaceFileService,
  args: SubmissionArgs,
  root: string,
  withAsset = false,
): Promise<void> {
  if (withAsset) {
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "pixel.png"), Buffer.from(VALID_PIXEL_PNG, "base64"));
  }
  await fileService.write("slides/svg/P01.svg", svgPage("First", withAsset));
  await fileService.write(
    "design/design-spec.json",
    JSON.stringify({
      version: 1,
      canvas: { width: 1280, height: 720 },
      communicationContract: args.communication,
      presentationDesignSystem: args.designSystem,
      argumentMode: args.designSystem.argumentMode,
      visualStyle: { id: args.designSystem.visualStyle },
      readingMode: args.designSystem.readingMode,
    }),
  );
  await fileService.write(
    "slides/page-plan.json",
    JSON.stringify({
      version: 1,
      designSpec: "design/design-spec.json",
      slides: [
        {
          id: "P01",
          path: "slides/svg/P01.svg",
          narrativeRole: "cover",
          finalCopy: { title: "First" },
          coreMessage: "The plan is ready",
          audienceMove: "Create confidence",
          rhythm: "anchor",
          layoutIntent: "One dominant statement.",
        },
      ],
    }),
  );
}

function svgPage(text: string, withAsset = false): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
    '<rect width="1280" height="720" fill="#111827"/>',
    ...(withAsset
      ? ['<image href="../../assets/pixel.png" x="20" y="20" width="1" height="1"/>']
      : []),
    `<text x="80" y="180" fill="#fff" font-size="64">${text}</text>`,
    "</svg>",
  ].join("");
}
