import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@ppt/core/artifact-hash";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../src/main/agent/tools/tool-definition";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { submitPptReviewTool } from "../src/main/plugins/ppt/tools/submit-ppt-review";
import { ContentAddressedBlobStore } from "../src/main/presentation-lifecycle/content-addressed-blob-store";
import { PresentationLifecycleOrchestrator } from "../src/main/presentation-lifecycle/presentation-lifecycle-orchestrator";
import { PresentationLifecycleRepository } from "../src/main/presentation-lifecycle/presentation-lifecycle-repository";
import { PresentationLifecycleToolBridge } from "../src/main/presentation-lifecycle/presentation-lifecycle-tool-bridge";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";
import { asPresentationId, asProjectId, asQueryId } from "../src/shared/presentation-lifecycle";

const directories: string[] = [];
const repositories: PresentationLifecycleRepository[] = [];

afterEach(async () => {
  for (const repository of repositories.splice(0)) {
    try {
      repository.close();
    } catch {
      // A test may close the repository before cleanup.
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "ppt-review-"));
  directories.push(directory);
  const repository = new PresentationLifecycleRepository(join(directory, "lifecycle.sqlite"));
  repositories.push(repository);
  const orchestrator = new PresentationLifecycleOrchestrator(repository);
  const projectId = asProjectId("review-project");
  const presentationId = asPresentationId("review-presentation");
  return { directory, repository, orchestrator, projectId, presentationId };
}

function contextFor(presentationLifecycle: PresentationLifecycleToolBridge): ToolContext {
  const presentation = createStarterPresentation();
  presentation.id = "review-presentation";
  return {
    presentation,
    selectedElementIds: [],
    discoverySession: { discoveredToolNames: new Set() },
    registry: new ToolRegistry(),
    messageHistory: [],
    presentationLifecycle,
  };
}

function report() {
  return {
    verdict: "needs_changes" as const,
    summary: "The deck is coherent but two pages need stronger evidence.",
    overallScore: 82,
    findings: [
      {
        severity: "warning" as const,
        code: "EVIDENCE_GAP",
        message: "The conclusion is not supported by a cited metric.",
        slideId: "slide-1",
        recommendation: "Add the source metric beside the conclusion.",
      },
    ],
  };
}

async function seedPresentation(
  directory: string,
  orchestrator: PresentationLifecycleOrchestrator,
  projectId: ReturnType<typeof asProjectId>,
  presentationId: ReturnType<typeof asPresentationId>,
) {
  const created = orchestrator.beginCapability({
    projectId,
    presentationId,
    queryId: asQueryId("create-query"),
    capability: "create",
    instruction: "Create",
  });
  const presentation = {
    ...createStarterPresentation(),
    id: presentationId,
    revision: 1,
  };
  const presentationBlob = await new ContentAddressedBlobStore(join(directory, "blobs")).put(
    Buffer.from(canonicalJson(presentation), "utf8"),
    "application/vnd.agent-ppt.presentation+json",
  );
  return orchestrator.completePresentation({
    jobId: created.jobId,
    presentationRevisionNumber: 1,
    presentationBlob,
  });
}

describe("SubmitPptReview", () => {
  it("commits a QualityReport against the current PresentationRevision and completes the Job", async () => {
    const { directory, repository, orchestrator, projectId, presentationId } =
      await createHarness();
    const presented = await seedPresentation(directory, orchestrator, projectId, presentationId);
    const bridge = new PresentationLifecycleToolBridge(
      orchestrator,
      projectId,
      presentationId,
      asQueryId("review-query"),
      "Review the deck",
    );
    bridge.beginCapability({
      capability: "review",
      instruction: "Review the deck",
    });

    const projection = await submitPptReviewTool.execute(report(), contextFor(bridge));
    const replay = await submitPptReviewTool.execute(report(), contextFor(bridge));

    expect(projection).toMatchObject({
      capability: "review",
      status: "completed",
      stage: "quality",
      presentationRevisionId: presented.presentationRevisionId,
      presentationRevisionNumber: 1,
    });
    const qualityPointer = projection.committedArtifacts.find(
      (pointer) => pointer.kind === "quality_report",
    );
    expect(
      replay.committedArtifacts.find((pointer) => pointer.kind === "quality_report")?.revisionId,
    ).toBe(qualityPointer?.revisionId);
    const presentationPointer = projection.committedArtifacts.find(
      (pointer) => pointer.kind === "presentation_revision",
    );
    expect(qualityPointer).toBeDefined();
    expect(presentationPointer).toBeDefined();
    const quality = repository.getArtifactRevision(qualityPointer!.revisionId);
    expect(quality?.dependencies).toEqual([
      {
        artifactId: presentationPointer!.artifactId,
        revisionId: presentationPointer!.revisionId,
        contentHash: presentationPointer!.contentHash,
      },
    ]);
    expect(
      repository
        .listArtifactRevisions(projection.jobId)
        .filter((revision) => revision.kind === "presentation_revision"),
    ).toHaveLength(1);
    expect(
      repository
        .listArtifactRevisions(projection.jobId)
        .filter((revision) => revision.kind === "quality_report"),
    ).toHaveLength(1);
  });

  it("requires an active review capability", async () => {
    const { directory, orchestrator, projectId, presentationId } = await createHarness();
    await seedPresentation(directory, orchestrator, projectId, presentationId);
    const bridge = new PresentationLifecycleToolBridge(
      orchestrator,
      projectId,
      presentationId,
      asQueryId("edit-query"),
      "Edit",
    );
    bridge.beginCapability({ capability: "edit", instruction: "Edit" });

    await expect(submitPptReviewTool.execute(report(), contextFor(bridge))).rejects.toThrow(
      "cannot use this tool",
    );
  });

  it("rejects review without a current PresentationRevision", async () => {
    const { orchestrator, projectId, presentationId } = await createHarness();
    const bridge = new PresentationLifecycleToolBridge(
      orchestrator,
      projectId,
      presentationId,
      asQueryId("review-query"),
      "Review",
    );
    bridge.beginCapability({ capability: "review", instruction: "Review" });

    await expect(submitPptReviewTool.execute(report(), contextFor(bridge))).rejects.toThrow(
      "current non-stale PresentationRevision",
    );
  });

  it("rejects review when the current PresentationRevision is stale", async () => {
    const { directory, repository, orchestrator, projectId, presentationId } =
      await createHarness();
    await seedPresentation(directory, orchestrator, projectId, presentationId);
    const bridge = new PresentationLifecycleToolBridge(
      orchestrator,
      projectId,
      presentationId,
      asQueryId("review-query"),
      "Review",
    );
    const active = bridge.beginCapability({
      capability: "review",
      instruction: "Review",
    });
    const state = repository.getJob(active.jobId)!;
    const presentationPointer = state.committedArtifacts.find(
      (pointer) => pointer.kind === "presentation_revision",
    )!;
    repository.updateJobStateCas({
      expectedStateRevision: state.stateRevision,
      nextState: {
        ...state,
        stateRevision: state.stateRevision + 1,
        staleArtifacts: [
          {
            artifactId: presentationPointer.artifactId,
            revisionId: presentationPointer.revisionId,
            staleBecause: {
              artifactId: presentationPointer.artifactId,
              revisionId: presentationPointer.revisionId,
              contentHash: presentationPointer.contentHash,
            },
            reason: "Presentation changed externally.",
            detectedAt: new Date().toISOString(),
          },
        ],
        updatedAt: new Date().toISOString(),
      },
    });

    await expect(submitPptReviewTool.execute(report(), contextFor(bridge))).rejects.toThrow(
      "current non-stale PresentationRevision",
    );
  });
});
