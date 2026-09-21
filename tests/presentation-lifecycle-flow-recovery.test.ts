import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { canonicalJson, hashArtifactValue } from "@ppt/core/artifact-hash";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DESIGN_SYSTEM } from "../src/design-system";
import type {
  AgentModelContentBlock,
  AgentModelGateway,
  AgentModelRequest,
  AgentModelResponse,
} from "../src/main/agent/gateway/types";
import { WorkspaceFileService } from "../src/main/agent/tools/files/workspace-file-service";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { recoverInterruptedExport } from "../src/main/deck/export-recovery";
import { slideThumbnailService } from "../src/main/plugins/ppt/adapters/electron-thumbnail-service";
import { CommitGate } from "../src/main/plugins/ppt/gate/commit-gate";
import { RiskPolicy } from "../src/main/plugins/ppt/gate/risk-policy";
import { AgentService } from "../src/main/plugins/ppt/service";
import { beginPptCapabilityTool } from "../src/main/plugins/ppt/tools/begin-ppt-capability";
import { previewSvgPageTool } from "../src/main/plugins/ppt/tools/preview-svg-page";
import { submitSvgDeckTool } from "../src/main/plugins/ppt/tools/submit-svg-deck";
import { ContentAddressedBlobStore } from "../src/main/presentation-lifecycle/content-addressed-blob-store";
import { PresentationCommitService } from "../src/main/presentation-lifecycle/presentation-commit-service";
import { PresentationLifecycleOrchestrator } from "../src/main/presentation-lifecycle/presentation-lifecycle-orchestrator";
import { PresentationLifecycleRepository } from "../src/main/presentation-lifecycle/presentation-lifecycle-repository";
import { PresentationLifecycleToolBridge } from "../src/main/presentation-lifecycle/presentation-lifecycle-tool-bridge";
import { FileSessionStore } from "../src/main/session-store";
import { exportToPptx } from "../src/ppt/core/ppt-exporter";
import { CommandBus } from "../src/shared/commands";
import type { Presentation } from "../src/shared/presentation";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";
import {
  asPresentationId,
  asProjectId,
  asQueryId,
  type PptJobId,
  type PresentationId,
  type PresentationRevisionId,
  type QueryId,
} from "../src/shared/presentation-lifecycle";

