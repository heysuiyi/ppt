import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { canonicalJson, hashArtifactValue } from "@ppt/core/artifact-hash";
import { type Presentation, presentationSchema } from "@shared/presentation";
import {
  type ArtifactDependency,
  type ArtifactKind,
  type ArtifactPointer,
  type ArtifactRevision,
  type ArtifactRevisionId,
  artifactPointerSchema,
  asArtifactId,
  asArtifactRevisionId,
  asPptCapabilityRequestId,
  asPptJobId,
  asPptStageRunId,
  asPresentationRevisionId,
  asProposalId,
  blobReferenceSchema,
  type ContentHash,
  type PptCapability,
  type PptJobProjection,
  type PptJobState,
  type PptProposal,
  type PptStage,
  type PptStageAttempt,
  type PresentationId,
  type PresentationRevisionId,
  type ProjectId,
  type ProposalId,
  pptCapabilityRequestSchema,
  type QueryId,
  toPptJobProjection,
  type ValidationReport,
} from "@shared/presentation-lifecycle";
import { z } from "zod";
import { ContentAddressedBlobStore } from "./content-addressed-blob-store";
import type {
  ArtifactCommitResult,
  PresentationLifecycleRepository,
} from "./presentation-lifecycle-repository";

export const commandProposalArtifactValueSchema = z
  .object({
    queryId: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    commandsBlob: blobReferenceSchema,
    commandCount: z.number().int().positive(),
    modelRisk: z.enum(["low", "medium", "high"]),
    assumptions: z.array(z.string()).optional(),
    gate: z
      .object({
        risk: z.enum(["low", "medium", "high"]),
        decision: z.enum(["AUTO", "REQUIRES_APPROVAL"]),
        warnings: z.array(z.string()).optional(),
        diff: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();
export type CommandProposalArtifactValue = z.infer<typeof commandProposalArtifactValueSchema>;

export const presentationRevisionArtifactValueSchema = z
  .object({
    presentationRevisionId: z.string().trim().min(1),
    presentationRevisionNumber: z.number().int().nonnegative(),
    presentationBlob: blobReferenceSchema,
  })
  .strict();

export const pptReviewFindingSchema = z
  .object({
    severity: z.enum(["error", "warning", "info"]),
    code: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(10_000),
    slideId: z.string().trim().min(1).max(200).optional(),
    recommendation: z.string().trim().min(1).max(10_000).optional(),
  })
  .strict();

export const pptReviewReportSchema = z
  .object({
    verdict: z.enum(["pass", "needs_changes"]),
    summary: z.string().trim().min(1).max(20_000),
    overallScore: z.number().int().min(0).max(100).optional(),
    findings: z.array(pptReviewFindingSchema).max(500),
  })
  .strict();
export type PptReviewReport = z.infer<typeof pptReviewReportSchema>;

type CommittedArtifactResult = Exclude<ArtifactCommitResult, { type: "conflict" }> & {
  pointer: ArtifactPointer;
};

export type PptJobProjectionListener = (projection: PptJobProjection) => void;

export interface BeginCapabilityInput {
  projectId: ProjectId;
  presentationId: PresentationId;
  queryId?: QueryId;
  capability: PptCapability;
  instruction: string;
  basePresentationRevisionId?: PresentationRevisionId;
  requestedAt?: string;
}

export interface CommitArtifactInput<T> {
  jobId: PptJobState["jobId"];
  artifactId: string;
  kind: ArtifactKind;
  stage: PptStage;
  value: T;
  dependencies?: ArtifactDependency[];
  validation: ValidationReport;
  idempotencyKey: string;
  committedAt?: string;
}

export interface MarkArtifactSourceChangedInput {
  jobId: PptJobState["jobId"];
  artifactId: ArtifactPointer["artifactId"];
  expectedRevisionId: ArtifactRevisionId;
  observedContentHash: ContentHash;
  reason: string;
  waitForUser: boolean;
  detectedAt?: string;
}

/**
 * Enforces legal business transitions above the repository's persistence
 * primitives. Query completion never calls complete() implicitly.
 */
export class PresentationLifecycleOrchestrator {
  private readonly listeners = new Set<PptJobProjectionListener>();
  private readonly projectionNotificationBatch = new AsyncLocalStorage<
    Map<PresentationId, PptJobProjection>
  >();
  private transactionDepth = 0;
  private pendingProjections = new Map<PresentationId, PptJobProjection>();

  constructor(
    readonly repository: PresentationLifecycleRepository,
    private readonly blobStore = new ContentAddressedBlobStore(
      join(dirname(repository.filePath), "blobs"),
    ),
  ) {}

  subscribe(listener: PptJobProjectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getProjection(presentationId: PresentationId): PptJobProjection | undefined {
    return this.repository.getProjectionByPresentationId(presentationId);
  }

  getState(presentationId: PresentationId): PptJobState | undefined {
    return this.repository.getJobByPresentationId(presentationId);
  }

  assertPresentationSnapshot(jobId: PptJobState["jobId"], snapshotInput: Presentation): void {
    const state = this.requireJob(jobId);
    const snapshot = presentationSchema.parse(structuredClone(snapshotInput));
    if (
      snapshot.id !== state.params.presentationId ||
      snapshot.revision !== state.presentationRevisionNumber ||
      !state.presentationRevisionId
    ) {
      throw new Error(
        "The authoritative Presentation snapshot does not match the PptJob revision.",
      );
    }
    const pointer = state.committedArtifacts.find(
      (artifact) =>
        artifact.kind === "presentation_revision" &&
        artifact.artifactId === `presentation:${state.params.presentationId}`,
    );
    const artifact = pointer ? this.repository.getArtifactRevision(pointer.revisionId) : undefined;
    if (artifact?.kind !== "presentation_revision") {
      throw new Error("The current PresentationRevision artifact is missing.");
    }
    const value = presentationRevisionArtifactValueSchema.parse(artifact.value);
    if (
      value.presentationRevisionId !== state.presentationRevisionId ||
      value.presentationRevisionNumber !== state.presentationRevisionNumber
    ) {
      throw new Error(
        "The current PresentationRevision artifact does not match the PptJob revision.",
      );
    }
    const durable = this.readPresentationBlob(
      value.presentationBlob,
      state.params.presentationId,
      state.presentationRevisionNumber,
    );
    if (hashArtifactValue(durable) !== hashArtifactValue(snapshot)) {
      throw new Error("The authoritative Presentation snapshot does not match its durable blob.");
    }
  }

  withTransaction<T>(operation: () => T): T {
    const outermost = this.transactionDepth === 0;
    const previousPending = new Map(this.pendingProjections);
    this.transactionDepth += 1;
    let result: T;
    try {
      result = this.repository.withTransaction(operation);
    } catch (error) {
      this.transactionDepth -= 1;
      this.pendingProjections = previousPending;
      throw error;
    }
    this.transactionDepth -= 1;
    if (outermost) this.flushPendingProjections();
    return result;
  }

  async withProjectionNotificationBatch<T>(operation: () => Promise<T>): Promise<T> {
    if (this.projectionNotificationBatch.getStore()) {
      return operation();
    }
    const projections = new Map<PresentationId, PptJobProjection>();
    try {
      const result = await this.projectionNotificationBatch.run(projections, operation);
      for (const projection of projections.values()) {
        this.notifyProjectionListeners(projection);
      }
      return result;
    } catch (error) {
      projections.clear();
      throw error;
    }
  }

  beginCapability(input: BeginCapabilityInput): PptJobState {
    return this.withTransaction(() => this.beginCapabilityInTransaction(input));
  }

  private beginCapabilityInTransaction(input: BeginCapabilityInput): PptJobState {
    const requestedAt = input.requestedAt ?? new Date().toISOString();
    const existingJob = this.repository.getJobByPresentationId(input.presentationId);
    if (existingJob && existingJob.params.projectId !== input.projectId) {
      throw new Error(
        `Presentation ${input.presentationId} already belongs to project ` +
          `${existingJob.params.projectId}.`,
      );
    }
    const existingRequest =
      input.queryId && existingJob
        ? this.repository.getCapabilityRequestByQuery(existingJob.jobId, input.queryId)
        : undefined;
    if (existingRequest && existingJob) {
      if (
        existingJob.currentRequest.requestId !== existingRequest.requestId ||
        existingRequest.basePresentationRevisionId !== input.basePresentationRevisionId ||
        existingRequest.capability !== input.capability ||
        existingRequest.instruction !== input.instruction
      ) {
        throw new Error(
          `Query ${input.queryId} already opened a different PPT capability request.`,
        );
      }
      if (existingJob.status === "waiting_user") {
        return this.resumeCapability(existingJob.jobId, input.queryId!);
      }
      return existingJob;
    }

    const jobId = existingJob?.jobId ?? asPptJobId(randomUUID());
    const request = pptCapabilityRequestSchema.parse({
      requestId: asPptCapabilityRequestId(randomUUID()),
      jobId,
      queryId: input.queryId,
      capability: input.capability,
      instruction: input.instruction,
      basePresentationRevisionId: input.basePresentationRevisionId,
      requestedAt,
    });

    let _state: PptJobState;
    if (!existingJob) {
      _state = this.repository.createOrGetJob({
        jobId,
        params: {
          projectId: input.projectId,
          presentationId: input.presentationId,
          createdAt: requestedAt,
        },
        currentRequest: request,
      }).state;
    } else {
      if (existingJob.proposalId) {
        const previousProposal = this.repository.getProposal(existingJob.proposalId);
        if (previousProposal?.status === "waiting_approval") {
          const superseded = this.repository.resolveProposal({
            proposalId: existingJob.proposalId,
            status: "superseded",
            resolvedAt: requestedAt,
          });
          if (superseded.type === "conflict") {
            throw new Error(`Proposal ${existingJob.proposalId} could not be superseded.`);
          }
        }
      }
      this.repository.addCapabilityRequest(request);
      _state = this.requireUpdate(
        {
          ...existingJob,
          currentRequest: request,
          status: "running",
          stateRevision: existingJob.stateRevision + 1,
          currentStage: "intent",
          currentStageRunId: undefined,
          candidateArtifactRevisionId: undefined,
          proposalId: undefined,
          waitingReason: undefined,
          updatedAt: requestedAt,
        },
        "capability_started",
      );
    }

    const intentKind =
      input.capability === "edit"
        ? "edit_intent"
        : input.capability === "restyle"
          ? "restyle_intent"
          : "intent";
    const _intent = this.commitArtifact({
      jobId,
      artifactId: `intent:${request.requestId}`,
      kind: intentKind,
      stage: "intent",
      value: {
        requestId: request.requestId,
        capability: request.capability,
        instruction: request.instruction,
        requestedAt: request.requestedAt,
        ...(request.queryId ? { queryId: request.queryId } : {}),
        ...(request.basePresentationRevisionId
          ? {
              basePresentationRevisionId: request.basePresentationRevisionId,
            }
          : {}),
      },
      validation: passedValidation("ppt-capability-request", requestedAt),
      idempotencyKey: `intent:${request.requestId}`,
      committedAt: requestedAt,
    });
    return this.repository.getJob(jobId)!;
  }

  resumeCapability(
    jobId: PptJobState["jobId"],
    queryId: QueryId,
    updatedAt = new Date().toISOString(),
  ): PptJobState {
    const state = this.requireJob(jobId);
    if (state.currentRequest.queryId !== queryId) {
      throw new Error(`Query ${queryId} is not active for PptJob ${jobId}.`);
    }
    if (state.status === "running") return state;
    if (state.status !== "waiting_user") {
      throw new Error(`PptJob ${jobId} cannot resume Query ${queryId} while ${state.status}.`);
    }
    return this.requireUpdate(
      {
        ...state,
        status: "running",
        stateRevision: state.stateRevision + 1,
        waitingReason: undefined,
        updatedAt,
      },
      "capability_resumed",
    );
  }

  commitArtifact<T>(input: CommitArtifactInput<T>): CommittedArtifactResult {
    return this.withTransaction(() => this.commitArtifactInTransaction(input));
  }

  private commitArtifactInTransaction<T>(input: CommitArtifactInput<T>): CommittedArtifactResult {
    const committedAt = input.committedAt ?? new Date().toISOString();
    const activeState = this.requireJob(input.jobId);
    const existing = this.repository.getArtifactRevisionByIdempotency(
      input.jobId,
      input.idempotencyKey,
    );
    if (existing) {
      const contentHash = hashArtifactValue(input.value);
      if (
        existing.artifactId !== input.artifactId ||
        existing.kind !== input.kind ||
        existing.stage !== input.stage ||
        existing.contentHash !== contentHash ||
        JSON.stringify(existing.dependencies) !== JSON.stringify(input.dependencies ?? [])
      ) {
        throw new Error(`Artifact idempotency conflict for ${input.idempotencyKey}.`);
      }
      return {
        type: "already_committed",
        revision: existing,
        pointer: artifactPointerSchema.parse({
          artifactId: existing.artifactId,
          revisionId: existing.revisionId,
          contentHash: existing.contentHash,
          kind: existing.kind,
          stage: existing.stage,
        }),
      };
    }
    if (activeState.status !== "running") {
      throw new Error(
        `PptJob ${input.jobId} cannot commit ${input.kind} while ${activeState.status}.`,
      );
    }
    for (const dependency of input.dependencies ?? []) {
      const current = activeState.committedArtifacts.find(
        (pointer) => pointer.artifactId === dependency.artifactId,
      );
      const dependencyIsStale = activeState.staleArtifacts.some(
        (artifact) => artifact.revisionId === dependency.revisionId,
      );
      const authoritativePresentationRebase =
        input.kind === "presentation_revision" &&
        input.artifactId === `presentation:${activeState.params.presentationId}` &&
        activeState.currentRequest.capability === "edit" &&
        current?.kind === "presentation_revision";
      if (
        !current ||
        current.revisionId !== dependency.revisionId ||
        current.contentHash !== dependency.contentHash ||
        (dependencyIsStale && !authoritativePresentationRebase)
      ) {
        throw new Error(
          `Artifact dependency ${dependency.revisionId} is not the current non-stale head.`,
        );
      }
    }
    const revision: ArtifactRevision<T> = {
      artifactId: asArtifactId(input.artifactId),
      revisionId: asArtifactRevisionId(randomUUID()),
      jobId: input.jobId,
      kind: input.kind,
      stage: input.stage,
      schemaVersion: 1,
      value: input.value,
      contentHash: hashArtifactValue(input.value),
      dependencies: input.dependencies ?? [],
      validation: input.validation,
      committedAt,
    };
    const result = this.repository.commitArtifactRevision(revision, input.idempotencyKey);
    if (result.type === "conflict") {
      throw new Error(`Artifact idempotency conflict for ${input.idempotencyKey}.`);
    }
    const stored = result.revision;
    const pointer = artifactPointerSchema.parse({
      artifactId: stored.artifactId,
      revisionId: stored.revisionId,
      contentHash: stored.contentHash,
      kind: stored.kind,
      stage: stored.stage,
    });
    const state = this.repository.getJob(input.jobId)!;
    const stale = this.repository.propagateStale({
      jobId: input.jobId,
      replacement: pointer,
      reason: `${input.artifactId} advanced to ${pointer.revisionId}.`,
      detectedAt: committedAt,
    });
    const committedArtifacts = [
      ...state.committedArtifacts.filter((item) => item.artifactId !== pointer.artifactId),
      pointer,
    ];
    const staleArtifacts = [
      ...state.staleArtifacts.filter(
        (item) =>
          item.artifactId !== pointer.artifactId &&
          !stale.staleArtifacts.some((next) => next.revisionId === item.revisionId),
      ),
      ...stale.staleArtifacts,
    ];
    this.requireUpdate(
      {
        ...state,
        status: "running",
        stateRevision: state.stateRevision + 1,
        currentStage: input.stage,
        committedArtifacts,
        staleArtifacts,
        candidateArtifactRevisionId: pointer.revisionId,
        waitingReason: undefined,
        updatedAt: committedAt,
      },
      "artifact_committed",
    );
    return { ...result, pointer };
  }

  markArtifactSourceChanged(input: MarkArtifactSourceChangedInput): PptJobState {
    return this.withTransaction(() => this.markArtifactSourceChangedInTransaction(input));
  }

  private markArtifactSourceChangedInTransaction(
    input: MarkArtifactSourceChangedInput,
  ): PptJobState {
    const state = this.requireJob(input.jobId);
    if (state.status === "cancelled" || state.status === "failed") {
      return state;
    }
    const current = state.committedArtifacts.find(
      (pointer) => pointer.artifactId === input.artifactId,
    );
    if (
      !current ||
      current.revisionId !== input.expectedRevisionId ||
      state.staleArtifacts.some((stale) => stale.revisionId === input.expectedRevisionId)
    ) {
      return state;
    }
    const detectedAt = input.detectedAt ?? new Date().toISOString();
    const stale = this.repository.propagateStaleFromSourceChange({
      jobId: state.jobId,
      artifactId: input.artifactId,
      expectedRevisionId: input.expectedRevisionId,
      observedContentHash: input.observedContentHash,
      reason: input.reason,
      detectedAt,
    });
    if (stale.staleArtifacts.length === 0) return state;

    const staleArtifacts = [
      ...state.staleArtifacts,
      ...stale.staleArtifacts.filter(
        (next) => !state.staleArtifacts.some((existing) => existing.revisionId === next.revisionId),
      ),
    ];
    if (state.proposalId) {
      const proposal = this.repository.getProposal(state.proposalId);
      if (
        proposal?.status === "waiting_approval" &&
        staleArtifacts.some((artifact) => artifact.revisionId === proposal.artifactRevisionId)
      ) {
        const superseded = this.repository.resolveProposal({
          proposalId: proposal.proposalId,
          status: "superseded",
          resolvedAt: detectedAt,
        });
        if (superseded.type === "conflict") {
          throw new Error(`Proposal ${proposal.proposalId} could not be marked superseded.`);
        }
      }
    }
    const shouldWait = input.waitForUser;
    const earliestStage = stale.earliestStage ?? current.stage;
    return this.requireUpdate(
      {
        ...state,
        status: shouldWait ? "waiting_user" : state.status,
        stateRevision: state.stateRevision + 1,
        currentStage: earliestStage,
        staleArtifacts,
        waitingReason: shouldWait
          ? `${input.reason} Rerun from ${earliestStage}.`
          : state.waitingReason,
        updatedAt: detectedAt,
      },
      "artifact_source_changed",
    );
  }

  startStageAttempt(input: {
    jobId: PptJobState["jobId"];
    stage: PptStage;
    candidate?: PptStageAttempt["candidate"];
    idempotencyKey: string;
    startedAt?: string;
  }): PptStageAttempt {
    return this.withTransaction(() => {
      const state = this.requireJob(input.jobId);
      if (state.status !== "running") {
        throw new Error(
          `PptJob ${state.jobId} cannot start a stage attempt while ${state.status}.`,
        );
      }
      const startedAt = input.startedAt ?? new Date().toISOString();
      const stableRunHash = hashArtifactValue({
        jobId: state.jobId,
        requestId: state.currentRequest.requestId,
        stage: input.stage,
        idempotencyKey: input.idempotencyKey,
      }).slice("sha256:".length);
      const result = this.repository.startStageAttempt({
        stageRunId: asPptStageRunId(`stage-run:${stableRunHash}`),
        jobId: state.jobId,
        requestId: state.currentRequest.requestId,
        queryId: state.currentRequest.queryId,
        stage: input.stage,
        idempotencyKey: input.idempotencyKey,
        ...(input.candidate === undefined ? {} : { candidate: input.candidate }),
        startedAt,
      });
      if (result.type === "conflict") {
        throw new Error(`Stage attempt idempotency conflict for ${input.idempotencyKey}.`);
      }
      if (result.type === "started") {
        this.requireUpdate(
          {
            ...state,
            stateRevision: state.stateRevision + 1,
            currentStage: input.stage,
            currentStageRunId: result.attempt.stageRunId,
            updatedAt: startedAt,
          },
          "stage_attempt_started",
        );
      }
      return result.attempt;
    });
  }

  finishStageAttempt(input: {
    stageRunId: PptStageAttempt["stageRunId"];
    status: Exclude<PptStageAttempt["status"], "running">;
    artifactRevisionId?: ArtifactRevisionId;
    validation?: ValidationReport;
    error?: string;
    completedAt?: string;
  }): PptStageAttempt {
    return this.withTransaction(() => {
      const completedAt = input.completedAt ?? new Date().toISOString();
      const result = this.repository.finishStageAttempt({
        stageRunId: input.stageRunId,
        status: input.status,
        artifactRevisionId: input.artifactRevisionId,
        validation: input.validation,
        error: input.error,
        completedAt,
      });
      if (result.type === "conflict") {
        throw new Error(`Stage attempt ${input.stageRunId} was already resolved differently.`);
      }
      const state = this.requireJob(result.attempt.jobId);
      if (state.currentStageRunId === input.stageRunId) {
        this.requireUpdate(
          {
            ...state,
            stateRevision: state.stateRevision + 1,
            currentStageRunId: undefined,
            updatedAt: completedAt,
          },
          "stage_attempt_finished",
        );
      }
      return result.attempt;
    });
  }

  recordProposal(input: {
    jobId: PptJobState["jobId"];
    proposalArtifactRevisionId: ArtifactRevisionId;
    basePresentationRevisionNumber: number;
    basePresentationRevisionId?: PresentationRevisionId;
    proposalId?: ProposalId;
    createdAt?: string;
  }): PptProposal {
    return this.withTransaction(() => {
      const state = this.requireJob(input.jobId);
      if (state.status !== "running") {
        throw new Error(`PptJob ${state.jobId} cannot create a Proposal while ${state.status}.`);
      }
      const proposalArtifact = this.repository.getArtifactRevision(
        input.proposalArtifactRevisionId,
      );
      const currentProposalArtifact = state.committedArtifacts.find(
        (pointer) => pointer.revisionId === input.proposalArtifactRevisionId,
      );
      if (
        !proposalArtifact ||
        proposalArtifact.jobId !== state.jobId ||
        proposalArtifact.kind !== "command_proposal" ||
        proposalArtifact.stage !== "proposal" ||
        !currentProposalArtifact ||
        state.staleArtifacts.some(
          (artifact) => artifact.revisionId === input.proposalArtifactRevisionId,
        )
      ) {
        throw new Error(
          "Proposal requires the current non-stale command_proposal artifact from this PptJob.",
        );
      }
      if (
        state.presentationRevisionId !== input.basePresentationRevisionId ||
        (state.presentationRevisionNumber !== undefined &&
          state.presentationRevisionNumber !== input.basePresentationRevisionNumber)
      ) {
        throw new Error("Proposal base revision does not match the current Presentation.");
      }
      const createdAt = input.createdAt ?? new Date().toISOString();
      const proposal: PptProposal = {
        proposalId: input.proposalId ?? asProposalId(randomUUID()),
        jobId: state.jobId,
        requestId: state.currentRequest.requestId,
        queryId: state.currentRequest.queryId,
        artifactRevisionId: input.proposalArtifactRevisionId,
        basePresentationRevisionId: input.basePresentationRevisionId,
        basePresentationRevisionNumber: input.basePresentationRevisionNumber,
        status: "waiting_approval",
        createdAt,
      };
      const stored = this.repository.createProposal(proposal).proposal;
      this.requireUpdate(
        {
          ...state,
          status: "waiting_approval",
          stateRevision: state.stateRevision + 1,
          currentStage: "proposal",
          proposalId: stored.proposalId,
          candidateArtifactRevisionId: stored.artifactRevisionId,
          waitingReason: "A validated command proposal is waiting for approval.",
          updatedAt: createdAt,
        },
        "proposal_waiting",
      );
      return stored;
    });
  }

  recordCommandProposal(input: {
    jobId: PptJobState["jobId"];
    queryId: QueryId;
    summary: string;
    commandsBlob: z.infer<typeof blobReferenceSchema>;
    commandCount: number;
    modelRisk: "low" | "medium" | "high";
    assumptions?: string[];
    gate: {
      risk: "low" | "medium" | "high";
      decision: "AUTO" | "REQUIRES_APPROVAL";
      warnings?: string[];
      diff?: unknown;
    };
    basePresentationRevisionNumber: number;
    basePresentationRevisionId?: PresentationRevisionId;
    createdAt?: string;
  }): {
    proposal: PptProposal;
    artifact: ArtifactRevision<CommandProposalArtifactValue>;
  } {
    return this.withTransaction(() => {
      const state = this.requireJob(input.jobId);
      if (
        state.currentRequest.capability !== "create" &&
        state.currentRequest.capability !== "edit" &&
        state.currentRequest.capability !== "restyle"
      ) {
        throw new Error(
          `Capability ${state.currentRequest.capability} cannot create command proposals.`,
        );
      }
      if (state.currentRequest.queryId !== input.queryId) {
        throw new Error(
          `Query ${input.queryId} is not the active capability request for PptJob ${state.jobId}.`,
        );
      }
      const value = commandProposalArtifactValueSchema.parse({
        queryId: input.queryId,
        summary: input.summary,
        commandsBlob: input.commandsBlob,
        commandCount: input.commandCount,
        modelRisk: input.modelRisk,
        ...(input.assumptions ? { assumptions: input.assumptions } : {}),
        gate: {
          risk: input.gate.risk,
          decision: input.gate.decision,
          ...(input.gate.warnings ? { warnings: input.gate.warnings } : {}),
          ...(input.gate.diff !== undefined ? { diff: input.gate.diff } : {}),
        },
      });
      const identityHash = hashArtifactValue({
        jobId: state.jobId,
        requestId: state.currentRequest.requestId,
        value,
        basePresentationRevisionNumber: input.basePresentationRevisionNumber,
        ...(input.basePresentationRevisionId
          ? { basePresentationRevisionId: input.basePresentationRevisionId }
          : {}),
      });
      const stableIdentity = identityHash.slice("sha256:".length);
      const proposalId = asProposalId(`proposal:${stableIdentity}`);
      const existing = this.repository.getProposal(proposalId);
      if (existing) {
        const artifact = this.requireCommandProposalArtifact(existing);
        if (
          existing.jobId !== state.jobId ||
          existing.queryId !== input.queryId ||
          existing.basePresentationRevisionNumber !== input.basePresentationRevisionNumber ||
          existing.basePresentationRevisionId !== input.basePresentationRevisionId ||
          hashArtifactValue(artifact.value) !== hashArtifactValue(value)
        ) {
          throw new Error(`Proposal ${proposalId} already exists with different data.`);
        }
        if (
          existing.status === "waiting_approval" &&
          (state.proposalId !== existing.proposalId || state.status !== "waiting_approval")
        ) {
          this.requireUpdate(
            {
              ...state,
              status: "waiting_approval",
              stateRevision: state.stateRevision + 1,
              currentStage: "proposal",
              proposalId: existing.proposalId,
              candidateArtifactRevisionId: existing.artifactRevisionId,
              waitingReason: "A validated command proposal is waiting for approval.",
              updatedAt: existing.createdAt,
            },
            "proposal_waiting_recovered",
          );
        }
        return { proposal: existing, artifact };
      }
      if (state.status !== "running") {
        throw new Error(
          `PptJob ${state.jobId} cannot create a command proposal while ${state.status}.`,
        );
      }

      const createdAt = input.createdAt ?? new Date().toISOString();
      const committed = this.commitArtifact({
        jobId: state.jobId,
        artifactId: `proposal:${stableIdentity}`,
        kind: "command_proposal",
        stage: "proposal",
        value,
        dependencies: state.committedArtifacts
          .filter(
            (pointer) =>
              pointer.artifactId === `candidate:${state.currentRequest.requestId}` ||
              pointer.artifactId === `quality:${state.currentRequest.requestId}`,
          )
          .map((pointer) => ({
            artifactId: pointer.artifactId,
            revisionId: pointer.revisionId,
            contentHash: pointer.contentHash,
          })),
        validation: passedValidation("commit-gate", createdAt),
        idempotencyKey: `command-proposal:${stableIdentity}`,
        committedAt: createdAt,
      });
      const proposal = this.recordProposal({
        jobId: state.jobId,
        proposalArtifactRevisionId: committed.pointer.revisionId,
        basePresentationRevisionNumber: input.basePresentationRevisionNumber,
        basePresentationRevisionId: input.basePresentationRevisionId,
        proposalId,
        createdAt,
      });
      const artifactValue = commandProposalArtifactValueSchema.parse(committed.revision.value);
      return {
        proposal,
        artifact: { ...committed.revision, value: artifactValue },
      };
    });
  }

  getCommandProposalArtifact(
    proposalId: ProposalId,
  ): ArtifactRevision<CommandProposalArtifactValue> {
    const proposal = this.repository.getProposal(proposalId);
    if (!proposal) throw new Error(`Unknown proposal ${proposalId}.`);
    return this.requireCommandProposalArtifact(proposal);
  }

  completeReview(input: {
    jobId: PptJobState["jobId"];
    report: PptReviewReport;
    completedAt?: string;
  }): PptJobState {
    return this.withTransaction(() => {
      const state = this.requireJob(input.jobId);
      if (state.currentRequest.capability !== "review") {
        throw new Error("Structured PPT review requires an active review capability.");
      }
      const presentationPointer =
        state.committedArtifacts.find(
          (pointer) =>
            pointer.kind === "presentation_revision" &&
            pointer.revisionId === state.candidateArtifactRevisionId,
        ) ?? state.committedArtifacts.find((pointer) => pointer.kind === "presentation_revision");
      if (
        !state.presentationRevisionId ||
        !presentationPointer ||
        state.staleArtifacts.some((stale) => stale.revisionId === presentationPointer.revisionId)
      ) {
        throw new Error(
          "Structured PPT review requires a current non-stale PresentationRevision artifact.",
        );
      }
      const presentationArtifact = this.repository.getArtifactRevision(
        presentationPointer.revisionId,
      );
      if (
        presentationArtifact?.kind !== "presentation_revision" ||
        !hasPresentationRevisionId(presentationArtifact.value, state.presentationRevisionId)
      ) {
        throw new Error(
          "Structured PPT review requires a current non-stale PresentationRevision artifact.",
        );
      }

      const report = pptReviewReportSchema.parse(input.report);
      const completedAt = input.completedAt ?? new Date().toISOString();
      const idempotencyKey = `ppt-review:${state.currentRequest.requestId}:${presentationPointer.revisionId}`;
      const existing = this.repository.getArtifactRevisionByIdempotency(
        state.jobId,
        idempotencyKey,
      );
      let qualityPointer: ArtifactPointer;
      if (existing) {
        if (
          existing.kind !== "quality_report" ||
          hashArtifactValue(existing.value) !== hashArtifactValue(report)
        ) {
          throw new Error(
            `Review request ${state.currentRequest.requestId} was already completed with a different report.`,
          );
        }
        qualityPointer = artifactPointerSchema.parse({
          artifactId: existing.artifactId,
          revisionId: existing.revisionId,
          contentHash: existing.contentHash,
          kind: existing.kind,
          stage: existing.stage,
        });
      } else {
        if (state.status !== "running") {
          throw new Error(`PptJob ${state.jobId} cannot commit a review while ${state.status}.`);
        }
        qualityPointer = this.commitArtifact({
          jobId: state.jobId,
          artifactId: `quality:review:${state.currentRequest.requestId}`,
          kind: "quality_report",
          stage: "quality",
          value: report,
          dependencies: [
            {
              artifactId: presentationPointer.artifactId,
              revisionId: presentationPointer.revisionId,
              contentHash: presentationPointer.contentHash,
            },
          ],
          validation: passedValidation("structured-ppt-review", completedAt),
          idempotencyKey,
          committedAt: completedAt,
        }).pointer;
      }

      const advanced = this.requireJob(state.jobId);
      if (
        advanced.status === "completed" &&
        advanced.currentStage === "quality" &&
        advanced.candidateArtifactRevisionId === qualityPointer.revisionId
      ) {
        return advanced;
      }
      return this.requireUpdate(
        {
          ...advanced,
          status: "completed",
          stateRevision: advanced.stateRevision + 1,
          currentStage: "quality",
          candidateArtifactRevisionId: qualityPointer.revisionId,
          waitingReason: undefined,
          updatedAt: completedAt,
        },
        "review_completed",
      );
    });
  }

  completeExport(input: {
    jobId: PptJobState["jobId"];
    effectKey: string;
    presentationRevisionId: PresentationRevisionId;
    options: unknown;
    destination: string;
    format: "pptx" | "html" | "json";
    fileHash: ContentHash;
    byteLength: number;
    postflight: unknown;
    completedAt?: string;
  }): PptJobState {
    return this.withTransaction(() => {
      const state = this.requireJob(input.jobId);
      if (state.currentRequest.capability !== "export") {
        throw new Error("ExportArtifact requires an active export capability.");
      }
      const presentationPointer = state.committedArtifacts.find(
        (pointer) => pointer.kind === "presentation_revision",
      );
      if (
        !presentationPointer ||
        state.presentationRevisionId !== input.presentationRevisionId ||
        state.staleArtifacts.some((stale) => stale.revisionId === presentationPointer.revisionId)
      ) {
        throw new Error("Export requires the current non-stale PresentationRevision.");
      }
      const presentationArtifact = this.repository.getArtifactRevision(
        presentationPointer.revisionId,
      );
      if (
        presentationArtifact?.kind !== "presentation_revision" ||
        !hasPresentationRevisionId(presentationArtifact.value, input.presentationRevisionId)
      ) {
        throw new Error("Export requires the current non-stale PresentationRevision.");
      }

      const completedAt = input.completedAt ?? new Date().toISOString();
      const stableExportId = hashArtifactValue({
        jobId: state.jobId,
        effectKey: input.effectKey,
      }).slice("sha256:".length);
      const exportArtifact = this.commitArtifact({
        jobId: state.jobId,
        artifactId: `export:${stableExportId}`,
        kind: "export_artifact",
        stage: "export",
        value: {
          presentationRevisionId: input.presentationRevisionId,
          options: input.options,
          destination: input.destination,
          format: input.format,
          fileHash: input.fileHash,
          byteLength: input.byteLength,
          postflight: input.postflight,
        },
        dependencies: [
          {
            artifactId: presentationPointer.artifactId,
            revisionId: presentationPointer.revisionId,
            contentHash: presentationPointer.contentHash,
          },
        ],
        validation: passedValidation("export-postflight", completedAt),
        idempotencyKey: `export:${input.effectKey}`,
        committedAt: completedAt,
      });
      const advanced = this.requireJob(state.jobId);
      const completed = this.requireUpdate(
        {
          ...advanced,
          status: "completed",
          stateRevision: advanced.stateRevision + 1,
          currentStage: "export",
          exportArtifactRevisionId: exportArtifact.pointer.revisionId,
          candidateArtifactRevisionId: exportArtifact.pointer.revisionId,
          waitingReason: undefined,
          updatedAt: completedAt,
        },
        "export_completed",
      );
      const effectCompleted = this.repository.completeSideEffect({
        jobId: state.jobId,
        operation: "export",
        key: input.effectKey,
        status: "succeeded",
        result: {
          destination: input.destination,
          fileHash: input.fileHash,
          byteLength: input.byteLength,
          format: input.format,
          exportArtifactRevisionId: exportArtifact.pointer.revisionId,
        },
        completedAt,
      });
      if (!effectCompleted) {
        const settled = this.repository.claimSideEffect({
          jobId: state.jobId,
          operation: "export",
          key: input.effectKey,
          claimedAt: completedAt,
        });
        if (settled.type !== "succeeded") {
          throw new Error("Export side-effect claim was not active.");
        }
      }
      return completed;
    });
  }

  completePresentation(input: {
    jobId: PptJobState["jobId"];
    presentationBlob: z.infer<typeof blobReferenceSchema>;
    presentationRevisionNumber: number;
    proposalId?: ProposalId;
    completedAt?: string;
  }): PptJobState {
    return this.withTransaction(() => {
      const completedAt = input.completedAt ?? new Date().toISOString();
      let state = this.requireJob(input.jobId);
      this.readPresentationBlob(
        input.presentationBlob,
        state.params.presentationId,
        input.presentationRevisionNumber,
      );
      const proposalId = input.proposalId ?? state.proposalId;
      const presentationRevisionHash = hashArtifactValue({
        jobId: state.jobId,
        presentationId: state.params.presentationId,
        presentationRevisionNumber: input.presentationRevisionNumber,
        presentationBlob: input.presentationBlob,
      }).slice("sha256:".length);
      const presentationRevisionId = asPresentationRevisionId(
        `presentation-revision:${presentationRevisionHash}`,
      );
      const presentationValue = {
        presentationRevisionId,
        presentationRevisionNumber: input.presentationRevisionNumber,
        presentationBlob: input.presentationBlob,
      };
      if (state.presentationRevisionNumber === input.presentationRevisionNumber) {
        const currentPointer = state.committedArtifacts.find(
          (pointer) => pointer.kind === "presentation_revision",
        );
        const currentArtifact = currentPointer
          ? this.repository.getArtifactRevision(currentPointer.revisionId)
          : undefined;
        if (
          state.presentationRevisionId === presentationRevisionId &&
          currentArtifact &&
          hashArtifactValue(currentArtifact.value) === hashArtifactValue(presentationValue)
        ) {
          return state;
        }
        throw new Error(
          `Presentation CAS revision ${input.presentationRevisionNumber} ` +
            "already identifies different content.",
        );
      }
      if (
        state.presentationRevisionNumber !== undefined &&
        input.presentationRevisionNumber !== state.presentationRevisionNumber + 1
      ) {
        throw new Error(
          `Presentation CAS revision must advance from ` +
            `${state.presentationRevisionNumber} to ${state.presentationRevisionNumber + 1}.`,
        );
      }
      if (
        state.currentRequest.capability !== "create" &&
        state.currentRequest.capability !== "edit" &&
        state.currentRequest.capability !== "restyle"
      ) {
        throw new Error(
          `Capability ${state.currentRequest.capability} cannot commit a PresentationRevision.`,
        );
      }
      if (proposalId) {
        const proposal = this.repository.getProposal(proposalId);
        if (
          state.status !== "waiting_approval" ||
          state.proposalId !== proposalId ||
          proposal?.status !== "waiting_approval" ||
          proposal.jobId !== state.jobId ||
          proposal.requestId !== state.currentRequest.requestId
        ) {
          throw new Error(
            `Proposal ${proposalId} is not the active approval for PptJob ${state.jobId}.`,
          );
        }
        state = this.requireUpdate(
          {
            ...state,
            status: "running",
            stateRevision: state.stateRevision + 1,
            waitingReason: undefined,
            updatedAt: completedAt,
          },
          "proposal_applying",
        );
      } else if (state.status !== "running") {
        throw new Error(
          `PptJob ${state.jobId} cannot commit a PresentationRevision while ${state.status}.`,
        );
      }
      const dependencies = proposalId
        ? [this.dependencyForProposal(proposalId)]
        : currentDependencies(state, ["presentation"]);
      const artifact = this.commitArtifact({
        jobId: state.jobId,
        artifactId: `presentation:${state.params.presentationId}`,
        kind: "presentation_revision",
        stage: "presentation",
        value: presentationValue,
        dependencies,
        validation: passedValidation("presentation-schema-and-cas", completedAt),
        idempotencyKey:
          `presentation:${state.params.presentationId}:` +
          `${input.presentationRevisionNumber}:${input.presentationBlob.contentHash}`,
        committedAt: completedAt,
      });
      if (proposalId) {
        const resolved = this.repository.resolveProposal({
          proposalId,
          status: "applied",
          resolvedAt: completedAt,
        });
        if (resolved.type === "conflict") {
          throw new Error(`Proposal ${proposalId} was resolved concurrently.`);
        }
      }
      const advanced = this.requireJob(state.jobId);
      return this.requireUpdate(
        {
          ...advanced,
          status: "completed",
          stateRevision: advanced.stateRevision + 1,
          currentStage: "presentation",
          presentationRevisionId,
          presentationRevisionNumber: input.presentationRevisionNumber,
          candidateArtifactRevisionId: artifact.pointer.revisionId,
          waitingReason: undefined,
          updatedAt: completedAt,
        },
        "presentation_committed",
      );
    });
  }

  rejectProposal(proposalId: ProposalId, resolvedAt = new Date().toISOString()): PptJobState {
    return this.withTransaction(() => {
      const proposal = this.repository.getProposal(proposalId);
      if (!proposal) throw new Error(`Unknown proposal ${proposalId}.`);
      const state = this.requireJob(proposal.jobId);
      if (
        proposal.status !== "waiting_approval" ||
        state.status !== "waiting_approval" ||
        state.proposalId !== proposalId ||
        proposal.requestId !== state.currentRequest.requestId
      ) {
        throw new Error(
          `Proposal ${proposalId} is not the active approval for PptJob ${state.jobId}.`,
        );
      }
      const resolved = this.repository.resolveProposal({
        proposalId,
        status: "rejected",
        resolvedAt,
      });
      if (resolved.type === "conflict") {
        throw new Error(`Proposal ${proposalId} was resolved concurrently.`);
      }
      return this.requireUpdate(
        {
          ...state,
          status: "completed",
          stateRevision: state.stateRevision + 1,
          currentStage: state.presentationRevisionId ? "presentation" : "proposal",
          waitingReason: undefined,
          updatedAt: resolvedAt,
        },
        "proposal_rejected",
      );
    });
  }

  waitForUser(
    jobId: PptJobState["jobId"],
    reason: string,
    updatedAt = new Date().toISOString(),
  ): PptJobState {
    const state = this.requireJob(jobId);
    if (state.status === "waiting_user" && state.waitingReason === reason) {
      return state;
    }
    if (state.status !== "running" && state.status !== "waiting_approval") {
      throw new Error(`PptJob ${jobId} cannot wait for the user while ${state.status}.`);
    }
    return this.requireUpdate(
      {
        ...state,
        status: "waiting_user",
        stateRevision: state.stateRevision + 1,
        waitingReason: reason,
        updatedAt,
      },
      "waiting_user",
    );
  }

  fail(jobId: PptJobState["jobId"], updatedAt = new Date().toISOString()): PptJobState {
    const state = this.requireJob(jobId);
    if (state.status === "failed") return state;
    if (state.status !== "running" && state.status !== "waiting_user") {
      throw new Error(`PptJob ${jobId} cannot fail while ${state.status}.`);
    }
    return this.requireUpdate(
      {
        ...state,
        status: "failed",
        stateRevision: state.stateRevision + 1,
        waitingReason: undefined,
        updatedAt,
      },
      "job_failed",
    );
  }

  cancel(jobId: PptJobState["jobId"], updatedAt = new Date().toISOString()): PptJobState {
    const state = this.requireJob(jobId);
    if (state.status === "cancelled") return state;
    if (state.status !== "running" && state.status !== "waiting_user") {
      throw new Error(`PptJob ${jobId} cannot be cancelled while ${state.status}.`);
    }
    return this.requireUpdate(
      {
        ...state,
        status: "cancelled",
        stateRevision: state.stateRevision + 1,
        waitingReason: undefined,
        updatedAt,
      },
      "job_cancelled",
    );
  }

  private dependencyForProposal(proposalId: ProposalId): ArtifactDependency {
    const proposal = this.repository.getProposal(proposalId);
    if (!proposal) throw new Error(`Unknown proposal ${proposalId}.`);
    const revision = this.repository.getArtifactRevision(proposal.artifactRevisionId);
    if (!revision) throw new Error("Proposal artifact revision is missing.");
    return {
      artifactId: revision.artifactId,
      revisionId: revision.revisionId,
      contentHash: revision.contentHash,
    };
  }

  private requireCommandProposalArtifact(
    proposal: PptProposal,
  ): ArtifactRevision<CommandProposalArtifactValue> {
    const artifact = this.repository.getArtifactRevision(proposal.artifactRevisionId);
    if (artifact?.kind !== "command_proposal") {
      throw new Error(`Proposal ${proposal.proposalId} has no command_proposal artifact.`);
    }
    const value = commandProposalArtifactValueSchema.parse(artifact.value);
    return { ...artifact, value };
  }

  private requireJob(jobId: PptJobState["jobId"]): PptJobState {
    const state = this.repository.getJob(jobId);
    if (!state) throw new Error(`Unknown PptJob ${jobId}.`);
    return state;
  }

  private readPresentationBlob(
    reference: z.infer<typeof blobReferenceSchema>,
    presentationId: PresentationId,
    presentationRevisionNumber: number,
  ): Presentation {
    if (reference.mediaType !== "application/vnd.agent-ppt.presentation+json") {
      throw new Error("PresentationRevision blob has an unsupported media type.");
    }
    const bytes = this.blobStore.getSync(reference);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("PresentationRevision blob is not valid JSON.");
    }
    const presentation = presentationSchema.parse(parsed);
    if (
      presentation.id !== presentationId ||
      presentation.revision !== presentationRevisionNumber
    ) {
      throw new Error(
        "PresentationRevision blob identity or CAS revision does not match the PptJob.",
      );
    }
    if (bytes.toString("utf8") !== canonicalJson(presentation)) {
      throw new Error("PresentationRevision blob must contain canonical Presentation JSON.");
    }
    return presentation;
  }

  private requireUpdate(nextState: PptJobState, eventType: string): PptJobState {
    const result = this.repository.updateJobStateCas({
      expectedStateRevision: nextState.stateRevision - 1,
      nextState,
      eventType,
    });
    if (result.type === "conflict") {
      throw new Error(
        `PptJob ${nextState.jobId} state revision conflict: ` +
          `expected ${nextState.stateRevision - 1}, current ${result.current.stateRevision}.`,
      );
    }
    this.emit(result.state);
    return result.state;
  }

  private emit(state: PptJobState): void {
    const proposal = state.proposalId ? this.repository.getProposal(state.proposalId) : undefined;
    const projection = toPptJobProjection(state, proposal);
    if (this.transactionDepth > 0) {
      this.pendingProjections.set(projection.presentationId, projection);
      return;
    }
    this.publishProjection(projection);
  }

  private flushPendingProjections(): void {
    const projections = [...this.pendingProjections.values()];
    this.pendingProjections.clear();
    for (const projection of projections) {
      this.publishProjection(projection);
    }
  }

  private publishProjection(projection: PptJobProjection): void {
    const batch = this.projectionNotificationBatch.getStore();
    if (batch) {
      batch.set(projection.presentationId, projection);
      return;
    }
    this.notifyProjectionListeners(projection);
  }

  private notifyProjectionListeners(projection: PptJobProjection): void {
    for (const listener of this.listeners) {
      try {
        listener(projection);
      } catch (error) {
        try {
          console.error("ppt-job projection listener failed", error);
        } catch {
          // Projection observers must never affect a committed domain mutation.
        }
      }
    }
  }
}

function passedValidation(validator: string, validatedAt: string): ValidationReport {
  return {
    status: "passed",
    validator,
    issues: [],
    validatedAt,
  };
}

function hasPresentationRevisionId(value: unknown, expected: PresentationRevisionId): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "presentationRevisionId" in value &&
    value.presentationRevisionId === expected
  );
}

function currentDependencies(state: PptJobState, stages: PptStage[]): ArtifactDependency[] {
  return state.committedArtifacts
    .filter((pointer) => stages.includes(pointer.stage))
    .map((pointer) => ({
      artifactId: pointer.artifactId,
      revisionId: pointer.revisionId,
      contentHash: pointer.contentHash,
    }));
}
