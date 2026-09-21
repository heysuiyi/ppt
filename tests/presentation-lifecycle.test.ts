import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentAddressedBlobStore } from "@main/presentation-lifecycle/content-addressed-blob-store";
import { PresentationCommitService } from "@main/presentation-lifecycle/presentation-commit-service";
import { PresentationLifecycleOrchestrator } from "@main/presentation-lifecycle/presentation-lifecycle-orchestrator";
import { PresentationLifecycleRepository } from "@main/presentation-lifecycle/presentation-lifecycle-repository";
import { FileSessionStore } from "@main/session-store";
import { canonicalJson, hashArtifactValue } from "@ppt/core/artifact-hash";
import { CommandBus } from "@shared/commands";
import type { Presentation } from "@shared/presentation";
import { createStarterPresentation } from "@shared/presentation-fixtures";
import {
  type ArtifactDependency,
  asArtifactId,
  asPresentationId,
  asProjectId,
  asProposalId,
  asQueryId,
  pptProposalSchema,
  type ValidationReport,
} from "@shared/presentation-lifecycle";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];
const repositories: PresentationLifecycleRepository[] = [];
const sessionStores: FileSessionStore[] = [];
const NOW = "2026-07-30T00:00:00.000Z";

async function createLifecycle() {
  const directory = await mkdtemp(join(tmpdir(), "ppt-lifecycle-"));
  temporaryDirectories.push(directory);
  const repository = new PresentationLifecycleRepository(join(directory, "conversations.sqlite"));
  repositories.push(repository);
  return {
    directory,
    repository,
    orchestrator: new PresentationLifecycleOrchestrator(repository),
  };
}