const temporaryRoots: string[] = [];
const repositories: PresentationLifecycleRepository[] = [];
const sessionStores: FileSessionStore[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0)) repository.close();
  for (const store of sessionStores.splice(0)) store.close();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Presentation lifecycle flow and crash recovery", () => {
  it("continues one SVG create Job across Queries through approval and PresentationRevision", async () => {
    const root = await createTemporaryRoot("ppt-svg-cross-query-");
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const fileService = new WorkspaceFileService(workspaceRoot);
    const submission = svgSubmission();
    await writeSvgSubmission(fileService, submission);
    vi.spyOn(slideThumbnailService, "captureSlide").mockResolvedValue({
      pngBase64: "rendered-page",
      width: 640,
      height: 360,
      mimeType: "image/png",
    });

    const sessionStore = await createSessionStore(root);
    const bootstrap = await sessionStore.createSession({
      title: "Cross-query SVG lifecycle",
    });
    const sessionId = bootstrap.activeSession!.session.id;
    const initialPresentation = bootstrap.activeSession!.presentation;
    const presentationId = asPresentationId(initialPresentation.id);
    const projectId = asProjectId("svg-cross-query-project");
    const repository = createSharedRepository(sessionStore);
    const lifecycle = new PresentationLifecycleOrchestrator(repository);
    const blobStore = new ContentAddressedBlobStore(join(root, "blobs"));
    const commandBus = new CommandBus(initialPresentation);
    const commitService = new PresentationCommitService(
      sessionId,
      projectId,
      presentationId,
      commandBus,
      sessionStore,
      lifecycle,
      blobStore,
    );
    const registry = new ToolRegistry();
    registry.register(beginPptCapabilityTool);
    registry.register(previewSvgPageTool);
    registry.register(submitSvgDeckTool);
    const gateway = gatewayFor([
      [
        toolUse("begin-preview", "BeginPptCapability", {
          capability: "create",
          instruction: "Create and preview the SVG deck",
        }),
      ],
      [
        toolUse("preview-page", "PreviewSvgPage", {
          path: "slides/svg/P01.svg",
          includeThumbnail: true,
        }),
      ],
      [{ type: "text", text: "The first page is previewed; continue next request." }],
      [
        toolUse("begin-submit", "BeginPptCapability", {
          capability: "create",
          instruction: "Continue and submit the SVG deck",
        }),
      ],
      [toolUse("submit-deck", "SubmitSvgDeck", submission)],
    ]);
    const queryIds: QueryId[] = [];
    const runtime = createPptRuntime(
      registry,
      gateway,
      undefined,
      sessionStore.conversationDatabase,
      ({ queryId, options }) => {
        queryIds.push(queryId);
        if (options.runId) {
          sessionStore.conversationDatabase.bindRunQueryId(options.runId, queryId);
        }
        return new PresentationLifecycleToolBridge(
          lifecycle,
          projectId,
          presentationId,
          queryId,
          options.request,
          blobStore,
        );
      },
    );
    const service = new AgentService(
      commandBus,
      runtime,
      new CommitGate(new RiskPolicy()),
      workspaceRoot,
      undefined,
      undefined,
      undefined,
      sessionStore.conversationDatabase,
      undefined,
      lifecycle,
      commitService,
      blobStore,
    );

    const previewRunId = "run-svg-preview";
    beginRun(sessionStore, sessionId, previewRunId, "Preview the first SVG page");
    const previewResult = await service.start(
      "Preview the first SVG page",
      undefined,
      "REQUEST_APPROVAL",
      undefined,
      undefined,
      [],
      undefined,
      previewRunId,
    );
    expect(previewResult).toMatchObject({ status: "chat" });
    finishRun(sessionStore, previewRunId, {
      status: "chat",
    });

    expect(queryIds).toHaveLength(1);
    const previewQueryId = queryIds[0]!;
    const afterPreview = lifecycle.getProjection(presentationId)!;
    const previewRequest = repository.getCapabilityRequestByQuery(
      afterPreview.jobId,
      previewQueryId,
    )!;
    expect(afterPreview).toMatchObject({
      queryId: previewQueryId,
      requestId: previewRequest.requestId,
      status: "waiting_user",
      stage: "preview",
    });
    expect(previewQueryId).not.toBe(previewRunId);
    expect(previewRequest.requestId).not.toBe(previewRunId);
    expect(afterPreview.committedArtifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["intent", "design_spec", "page_plan", "page_svg", "preview_receipt"]),
    );

    const submitRunId = "run-svg-submit";
    beginRun(sessionStore, sessionId, submitRunId, "Submit the SVG deck");
    const proposalResult = await service.start(
      "Submit the SVG deck",
      undefined,
      "REQUEST_APPROVAL",
      undefined,
      undefined,
      [],
      undefined,
      submitRunId,
    );
    expect(proposalResult.status).toBe("approval-required");
    if (proposalResult.status !== "approval-required") {
      throw new Error("Expected an approval-required result.");
    }
    finishRun(sessionStore, submitRunId, {
      status: "approval-required",
      proposalId: proposalResult.approval.proposalId,
    });

    expect(queryIds).toHaveLength(2);
    const submitQueryId = queryIds[1]!;
    const waitingApproval = lifecycle.getProjection(presentationId)!;
    const submitRequest = repository.getCapabilityRequestByQuery(
      waitingApproval.jobId,
      submitQueryId,
    )!;
    expect(waitingApproval.jobId).toBe(afterPreview.jobId);
    expect(submitQueryId).not.toBe(previewQueryId);
    expect(submitRequest.requestId).not.toBe(previewRequest.requestId);
    expect(submitQueryId).not.toBe(submitRunId);
    expect(submitRequest.requestId).not.toBe(submitRunId);
    expect(waitingApproval).toMatchObject({
      queryId: submitQueryId,
      requestId: submitRequest.requestId,
      status: "waiting_approval",
      stage: "proposal",
      proposalId: proposalResult.approval.proposalId,
      proposalStatus: "waiting_approval",
    });
    const completedSubmitRun = loadRun(sessionStore, submitRunId);
    expect(completedSubmitRun).toMatchObject({
      status: "completed",
      query_id: submitQueryId,
    });
    expect(JSON.parse(completedSubmitRun?.result_json ?? "null")).toEqual({
      status: "approval-required",
      proposalId: proposalResult.approval.proposalId,
    });
    expect(waitingApproval.presentationRevisionId).toBeUndefined();

    const applied = await service.resumeProposal(proposalResult.approval.proposalId, true);
    expect(applied).toMatchObject({
      status: "completed",
      presentation: {
        id: presentationId,
        title: submission.title,
        revision: expect.any(Number),
      },
    });
    if (applied.status !== "completed") {
      throw new Error("Expected an applied Presentation.");
    }
    expect(applied.presentation.revision).toBeGreaterThan(initialPresentation.revision);
    const completed = lifecycle.getProjection(presentationId)!;
    expect(completed).toMatchObject({
      jobId: afterPreview.jobId,
      status: "completed",
      stage: "presentation",
      proposalId: proposalResult.approval.proposalId,
      proposalStatus: "applied",
      presentationRevisionId: expect.any(String),
      presentationRevisionNumber: applied.presentation.revision,
    });
    expect(completed.committedArtifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining([
        "candidate_deck",
        "quality_report",
        "command_proposal",
        "presentation_revision",
      ]),
    );
    expect(
      repository
        .listArtifactRevisions(completed.jobId)
        .filter((revision) => revision.kind === "presentation_revision"),
    ).toHaveLength(1);
  }, 20_000);

  it("does not replay an apply claim left in progress", async () => {
    const harness = await createCommitHarness("ppt-apply-in-progress-");
    const initial = harness.commandBus.getSnapshot();
    const created = harness.lifecycle.beginCapability({
      projectId: harness.projectId,
      presentationId: harness.presentationId,
      queryId: asQueryId("query-apply-base"),
      capability: "create",
      instruction: "Register the base Presentation",
    });
    const base = harness.lifecycle.completePresentation({
      jobId: created.jobId,
      presentationRevisionNumber: initial.revision,
      presentationBlob: await putPresentationBlob(harness.blobStore, initial),
    });
    harness.lifecycle.beginCapability({
      projectId: harness.projectId,
      presentationId: harness.presentationId,
      queryId: asQueryId("query-apply-crash"),
      capability: "edit",
      instruction: "Rename after approval",
      basePresentationRevisionId: base.presentationRevisionId,
    });
    const commands = [
      {
        id: "rename-after-crash",
        type: "set-presentation-title" as const,
        title: "Must not be applied",
      },
    ];
    const commandsBlob = await harness.blobStore.put(
      Buffer.from(JSON.stringify(commands), "utf8"),
      "application/json",
    );
    const proposal = harness.lifecycle.recordCommandProposal({
      jobId: created.jobId,
      queryId: asQueryId("query-apply-crash"),
      summary: "Rename after approval",
      commandsBlob,
      commandCount: commands.length,
      modelRisk: "low",
      gate: { risk: "low", decision: "REQUIRES_APPROVAL" },
      basePresentationRevisionNumber: initial.revision,
      basePresentationRevisionId: base.presentationRevisionId,
    }).proposal;
    const claimInput = {
      jobId: created.jobId,
      operation: "apply" as const,
      key: `proposal:${proposal.proposalId}`,
      claimedAt: "2026-07-31T00:00:00.000Z",
    };
    expect(harness.repository.claimSideEffect(claimInput)).toEqual({ type: "claimed" });

    await expect(
      harness.commitService.applyProposal(commands, {
        jobId: created.jobId,
        proposalId: proposal.proposalId,
      }),
    ).rejects.toThrow(/already in progress/);

    expect(harness.commandBus.getSnapshot()).toEqual(initial);
    expect(harness.sessionStore.getSession(harness.sessionId).presentation).toEqual(initial);
    expect(harness.repository.claimSideEffect(claimInput)).toEqual({ type: "in_progress" });
    expect(harness.lifecycle.getProjection(harness.presentationId)).toMatchObject({
      status: "waiting_user",
      proposalId: proposal.proposalId,
      proposalStatus: "waiting_approval",
      waitingReason: expect.stringContaining("unproven outcome"),
    });
    expect(
      harness.repository
        .listArtifactRevisions(created.jobId)
        .filter((revision) => revision.kind === "presentation_revision"),
    ).toHaveLength(1);
  });

  it("commits a proven interrupted export without invoking export again", async () => {
    const harness = await createExportHarness("ppt-export-proven-");
    const filePath = join(harness.root, "already-written.pptx");
    await exportToPptx(harness.presentation, {}, filePath);
    const before = await readFile(filePath);
    const effectKey = hashArtifactValue({
      presentationRevisionId: harness.presentationRevisionId,
      options: {},
      destination: filePath,
    });
    const claimInput = {
      jobId: harness.jobId,
      operation: "export" as const,
      key: effectKey,
      claimedAt: "2026-07-31T00:00:00.000Z",
    };
    expect(harness.repository.claimSideEffect(claimInput)).toEqual({ type: "claimed" });

    const recovered = await recoverInterruptedExport({
      lifecycle: harness.lifecycle,
      jobId: harness.jobId,
      effectKey,
      presentationRevisionId: harness.presentationRevisionId,
      presentation: harness.presentation,
      options: {},
      destination: filePath,
      format: "pptx",
    });

    expect(await readFile(filePath)).toEqual(before);
    expect(recovered).toMatchObject({
      destination: filePath,
      byteLength: before.byteLength,
      proof: {
        passed: true,
        validator: "pptx-postflight",
        slideCount: harness.presentation.slides.length,
      },
      state: {
        status: "completed",
        currentStage: "export",
        exportArtifactRevisionId: expect.any(String),
      },
    });
    expect(harness.repository.claimSideEffect(claimInput)).toMatchObject({
      type: "succeeded",
      result: {
        destination: filePath,
        fileHash: recovered.fileHash,
        byteLength: before.byteLength,
        format: "pptx",
        exportArtifactRevisionId: recovered.state.exportArtifactRevisionId,
      },
    });
    expect(
      harness.repository
        .listArtifactRevisions(harness.jobId)
        .filter((revision) => revision.kind === "export_artifact"),
    ).toHaveLength(1);
  });

  it("moves an unproven interrupted export to waiting_user without replay", async () => {
    const harness = await createExportHarness("ppt-export-unproven-");
    const filePath = join(harness.root, "uncertain.pptx");
    const uncertainBytes = Buffer.from("not the proven export");
    await writeFile(filePath, uncertainBytes);
    const effectKey = hashArtifactValue({
      presentationRevisionId: harness.presentationRevisionId,
      options: {},
      destination: filePath,
    });
    const claimInput = {
      jobId: harness.jobId,
      operation: "export" as const,
      key: effectKey,
      claimedAt: "2026-07-31T00:00:00.000Z",
    };
    expect(harness.repository.claimSideEffect(claimInput)).toEqual({ type: "claimed" });

    await expect(
      recoverInterruptedExport({
        lifecycle: harness.lifecycle,
        jobId: harness.jobId,
        effectKey,
        presentationRevisionId: harness.presentationRevisionId,
        presentation: harness.presentation,
        options: {},
        destination: filePath,
        format: "pptx",
      }),
    ).rejects.toThrow(/Choose a new destination/);

    expect(await readFile(filePath)).toEqual(uncertainBytes);
    expect(harness.repository.claimSideEffect(claimInput)).toEqual({ type: "in_progress" });
    expect(harness.lifecycle.getProjection(harness.presentationId)).toMatchObject({
      status: "waiting_user",
      stage: "intent",
      waitingReason: expect.stringContaining("unproven outcome"),
    });
    expect(
      harness.repository
        .listArtifactRevisions(harness.jobId)
        .filter((revision) => revision.kind === "export_artifact"),
    ).toHaveLength(0);
  });
});

