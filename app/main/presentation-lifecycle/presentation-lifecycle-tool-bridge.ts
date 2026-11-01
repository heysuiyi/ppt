import {
  type ArtifactPointer,
  asPresentationId,
  type BlobReference,
  type PptCapability,
  type PptJobProjection,
  type PresentationId,
  type ProjectId,
  type QueryId,
} from "@shared/presentation-lifecycle";
import type { PptLifecycleToolBridge } from "../agent/tools/tool-definition";
import { PresentationArtifactChangeObserver } from "./artifact-change-observer";
import type { ArtifactChangeObserverPort } from "./artifact-change-observer-types";
import type { ContentAddressedBlobStore } from "./content-addressed-blob-store";
import type {
  PptReviewReport,
  PresentationLifecycleOrchestrator,
} from "./presentation-lifecycle-orchestrator";

export class PresentationLifecycleToolBridge implements PptLifecycleToolBridge {
  constructor(
    private readonly orchestrator: PresentationLifecycleOrchestrator,
    private readonly projectId: ProjectId,
    presentationId: string,
    readonly queryId: QueryId,
    private readonly request: string,
    private readonly blobStore?: ContentAddressedBlobStore,
    artifactChangeObserver?: ArtifactChangeObserverPort,
    allowWaitingUserResume = false,
  ) {
    this.presentationId = asPresentationId(presentationId);
    this.artifactChangeObserver =
      artifactChangeObserver ?? new PresentationArtifactChangeObserver(orchestrator);
    this.resumeEligible = allowWaitingUserResume;
  }

  private readonly presentationId: PresentationId;
  private readonly artifactChangeObserver: ArtifactChangeObserverPort;
  private artifactObservationTail: Promise<void> = Promise.resolve();
  /**
   * A resumed waiting-user Query may continue without repeating
   * BeginPptCapability, but that implicit resume is valid only at the first
   * Presentation-tool boundary of this runtime invocation. A later
   * waiting_user transition (for example an external file change detected by
   * PreviewSvgPage or SubmitSvgDeck) must remain blocking.
   */
  private resumeEligible: boolean;

  withTransaction<T>(operation: () => T): T {
    return this.orchestrator.withTransaction(operation);
  }

  async observeArtifactChanges(
    input: Parameters<PptLifecycleToolBridge["observeArtifactChanges"]>[0],
  ): Promise<void> {
    const observation = this.artifactObservationTail.then(async () => {
      const projection = this.orchestrator.getProjection(this.presentationId);
      if (!projection || projection.queryId !== this.queryId || projection.status !== "running") {
        return;
      }
      await this.artifactChangeObserver.observe({
        presentationId: this.presentationId,
        workspaceRoot: input.workspaceRoot,
        paths: input.paths,
        source: input.source,
      });
    });
    this.artifactObservationTail = observation.then(
      () => undefined,
      () => undefined,
    );
    await observation;
  }

  beginCapability(input: { capability: PptCapability; instruction: string }): PptJobProjection {
    const current = this.orchestrator.getProjection(this.presentationId);
    if (
      current?.queryId === this.queryId &&
      current.status === "waiting_user" &&
      !this.resumeEligible
    ) {
      throw new Error(
        "This PPT capability entered waiting_user during the current Query; " +
          "resume it through a waiting-user continuation before using Presentation tools.",
      );
    }
    const state = this.orchestrator.beginCapability({
      projectId: this.projectId,
      presentationId: this.presentationId,
      queryId: this.queryId,
      capability: input.capability,
      instruction: input.instruction || this.request,
    });
    this.resumeEligible = false;
    return this.orchestrator.getProjection(state.params.presentationId)!;
  }

  requireActiveCapability(
    allowedCapabilities?: readonly PptCapability[],
    options: { allowCompleted?: boolean } = {},
  ): PptJobProjection {
    let projection = this.orchestrator.getProjection(this.presentationId);
    if (!projection || projection.queryId !== this.queryId) {
      throw new Error(
        "Call BeginPptCapability before using Presentation authoring, review, or proposal tools.",
      );
    }
    if (projection.status === "waiting_user" && this.resumeEligible) {
      this.orchestrator.resumeCapability(projection.jobId, this.queryId);
      projection = this.orchestrator.getProjection(this.presentationId)!;
    }
    this.resumeEligible = false;
    if (
      projection.status !== "running" &&
      !(options.allowCompleted && projection.status === "completed")
    ) {
      throw new Error(
        `PPT capability request is ${projection.status}; only a running request can use this tool.`,
      );
    }
    if (allowedCapabilities && !allowedCapabilities.includes(projection.capability)) {
      throw new Error(
        `PPT capability ${projection.capability} cannot use this tool. ` +
          `Allowed: ${allowedCapabilities.join(", ")}.`,
      );
    }
    return projection;
  }

  commitArtifact(input: Parameters<PptLifecycleToolBridge["commitArtifact"]>[0]): ArtifactPointer {
    const active = this.requireActiveCapability();
    return this.orchestrator.commitArtifact({
      ...input,
      jobId: active.jobId,
    }).pointer;
  }

  storeBlob(value: Uint8Array, mediaType: string): Promise<BlobReference> {
    return this.requireBlobStore().put(value, mediaType);
  }

  async assertBlob(reference: BlobReference): Promise<void> {
    await this.requireBlobStore().get(reference);
  }

  submitReview(report: PptReviewReport): PptJobProjection {
    const active = this.requireActiveCapability(["review"], { allowCompleted: true });
    const state = this.orchestrator.completeReview({
      jobId: active.jobId,
      report,
    });
    return this.orchestrator.getProjection(state.params.presentationId)!;
  }

  private requireBlobStore(): ContentAddressedBlobStore {
    if (!this.blobStore) {
      throw new Error("Presentation lifecycle blob storage is unavailable for this runtime.");
    }
    return this.blobStore;
  }
}