async function createCommitService() {
  const directory = await mkdtemp(join(tmpdir(), "ppt-lifecycle-commit-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "conversations.sqlite");
  const sessionStore = new FileSessionStore(filePath, join(directory, "projects"));
  sessionStores.push(sessionStore);
  await sessionStore.initialize();
  const bootstrap = await sessionStore.createSession({
    title: "Lifecycle commit test",
  });
  const sessionId = bootstrap.activeSession!.session.id;
  const presentation = bootstrap.activeSession!.presentation;
  const repository = new PresentationLifecycleRepository({
    filePath,
    connection: sessionStore.conversationDatabase.sqliteConnection,
  });
  repositories.push(repository);
  const orchestrator = new PresentationLifecycleOrchestrator(repository);
  const commandBus = new CommandBus(presentation);
  const projectId = asProjectId("project-commit-test");
  const presentationId = asPresentationId(presentation.id);
  const blobStore = new ContentAddressedBlobStore(join(directory, "blobs"));
  return {
    directory,
    sessionId,
    sessionStore,
    repository,
    orchestrator,
    commandBus,
    projectId,
    presentationId,
    blobStore,
    service: new PresentationCommitService(
      sessionId,
      projectId,
      presentationId,
      commandBus,
      sessionStore,
      orchestrator,
      blobStore,
    ),
  };
}

function putJsonBlob(directory: string, value: unknown, mediaType = "application/json") {
  return new ContentAddressedBlobStore(join(directory, "blobs")).put(
    Buffer.from(canonicalJson(value), "utf8"),
    mediaType,
  );
}

function presentationFixture(
  presentationId: ReturnType<typeof asPresentationId>,
  revision: number,
  title = "Lifecycle presentation",
): Presentation {
  return {
    ...createStarterPresentation(),
    id: presentationId,
    title,
    revision,
    slides: [],
  };
}

function putPresentationBlob(directory: string, presentation: Presentation) {
  return putJsonBlob(directory, presentation, "application/vnd.agent-ppt.presentation+json");
}

function passed(validator = "test"): ValidationReport {
  return {
    status: "passed",
    validator,
    issues: [],
    validatedAt: NOW,
  };
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    try {
      repository.close();
    } catch {
      // Individual tests may close early; cleanup remains idempotent.
    }
  }
  for (const store of sessionStores.splice(0)) {
    try {
      store.close();
    } catch {
      // Cleanup remains idempotent when a test closes its store explicitly.
    }
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("presentation lifecycle", () => {
  it("uses canonical JSON and content-addressed blobs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppt-blobs-"));
    temporaryDirectories.push(directory);
    const store = new ContentAddressedBlobStore(directory);
    const bytes = Buffer.from("<svg>hello</svg>", "utf8");

    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(hashArtifactValue({ a: 1, b: 2 })).toBe(hashArtifactValue({ b: 2, a: 1 }));

    const first = await store.put(bytes, "image/svg+xml");
    const second = await store.put(bytes, "image/svg+xml");
    expect(second).toEqual(first);
    await expect(store.get(first)).resolves.toEqual(bytes);
  });

  it("requires Proposal resolution timestamps to match terminal status", () => {
    const proposal = {
      proposalId: "proposal-schema",
      jobId: "job-schema",
      requestId: "request-schema",
      queryId: "query-schema",
      artifactRevisionId: "revision-schema",
      basePresentationRevisionNumber: 0,
      createdAt: NOW,
    };
    expect(
      pptProposalSchema.safeParse({
        ...proposal,
        status: "waiting_approval",
      }).success,
    ).toBe(true);
    expect(
      pptProposalSchema.safeParse({
        ...proposal,
        status: "waiting_approval",
        resolvedAt: "2026-07-30T00:01:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      pptProposalSchema.safeParse({
        ...proposal,
        status: "rejected",
      }).success,
    ).toBe(false);
    expect(
      pptProposalSchema.safeParse({
        ...proposal,
        status: "rejected",
        resolvedAt: "2026-07-30T00:01:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("requires a durable canonical Presentation blob with matching identity", async () => {
    const { directory, repository, orchestrator } = await createLifecycle();
    const presentationId = asPresentationId("presentation-blob-proof");
    const state = orchestrator.beginCapability({
      projectId: asProjectId("project-blob-proof"),
      presentationId,
      queryId: asQueryId("query-blob-proof"),
      capability: "create",
      instruction: "Create",
      requestedAt: NOW,
    });
    const store = new ContentAddressedBlobStore(join(directory, "blobs"));
    const presentation = presentationFixture(presentationId, 1);
    const validReference = await putPresentationBlob(directory, presentation);

    await rm(store.pathFor(validReference.contentHash));
    expect(() =>
      orchestrator.completePresentation({
        jobId: state.jobId,
        presentationRevisionNumber: 1,
        presentationBlob: validReference,
      }),
    ).toThrow();
    expect(
      repository
        .listArtifactRevisions(state.jobId)
        .filter((revision) => revision.kind === "presentation_revision"),
    ).toHaveLength(0);

    const restoredReference = await putPresentationBlob(directory, presentation);
    expect(() =>
      orchestrator.completePresentation({
        jobId: state.jobId,
        presentationRevisionNumber: 1,
        presentationBlob: {
          ...restoredReference,
          byteLength: restoredReference.byteLength + 1,
        },
      }),
    ).toThrow(/failed integrity validation/);

    const wrongIdentityReference = await putPresentationBlob(
      directory,
      presentationFixture(asPresentationId("another-presentation"), 1),
    );
    expect(() =>
      orchestrator.completePresentation({
        jobId: state.jobId,
        presentationRevisionNumber: 1,
        presentationBlob: wrongIdentityReference,
      }),
    ).toThrow(/identity or CAS revision does not match/);

    expect(
      orchestrator.completePresentation({
        jobId: state.jobId,
        presentationRevisionNumber: 1,
        presentationBlob: restoredReference,
      }),
    ).toMatchObject({
      status: "completed",
      presentationRevisionNumber: 1,
    });
  });

  it("keeps one job per presentation while queries remain distinct", async () => {
    const { repository, orchestrator } = await createLifecycle();
    const projectId = asProjectId("project-1");
    const presentationId = asPresentationId("presentation-1");
    const query1 = asQueryId("query-1");
    const first = orchestrator.beginCapability({
      projectId,
      presentationId,
      queryId: query1,
      capability: "create",
      instruction: "Create a board deck",
      requestedAt: NOW,
    });
    const replay = orchestrator.beginCapability({
      projectId,
      presentationId,
      queryId: query1,
      capability: "create",
      instruction: "Create a board deck",
      requestedAt: NOW,
    });
    const second = orchestrator.beginCapability({
      projectId,
      presentationId,
      queryId: asQueryId("query-2"),
      capability: "edit",
      instruction: "Shorten page two",
      requestedAt: "2026-07-30T00:01:00.000Z",
    });

    expect(replay.jobId).toBe(first.jobId);
    expect(second.jobId).toBe(first.jobId);
    expect(second.currentRequest.queryId).toBe("query-2");
    expect(
      repository
        .listArtifactRevisions(first.jobId)
        .filter((revision) => revision.stage === "intent"),
    ).toHaveLength(2);
    repository.close();
  });

  it("commits only validated revisions and propagates exact stale dependencies", async () => {
    const { repository, orchestrator } = await createLifecycle();
    const state = orchestrator.beginCapability({
      projectId: asProjectId("project-1"),
      presentationId: asPresentationId("presentation-1"),
      queryId: asQueryId("query-1"),
      capability: "create",
      instruction: "Create",
      requestedAt: NOW,
    });
    const design1 = orchestrator.commitArtifact({
      jobId: state.jobId,
      artifactId: "design-spec",
      kind: "design_spec",
      stage: "design_spec",
      value: { theme: "light" },
      validation: passed("design-spec"),
      idempotencyKey: "design-1",
      committedAt: "2026-07-30T00:01:00.000Z",
    });
    const dependency: ArtifactDependency = {
      artifactId: design1.pointer.artifactId,
      revisionId: design1.pointer.revisionId,
      contentHash: design1.pointer.contentHash,
    };
    const page = orchestrator.commitArtifact({
      jobId: state.jobId,
      artifactId: "page:P01",
      kind: "page_svg",
      stage: "page_svg",
      value: { markup: "<svg />" },
      dependencies: [dependency],
      validation: passed("svg"),
      idempotencyKey: "page-1",
      committedAt: "2026-07-30T00:02:00.000Z",
    });

    expect(() =>
      orchestrator.commitArtifact({
        jobId: state.jobId,
        artifactId: "invalid",
        kind: "quality_report",
        stage: "quality",
        value: { ok: false },
        validation: {
          status: "failed",
          validator: "quality",
          issues: [
            {
              severity: "error",
              code: "bad",
              message: "Invalid candidate",
            },
          ],
          validatedAt: NOW,
        },
        idempotencyKey: "invalid",
      }),
    ).toThrow(/Only validated/);
    expect(() =>
      orchestrator.commitArtifact({
        jobId: state.jobId,
        artifactId: "wrong-stage",
        kind: "quality_report",
        stage: "candidate",
        value: { ok: true },
        validation: passed("quality"),
        idempotencyKey: "wrong-stage",
      }),
    ).toThrow(/must be committed at stage quality/);

    orchestrator.commitArtifact({
      jobId: state.jobId,
      artifactId: "design-spec",
      kind: "design_spec",
      stage: "design_spec",
      value: { theme: "dark" },
      validation: passed("design-spec"),
      idempotencyKey: "design-2",
      committedAt: "2026-07-30T00:03:00.000Z",
    });
    const advanced = repository.getJob(state.jobId)!;
    expect(advanced.staleArtifacts).toEqual([
      expect.objectContaining({
        artifactId: asArtifactId("page:P01"),
        revisionId: page.pointer.revisionId,
        staleBecause: dependency,
      }),
    ]);
    expect(() =>
      orchestrator.commitArtifact({
        jobId: state.jobId,
        artifactId: "page:P02",
        kind: "page_svg",
        stage: "page_svg",
        value: { markup: "<svg />" },
        dependencies: [dependency],
        validation: passed("svg"),
        idempotencyKey: "page-2-with-historical-design",
      }),
    ).toThrow(/not the current non-stale head/);
    expect(() =>
      orchestrator.commitArtifact({
        jobId: state.jobId,
        artifactId: "preview:P01",
        kind: "preview_receipt",
        stage: "preview",
        value: { rendered: true },
        dependencies: [
          {
            artifactId: page.pointer.artifactId,
            revisionId: page.pointer.revisionId,
            contentHash: page.pointer.contentHash,
          },
        ],
        validation: passed("preview"),
        idempotencyKey: "preview-with-stale-page",
      }),
    ).toThrow(/not the current non-stale head/);
    repository.close();
  });

  it("rejects Proposals whose artifact or request belongs to another Job", async () => {
    const { repository, orchestrator } = await createLifecycle();
    const first = orchestrator.beginCapability({
      projectId: asProjectId("proposal-project"),
      presentationId: asPresentationId("proposal-presentation-1"),
      queryId: asQueryId("proposal-query-1"),
      capability: "edit",
      instruction: "Edit the first deck",
      requestedAt: NOW,
    });
    const second = orchestrator.beginCapability({
      projectId: asProjectId("proposal-project"),
      presentationId: asPresentationId("proposal-presentation-2"),
      queryId: asQueryId("proposal-query-2"),
      capability: "edit",
      instruction: "Edit the second deck",
      requestedAt: NOW,
    });
    const artifact = orchestrator.commitArtifact({
      jobId: first.jobId,
      artifactId: "proposal:first",
      kind: "command_proposal",
      stage: "proposal",
      value: { summary: "First deck proposal" },
      validation: passed("commit-gate"),
      idempotencyKey: "proposal:first",
      committedAt: "2026-07-30T00:01:00.000Z",
    });

    expect(() =>
      orchestrator.recordProposal({
        jobId: second.jobId,
        proposalArtifactRevisionId: artifact.pointer.revisionId,
        basePresentationRevisionNumber: 0,
        createdAt: "2026-07-30T00:02:00.000Z",
      }),
    ).toThrow(/current non-stale command_proposal artifact/);
    expect(() =>
      repository.createProposal({
        proposalId: asProposalId("cross-job-proposal"),
        jobId: second.jobId,
        requestId: second.currentRequest.requestId,
        queryId: second.currentRequest.queryId,
        artifactRevisionId: artifact.pointer.revisionId,
        basePresentationRevisionNumber: 0,
        status: "waiting_approval",
        createdAt: "2026-07-30T00:02:00.000Z",
      }),
    ).toThrow(/command_proposal artifact from the same PptJob/);
    expect(repository.getJob(second.jobId)?.status).toBe("running");
    expect(repository.getJob(second.jobId)?.proposalId).toBeUndefined();
  });

  it("isolates projection listeners and discards notifications on outer rollback", async () => {
    const {
      sessionId,
      sessionStore,
      repository,
      orchestrator,
      commandBus,
      projectId,
      presentationId,
    } = await createCommitService();
    const projections: unknown[] = [];
    orchestrator.subscribe((projection) => {
      projections.push(projection);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    orchestrator.subscribe(() => {
      throw new Error("broken projection consumer");
    });

    await expect(
      orchestrator.withProjectionNotificationBatch(() =>
        sessionStore.commitPresentationTransaction({
          sessionId,
          presentation: commandBus.getSnapshot(),
          commitLifecycle: () => {
            orchestrator.beginCapability({
              projectId,
              presentationId,
              queryId: asQueryId("rolled-back-query"),
              capability: "edit",
              instruction: "This transaction will roll back",
              requestedAt: NOW,
            });
            throw new Error("force outer rollback");
          },
        }),
      ),
    ).rejects.toThrow(/force outer rollback/);
    expect(projections).toEqual([]);
    expect(repository.getJobByPresentationId(presentationId)).toBeUndefined();

    expect(() =>
      orchestrator.beginCapability({
        projectId,
        presentationId,
        queryId: asQueryId("committed-query"),
        capability: "edit",
        instruction: "This transaction commits",
        requestedAt: NOW,
      }),
    ).not.toThrow();
    expect(projections).toHaveLength(1);
    expect(repository.getJobByPresentationId(presentationId)?.status).toBe("running");
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("separates proposal readiness from committed Presentation", async () => {
    const { directory, repository, orchestrator } = await createLifecycle();
    const initial = orchestrator.beginCapability({
      projectId: asProjectId("project-1"),
      presentationId: asPresentationId("presentation-1"),
      queryId: asQueryId("query-1"),
      capability: "edit",
      instruction: "Change the title",
      requestedAt: NOW,
    });
    const proposalArtifact = orchestrator.commitArtifact({
      jobId: initial.jobId,
      artifactId: "proposal:query-1",
      kind: "command_proposal",
      stage: "proposal",
      value: { commands: [{ type: "set-presentation-title", title: "Next" }] },
      validation: passed("commit-gate"),
      idempotencyKey: "proposal-artifact-1",
      committedAt: "2026-07-30T00:01:00.000Z",
    });
    const proposal = orchestrator.recordProposal({
      jobId: initial.jobId,
      proposalArtifactRevisionId: proposalArtifact.pointer.revisionId,
      basePresentationRevisionNumber: 0,
      createdAt: "2026-07-30T00:02:00.000Z",
    });

    expect(repository.getJob(initial.jobId)).toMatchObject({
      status: "waiting_approval",
      proposalId: proposal.proposalId,
    });
    expect(repository.getJob(initial.jobId)?.presentationRevisionId).toBeUndefined();

    const presentation = presentationFixture(asPresentationId("presentation-1"), 1);
    const completed = orchestrator.completePresentation({
      jobId: initial.jobId,
      proposalId: proposal.proposalId,
      presentationRevisionNumber: 1,
      presentationBlob: await putPresentationBlob(directory, presentation),
      completedAt: "2026-07-30T00:03:00.000Z",
    });
    expect(completed).toMatchObject({
      status: "completed",
      currentStage: "presentation",
      presentationRevisionNumber: 1,
    });
    expect(repository.getProposal(proposal.proposalId)?.status).toBe("applied");
    repository.close();
  });

  it("records a stable recoverable proposal and rejects it without replacing Presentation", async () => {
    const { directory, repository, orchestrator } = await createLifecycle();
    const presentationId = asPresentationId("presentation-stable");
    const created = orchestrator.beginCapability({
      projectId: asProjectId("project-1"),
      presentationId,
      queryId: asQueryId("query-create"),
      capability: "create",
      instruction: "Create",
      requestedAt: NOW,
    });
    const initialPresentation = orchestrator.completePresentation({
      jobId: created.jobId,
      presentationRevisionNumber: 1,
      presentationBlob: await putPresentationBlob(
        directory,
        presentationFixture(presentationId, 1),
      ),
      completedAt: "2026-07-30T00:01:00.000Z",
    });
    orchestrator.beginCapability({
      projectId: asProjectId("project-1"),
      presentationId,
      queryId: asQueryId("query-edit"),
      capability: "edit",
      instruction: "Rename",
      basePresentationRevisionId: initialPresentation.presentationRevisionId,
      requestedAt: "2026-07-30T00:02:00.000Z",
    });
    const commands = [
      {
        id: "rename-1",
        type: "set-presentation-title" as const,
        title: "Renamed",
      },
    ];
    const commandsBlob = await new ContentAddressedBlobStore(join(directory, "blobs")).put(
      Buffer.from(JSON.stringify(commands), "utf8"),
      "application/json",
    );
    const input = {
      jobId: created.jobId,
      queryId: asQueryId("query-edit"),
      summary: "Rename",
      commandsBlob,
      commandCount: commands.length,
      modelRisk: "low" as const,
      gate: {
        risk: "low" as const,
        decision: "REQUIRES_APPROVAL" as const,
      },
      basePresentationRevisionNumber: 1,
      basePresentationRevisionId: initialPresentation.presentationRevisionId,
    };
    const first = orchestrator.recordCommandProposal({
      ...input,
      createdAt: "2026-07-30T00:03:00.000Z",
    });
    const replay = orchestrator.recordCommandProposal({
      ...input,
      createdAt: "2026-07-30T00:04:00.000Z",
    });

    expect(replay.proposal.proposalId).toBe(first.proposal.proposalId);
    expect(replay.artifact.revisionId).toBe(first.artifact.revisionId);
    expect(orchestrator.getCommandProposalArtifact(first.proposal.proposalId).value).toMatchObject({
      summary: "Rename",
      modelRisk: "low",
      commandsBlob,
      commandCount: 1,
    });

    const rejected = orchestrator.rejectProposal(first.proposal.proposalId);
    expect(repository.getProposal(first.proposal.proposalId)?.status).toBe("rejected");
    expect(rejected.presentationRevisionId).toBe(initialPresentation.presentationRevisionId);
    expect(rejected.presentationRevisionNumber).toBe(1);
    repository.close();
  });

  it("claims apply/export effects without blind replay", async () => {
    const { repository, orchestrator } = await createLifecycle();
    const state = orchestrator.beginCapability({
      projectId: asProjectId("project-1"),
      presentationId: asPresentationId("presentation-1"),
      capability: "export",
      instruction: "Export",
      requestedAt: NOW,
    });
    const claim = {
      jobId: state.jobId,
      operation: "export" as const,
      key: "revision-1:pptx:C:/deck.pptx",
      claimedAt: NOW,
    };
    expect(repository.claimSideEffect(claim)).toEqual({ type: "claimed" });
    expect(repository.claimSideEffect(claim)).toEqual({ type: "in_progress" });
    expect(
      repository.completeSideEffect({
        ...claim,
        status: "succeeded",
        result: { hash: "sha256:done" },
        completedAt: "2026-07-30T00:01:00.000Z",
      }),
    ).toBe(true);
    expect(repository.claimSideEffect(claim)).toEqual({
      type: "succeeded",
      result: { hash: "sha256:done" },
    });
    repository.close();
  });

  it("retains failed and cancelled stage diagnostics without committing revisions", async () => {
    const { repository, orchestrator } = await createLifecycle();
    const state = orchestrator.beginCapability({
      projectId: asProjectId("project-attempts"),
      presentationId: asPresentationId("presentation-attempts"),
      queryId: asQueryId("query-attempts"),
      capability: "create",
      instruction: "Create a deck",
      requestedAt: NOW,
    });
    const intentRevisionCount = repository.listArtifactRevisions(state.jobId).length;

    const failed = orchestrator.startStageAttempt({
      jobId: state.jobId,
      stage: "candidate",
      candidate: { source: "invalid candidate", diagnostics: ["bad schema"] },
      idempotencyKey: "candidate-failed",
      startedAt: "2026-07-30T00:01:00.000Z",
    });
    orchestrator.finishStageAttempt({
      stageRunId: failed.stageRunId,
      status: "failed",
      validation: {
        status: "failed",
        validator: "candidate-schema",
        issues: [
          {
            severity: "error",
            code: "invalid_candidate",
            message: "Candidate schema validation failed.",
          },
        ],
        validatedAt: "2026-07-30T00:01:30.000Z",
      },
      error: "Candidate schema validation failed.",
      completedAt: "2026-07-30T00:02:00.000Z",
    });

    const cancelled = orchestrator.startStageAttempt({
      jobId: state.jobId,
      stage: "candidate",
      candidate: { source: "cancelled candidate" },
      idempotencyKey: "candidate-cancelled",
      startedAt: "2026-07-30T00:03:00.000Z",
    });
    orchestrator.finishStageAttempt({
      stageRunId: cancelled.stageRunId,
      status: "cancelled",
      completedAt: "2026-07-30T00:04:00.000Z",
    });

    expect(repository.listArtifactRevisions(state.jobId)).toHaveLength(intentRevisionCount);
    const attempts = repository.listStageAttempts(state.jobId);
    expect(attempts).toEqual([
      expect.objectContaining({
        stageRunId: failed.stageRunId,
        status: "failed",
        error: "Candidate schema validation failed.",
        candidate: {
          source: "invalid candidate",
          diagnostics: ["bad schema"],
        },
      }),
      expect.objectContaining({
        stageRunId: cancelled.stageRunId,
        status: "cancelled",
        candidate: { source: "cancelled candidate" },
      }),
    ]);
    expect(attempts.every((attempt) => attempt.artifactRevisionId === undefined)).toBe(true);
  });

  it("links a successful stage attempt to its validated committed revision", async () => {
    const { repository, orchestrator } = await createLifecycle();
    const state = orchestrator.beginCapability({
      projectId: asProjectId("project-attempt-success"),
      presentationId: asPresentationId("presentation-attempt-success"),
      queryId: asQueryId("query-attempt-success"),
      capability: "create",
      instruction: "Create a deck",
      requestedAt: NOW,
    });
    const attempt = orchestrator.startStageAttempt({
      jobId: state.jobId,
      stage: "candidate",
      candidate: { commands: [{ type: "set-presentation-title" }] },
      idempotencyKey: "candidate-success",
      startedAt: "2026-07-30T00:01:00.000Z",
    });
    const wrongStage = orchestrator.commitArtifact({
      jobId: state.jobId,
      artifactId: "quality:query-attempt-success",
      kind: "quality_report",
      stage: "quality",
      value: { status: "passed" },
      validation: passed("quality-schema"),
      idempotencyKey: "wrong-stage-revision",
      committedAt: "2026-07-30T00:01:15.000Z",
    });
    expect(() =>
      orchestrator.finishStageAttempt({
        stageRunId: attempt.stageRunId,
        status: "succeeded",
        artifactRevisionId: wrongStage.pointer.revisionId,
        validation: passed("candidate-schema"),
        completedAt: "2026-07-30T00:01:20.000Z",
      }),
    ).toThrow(/same PptJob and stage/);

    const foreign = orchestrator.beginCapability({
      projectId: asProjectId("foreign-attempt-project"),
      presentationId: asPresentationId("foreign-attempt-presentation"),
      queryId: asQueryId("foreign-attempt-query"),
      capability: "create",
      instruction: "Create another deck",
      requestedAt: "2026-07-30T00:01:25.000Z",
    });
    const foreignCandidate = orchestrator.commitArtifact({
      jobId: foreign.jobId,
      artifactId: "candidate:foreign-attempt-query",
      kind: "candidate_deck",
      stage: "candidate",
      value: { presentation: { id: "foreign-attempt-presentation" } },
      validation: passed("candidate-schema"),
      idempotencyKey: "foreign-candidate-revision",
      committedAt: "2026-07-30T00:01:30.000Z",
    });
    expect(() =>
      orchestrator.finishStageAttempt({
        stageRunId: attempt.stageRunId,
        status: "succeeded",
        artifactRevisionId: foreignCandidate.pointer.revisionId,
        validation: passed("candidate-schema"),
        completedAt: "2026-07-30T00:01:35.000Z",
      }),
    ).toThrow(/same PptJob and stage/);

    const candidate = orchestrator.commitArtifact({
      jobId: state.jobId,
      artifactId: "candidate:query-attempt-success",
      kind: "candidate_deck",
      stage: "candidate",
      value: { presentation: { id: "presentation-attempt-success" } },
      validation: passed("candidate-schema"),
      idempotencyKey: "candidate-revision-success",
      committedAt: "2026-07-30T00:02:00.000Z",
    });
    const succeeded = orchestrator.finishStageAttempt({
      stageRunId: attempt.stageRunId,
      status: "succeeded",
      artifactRevisionId: candidate.pointer.revisionId,
      validation: passed("candidate-schema"),
      completedAt: "2026-07-30T00:03:00.000Z",
    });

    expect(succeeded).toMatchObject({
      status: "succeeded",
      artifactRevisionId: candidate.pointer.revisionId,
    });
    expect(repository.getArtifactRevision(succeeded.artifactRevisionId!)).toEqual(
      candidate.revision,
    );
    expect(repository.getJob(state.jobId)?.currentStageRunId).toBeUndefined();

    const replay = orchestrator.startStageAttempt({
      jobId: state.jobId,
      stage: "candidate",
      candidate: { commands: [{ type: "set-presentation-title" }] },
      idempotencyKey: "candidate-success",
    });
    expect(replay).toEqual(succeeded);
    expect(() =>
      orchestrator.startStageAttempt({
        jobId: state.jobId,
        stage: "candidate",
        candidate: { commands: [{ type: "add-slide" }] },
        idempotencyKey: "candidate-success",
      }),
    ).toThrow(/idempotency conflict/);
  });

  it("keeps a completed Query separate from a waiting Proposal and applies it once", async () => {
    const {
      directory,
      sessionId,
      sessionStore,
      repository,
      orchestrator,
      commandBus,
      projectId,
      presentationId,
      blobStore,
      service,
    } = await createCommitService();
    const initialPresentation = commandBus.getSnapshot();
    const create = orchestrator.beginCapability({
      projectId,
      presentationId,
      queryId: asQueryId("query-create-initial"),
      capability: "create",
      instruction: "Register the current presentation",
      requestedAt: NOW,
    });
    const initialState = orchestrator.completePresentation({
      jobId: create.jobId,
      presentationRevisionNumber: initialPresentation.revision,
      presentationBlob: await blobStore.put(
        Buffer.from(canonicalJson(initialPresentation), "utf8"),
        "application/vnd.agent-ppt.presentation+json",
      ),
      completedAt: "2026-07-30T00:01:00.000Z",
    });

    const queryId = asQueryId("query-proposal");
    sessionStore.conversationDatabase.beginRun({
      runId: "run-proposal",
      sessionId,
      threadId: "thread-proposal",
      request: "Rename the deck",
    });
    sessionStore.conversationDatabase.bindRunQueryId("run-proposal", queryId);
    orchestrator.beginCapability({
      projectId,
      presentationId,
      queryId,
      capability: "edit",
      instruction: "Rename the deck",
      basePresentationRevisionId: initialState.presentationRevisionId,
      requestedAt: "2026-07-30T00:02:00.000Z",
    });
    const commands = [
      {
        id: "rename-once",
        type: "set-presentation-title" as const,
        title: "Approved once",
      },
    ];
    const commandsBlob = await new ContentAddressedBlobStore(join(directory, "blobs")).put(
      Buffer.from(JSON.stringify(commands), "utf8"),
      "application/json",
    );
    const proposal = orchestrator.recordCommandProposal({
      jobId: create.jobId,
      queryId,
      summary: "Rename the deck",
      commandsBlob,
      commandCount: commands.length,
      modelRisk: "low",
      gate: {
        risk: "low",
        decision: "REQUIRES_APPROVAL",
      },
      basePresentationRevisionNumber: initialPresentation.revision,
      basePresentationRevisionId: initialState.presentationRevisionId,
      createdAt: "2026-07-30T00:03:00.000Z",
    }).proposal;
    sessionStore.conversationDatabase.finishRun({
      runId: "run-proposal",
      status: "completed",
      result: {
        status: "approval-required",
        proposalId: proposal.proposalId,
      },
      threadId: "thread-proposal",
    });

    expect(sessionStore.conversationDatabase.loadTerminalRunResult("run-proposal")).toEqual({
      status: "approval-required",
      proposalId: proposal.proposalId,
    });
    expect(repository.getJob(create.jobId)).toMatchObject({
      status: "waiting_approval",
      proposalId: proposal.proposalId,
      presentationRevisionId: initialState.presentationRevisionId,
    });
    expect(orchestrator.getProjection(presentationId)).toMatchObject({
      proposalId: proposal.proposalId,
      proposalStatus: "waiting_approval",
      proposalArtifactRevisionId: proposal.artifactRevisionId,
    });

    const [first, concurrentReplay] = await Promise.all([
      service.applyProposal(commands, {
        jobId: create.jobId,
        proposalId: proposal.proposalId,
      }),
      service.applyProposal(commands, {
        jobId: create.jobId,
        proposalId: proposal.proposalId,
      }),
    ]);
    const replay = await service.applyProposal(commands, {
      jobId: create.jobId,
      proposalId: proposal.proposalId,
    });

    expect(first).toMatchObject({ title: "Approved once", revision: 1 });
    expect(concurrentReplay).toEqual(first);
    expect(replay).toEqual(first);
    expect(commandBus.getSnapshot()).toEqual(first);
    expect(sessionStore.getSession(sessionId).presentation).toEqual(first);
    expect(repository.getProposal(proposal.proposalId)?.status).toBe("applied");
    expect(orchestrator.getProjection(presentationId)?.proposalStatus).toBe("applied");
    expect(
      repository
        .listArtifactRevisions(create.jobId)
        .filter((revision) => revision.kind === "presentation_revision"),
    ).toHaveLength(2);
    expect(
      repository.claimSideEffect({
        jobId: create.jobId,
        operation: "apply",
        key: `proposal:${proposal.proposalId}`,
        claimedAt: "2026-07-30T00:05:00.000Z",
      }),
    ).toMatchObject({
      type: "succeeded",
      result: {
        proposalId: proposal.proposalId,
        presentationRevisionNumber: 1,
      },
    });
    const forgedCommandBus = new CommandBus({
      ...first,
      title: "Same revision, different content",
    });
    const recoveringService = new PresentationCommitService(
      sessionId,
      projectId,
      presentationId,
      forgedCommandBus,
      sessionStore,
      orchestrator,
      blobStore,
    );
    await expect(
      recoveringService.applyProposal(commands, {
        jobId: create.jobId,
        proposalId: proposal.proposalId,
      }),
    ).rejects.toThrow(/authoritative Presentation snapshot does not match its durable blob/);
    const foreignJob = orchestrator.beginCapability({
      projectId: asProjectId("foreign-project"),
      presentationId: asPresentationId("foreign-presentation"),
      queryId: asQueryId("foreign-query"),
      capability: "edit",
      instruction: "Edit another presentation",
      requestedAt: "2026-07-30T00:06:00.000Z",
    });
    await expect(
      service.applyProposal(commands, {
        jobId: foreignJob.jobId,
        proposalId: proposal.proposalId,
      }),
    ).rejects.toThrow(/does not belong to this Presentation commit service/);
  });

  it("commits immutable Presentation revisions for direct execute, undo, and redo", async () => {
    const {
      sessionId,
      sessionStore,
      repository,
      orchestrator,
      commandBus,
      presentationId,
      service,
    } = await createCommitService();
    const originalTitle = commandBus.getSnapshot().title;

    const executed = await service.execute({
      id: "direct-title",
      type: "set-presentation-title",
      title: "Direct edit",
    });
    const afterExecute = orchestrator.getState(presentationId)!;
    const stalePresentation = afterExecute.committedArtifacts.find(
      (pointer) => pointer.kind === "presentation_revision",
    )!;
    const waiting = orchestrator.markArtifactSourceChanged({
      jobId: afterExecute.jobId,
      artifactId: stalePresentation.artifactId,
      expectedRevisionId: stalePresentation.revisionId,
      observedContentHash: hashArtifactValue({
        source: "external authoritative edit",
      }),
      reason: "The authoritative Presentation changed outside the lifecycle.",
      waitForUser: true,
      detectedAt: "2026-07-30T00:05:00.000Z",
    });
    expect(waiting).toMatchObject({
      status: "waiting_user",
      currentStage: "presentation",
    });
    expect(waiting.staleArtifacts).toContainEqual(
      expect.objectContaining({
        artifactId: stalePresentation.artifactId,
        revisionId: stalePresentation.revisionId,
      }),
    );

    const undone = await service.undo();
    const rebased = orchestrator.getState(presentationId)!;
    const rebasedPresentation = rebased.committedArtifacts.find(
      (pointer) => pointer.kind === "presentation_revision",
    )!;
    const rebasedRevision = repository.getArtifactRevision(rebasedPresentation.revisionId)!;
    expect(rebasedRevision.dependencies).toContainEqual({
      artifactId: stalePresentation.artifactId,
      revisionId: stalePresentation.revisionId,
      contentHash: stalePresentation.contentHash,
    });
    expect(
      rebased.staleArtifacts.some(
        (artifact) => artifact.artifactId === stalePresentation.artifactId,
      ),
    ).toBe(false);
    const redone = await service.redo();

    expect(executed).toMatchObject({ title: "Direct edit", revision: 1 });
    expect(undone).toMatchObject({ title: originalTitle, revision: 2 });
    expect(redone).toMatchObject({ title: "Direct edit", revision: 3 });
    expect(commandBus.getSnapshot()).toEqual(redone);
    expect(sessionStore.getSession(sessionId).presentation).toEqual(redone);

    const job = orchestrator.getState(presentationId)!;
    const presentationRevisions = repository
      .listArtifactRevisions(job.jobId)
      .filter((revision) => revision.kind === "presentation_revision");
    expect(presentationRevisions).toHaveLength(3);
    expect(new Set(presentationRevisions.map((revision) => revision.revisionId)).size).toBe(3);
    expect(
      presentationRevisions.map((revision) => {
        const value = revision.value as { presentationRevisionNumber: number };
        return value.presentationRevisionNumber;
      }),
    ).toEqual([1, 2, 3]);
    expect(job).toMatchObject({
      status: "completed",
      currentStage: "presentation",
      presentationRevisionNumber: 3,
    });
  });

  it("serializes concurrent Presentation mutations before preparing snapshots", async () => {
    const {
      sessionId,
      sessionStore,
      repository,
      orchestrator,
      commandBus,
      presentationId,
      service,
    } = await createCommitService();

    const [first, second] = await Promise.all([
      service.execute({
        id: "concurrent-title-1",
        type: "set-presentation-title",
        title: "First queued edit",
      }),
      service.execute({
        id: "concurrent-title-2",
        type: "set-presentation-title",
        title: "Second queued edit",
      }),
    ]);

    expect(first).toMatchObject({
      title: "First queued edit",
      revision: 1,
    });
    expect(second).toMatchObject({
      title: "Second queued edit",
      revision: 2,
    });
    expect(commandBus.getSnapshot()).toEqual(second);
    expect(sessionStore.getSession(sessionId).presentation).toEqual(second);

    const job = orchestrator.getState(presentationId)!;
    expect(
      repository
        .listArtifactRevisions(job.jobId)
        .filter((revision) => revision.kind === "presentation_revision"),
    ).toHaveLength(2);
    expect(job).toMatchObject({
      status: "completed",
      presentationRevisionNumber: 2,
    });
  });

  it("recovers a proven export side effect into one idempotent ExportArtifact", async () => {
    const { directory, repository, orchestrator } = await createLifecycle();
    const presentationId = asPresentationId("presentation-export-recovery");
    const created = orchestrator.beginCapability({
      projectId: asProjectId("project-export-recovery"),
      presentationId,
      queryId: asQueryId("query-create-export-recovery"),
      capability: "create",
      instruction: "Create",
      requestedAt: NOW,
    });
    const presentation = presentationFixture(presentationId, 1, "Export recovery");
    const applied = orchestrator.completePresentation({
      jobId: created.jobId,
      presentationRevisionNumber: 1,
      presentationBlob: await putPresentationBlob(directory, presentation),
      completedAt: "2026-07-30T00:01:00.000Z",
    });
    orchestrator.beginCapability({
      projectId: asProjectId("project-export-recovery"),
      presentationId,
      capability: "export",
      instruction: "Export the authoritative presentation",
      basePresentationRevisionId: applied.presentationRevisionId,
      requestedAt: "2026-07-30T00:02:00.000Z",
    });
    const effectKey = "export:revision-1:pptx:C:/exports/recovered.pptx";
    const fileHash = hashArtifactValue("recovered export bytes");
    expect(
      repository.claimSideEffect({
        jobId: created.jobId,
        operation: "export",
        key: effectKey,
        claimedAt: "2026-07-30T00:03:00.000Z",
      }),
    ).toEqual({ type: "claimed" });
    expect(
      repository.completeSideEffect({
        jobId: created.jobId,
        operation: "export",
        key: effectKey,
        status: "succeeded",
        result: {
          destination: "C:/exports/recovered.pptx",
          fileHash,
          byteLength: 42,
        },
        completedAt: "2026-07-30T00:04:00.000Z",
      }),
    ).toBe(true);

    const input = {
      jobId: created.jobId,
      effectKey,
      presentationRevisionId: applied.presentationRevisionId!,
      options: { format: "pptx", includeNotes: false },
      destination: "C:/exports/recovered.pptx",
      format: "pptx" as const,
      fileHash,
      byteLength: 42,
      postflight: { slideCount: 0, verified: true },
      completedAt: "2026-07-30T00:05:00.000Z",
    };
    const recovered = orchestrator.completeExport(input);
    const replay = orchestrator.completeExport(input);

    expect(recovered).toMatchObject({
      status: "completed",
      currentStage: "export",
    });
    expect(replay.exportArtifactRevisionId).toBe(recovered.exportArtifactRevisionId);
    const exports = repository
      .listArtifactRevisions(created.jobId)
      .filter((revision) => revision.kind === "export_artifact");
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({
      revisionId: recovered.exportArtifactRevisionId,
      dependencies: [
        expect.objectContaining({
          revisionId: repository
            .listArtifactRevisions(created.jobId)
            .find((revision) => revision.kind === "presentation_revision")?.revisionId,
        }),
      ],
      value: {
        presentationRevisionId: applied.presentationRevisionId,
        options: { format: "pptx", includeNotes: false },
        destination: "C:/exports/recovered.pptx",
        format: "pptx",
        fileHash,
        byteLength: 42,
        postflight: { slideCount: 0, verified: true },
      },
    });
    expect(
      repository.claimSideEffect({
        jobId: created.jobId,
        operation: "export",
        key: effectKey,
        claimedAt: "2026-07-30T00:06:00.000Z",
      }),
    ).toMatchObject({
      type: "succeeded",
      result: {
        destination: "C:/exports/recovered.pptx",
        fileHash,
        byteLength: 42,
      },
    });
  });
});