function gatewayFor(turns: AgentModelContentBlock[][]): AgentModelGateway & {
  requests: AgentModelRequest[];
} {
  let index = 0;
  const requests: AgentModelRequest[] = [];
  return {
    requests,
    async queryModel(request): Promise<AgentModelResponse> {
      requests.push(request);
      const content = turns[index++];
      if (!content) throw new Error("Unexpected gateway call.");
      return { provider: "openai", model: "test", content };
    },
    async *queryModelStream(request) {
      const response = await this.queryModel(request);
      yield { type: "complete" as const, content: response.content };
    },
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): AgentModelContentBlock {
  return { type: "tool_use", id, name, input };
}

type SvgSubmission = Parameters<typeof submitSvgDeckTool.execute>[0];

function svgSubmission(): SvgSubmission {
  return {
    title: "Cross-query SVG deck",
    designSpecPath: "design/design-spec.json",
    pagePlanPath: "slides/page-plan.json",
    communication: {
      audience: "Executive team",
      objective: "Make a decision",
      desiredOutcome: "Approve",
      coreMessage: "The lifecycle is coherent",
      deliveryContext: "Board meeting",
      afterUse: "Decision record",
    },
    designSystem: DEFAULT_DESIGN_SYSTEM,
    slides: [
      {
        id: "P01",
        title: "Lifecycle",
        path: "slides/svg/P01.svg",
        narrative: {
          role: "cover",
          coreMessage: "The lifecycle is coherent",
          audienceMove: "Build confidence",
          rhythm: "anchor",
          layoutIntent: "One dominant statement.",
        },
      },
    ],
    summary: "Create the SVG-native lifecycle deck.",
    risk: "medium",
  };
}

async function writeSvgSubmission(
  fileService: WorkspaceFileService,
  submission: SvgSubmission,
): Promise<void> {
  await fileService.write(
    "slides/svg/P01.svg",
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"',
      ' viewBox="0 0 1280 720">',
      '<rect width="1280" height="720" fill="#111827"/>',
      '<text x="80" y="180" fill="#fff" font-size="64">Lifecycle</text>',
      "</svg>",
    ].join(""),
  );
  await fileService.write(
    "design/design-spec.json",
    JSON.stringify({
      version: 1,
      canvas: { width: 1280, height: 720 },
      communicationContract: submission.communication,
      presentationDesignSystem: submission.designSystem,
      argumentMode: submission.designSystem.argumentMode,
      visualStyle: { id: submission.designSystem.visualStyle },
      readingMode: submission.designSystem.readingMode,
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
          finalCopy: { title: "Lifecycle" },
          coreMessage: "The lifecycle is coherent",
          audienceMove: "Build confidence",
          rhythm: "anchor",
          layoutIntent: "One dominant statement.",
        },
      ],
    }),
  );
}

async function createTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function createSessionStore(root: string): Promise<FileSessionStore> {
  const store = new FileSessionStore(join(root, "conversations.sqlite"), join(root, "projects"));
  sessionStores.push(store);
  await store.initialize();
  return store;
}

function createSharedRepository(store: FileSessionStore): PresentationLifecycleRepository {
  const repository = new PresentationLifecycleRepository({
    filePath: store.conversationDatabase.filePath,
    connection: store.conversationDatabase.sqliteConnection,
  });
  repositories.push(repository);
  return repository;
}

function beginRun(
  store: FileSessionStore,
  sessionId: string,
  runId: string,
  request: string,
): void {
  store.conversationDatabase.beginRun({
    runId,
    sessionId,
    threadId: runId,
    request,
  });
}

function finishRun(store: FileSessionStore, runId: string, result: unknown): void {
  store.conversationDatabase.finishRun({
    runId,
    status: "completed",
    result,
    threadId: runId,
  });
}

function loadRun(
  store: FileSessionStore,
  runId: string,
):
  | {
      status: string;
      query_id: string | null;
      result_json: string | null;
    }
  | undefined {
  return store.conversationDatabase.sqliteConnection
    .prepare(`
    SELECT status, query_id, result_json
    FROM runs
    WHERE run_id = ?
  `)
    .get(runId) as
    | {
        status: string;
        query_id: string | null;
        result_json: string | null;
      }
    | undefined;
}

async function createCommitHarness(prefix: string) {
  const root = await createTemporaryRoot(prefix);
  const sessionStore = await createSessionStore(root);
  const bootstrap = await sessionStore.createSession({
    title: "Commit crash boundary",
  });
  const sessionId = bootstrap.activeSession!.session.id;
  const presentation = bootstrap.activeSession!.presentation;
  const presentationId = asPresentationId(presentation.id);
  const projectId = asProjectId("apply-crash-project");
  const repository = createSharedRepository(sessionStore);
  const lifecycle = new PresentationLifecycleOrchestrator(repository);
  const blobStore = new ContentAddressedBlobStore(join(root, "blobs"));
  const commandBus = new CommandBus(presentation);
  return {
    root,
    sessionStore,
    sessionId,
    presentationId,
    projectId,
    repository,
    lifecycle,
    blobStore,
    commandBus,
    commitService: new PresentationCommitService(
      sessionId,
      projectId,
      presentationId,
      commandBus,
      sessionStore,
      lifecycle,
      blobStore,
    ),
  };
}

async function createExportHarness(prefix: string): Promise<{
  root: string;
  repository: PresentationLifecycleRepository;
  lifecycle: PresentationLifecycleOrchestrator;
  presentation: Presentation;
  presentationId: PresentationId;
  presentationRevisionId: PresentationRevisionId;
  jobId: PptJobId;
}> {
  const root = await createTemporaryRoot(prefix);
  const repository = new PresentationLifecycleRepository(join(root, "lifecycle.sqlite"));
  repositories.push(repository);
  const lifecycle = new PresentationLifecycleOrchestrator(repository);
  const blobStore = new ContentAddressedBlobStore(join(root, "blobs"));
  const presentationId = asPresentationId(`${prefix}presentation`);
  const presentation = {
    ...createStarterPresentation(),
    id: presentationId,
    title: "Interrupted export",
  };
  const created = lifecycle.beginCapability({
    projectId: asProjectId(`${prefix}project`),
    presentationId,
    queryId: asQueryId(`${prefix}create-query`),
    capability: "create",
    instruction: "Register the authoritative Presentation",
  });
  const applied = lifecycle.completePresentation({
    jobId: created.jobId,
    presentationRevisionNumber: presentation.revision,
    presentationBlob: await putPresentationBlob(blobStore, presentation),
  });
  if (!applied.presentationRevisionId) {
    throw new Error("Expected a PresentationRevision.");
  }
  lifecycle.beginCapability({
    projectId: asProjectId(`${prefix}project`),
    presentationId,
    queryId: asQueryId(`${prefix}export-query`),
    capability: "export",
    instruction: "Export the authoritative Presentation",
    basePresentationRevisionId: applied.presentationRevisionId,
  });
  return {
    root,
    repository,
    lifecycle,
    presentation,
    presentationId,
    presentationRevisionId: applied.presentationRevisionId,
    jobId: created.jobId,
  };
}

async function putPresentationBlob(
  blobStore: ContentAddressedBlobStore,
  presentation: Presentation,
) {
  return blobStore.put(
    Buffer.from(canonicalJson(presentation), "utf8"),
    "application/vnd.agent-ppt.presentation+json",
  );
}
