import { hashArtifactValue } from "@ppt/core/artifact-hash";
import {
  type ArtifactDependency,
  type ArtifactId,
  type ArtifactPointer,
  type ArtifactRevision,
  type ArtifactRevisionId,
  artifactPointerSchema,
  artifactRevisionSchema,
  PPT_STAGES,
  type PptCapabilityRequest,
  type PptJobId,
  type PptJobParams,
  type PptJobProjection,
  type PptJobState,
  type PptProposal,
  type PptStage,
  type PptStageAttempt,
  type PptStageRunId,
  type PresentationId,
  type ProposalId,
  pptCapabilityRequestSchema,
  pptJobStateSchema,
  pptProposalSchema,
  pptStageAttemptSchema,
  type StaleArtifact,
  toPptJobProjection,
} from "@shared/presentation-lifecycle";
import { createStorage, type Storage } from "../storage";

export type JobCasResult =
  | { type: "updated"; state: PptJobState }
  | { type: "already_applied"; state: PptJobState }
  | { type: "conflict"; current: PptJobState };

export type ArtifactCommitResult =
  | { type: "committed"; revision: ArtifactRevision }
  | { type: "already_committed"; revision: ArtifactRevision }
  | { type: "conflict"; existing: ArtifactRevision };

export type StageAttemptStartResult =
  | { type: "started"; attempt: PptStageAttempt }
  | { type: "already_started"; attempt: PptStageAttempt }
  | { type: "conflict"; attempt: PptStageAttempt };

export type StageAttemptFinishResult =
  | { type: "finished"; attempt: PptStageAttempt }
  | { type: "already_finished"; attempt: PptStageAttempt }
  | { type: "conflict"; attempt: PptStageAttempt };

export type ProposalResolveResult =
  | { type: "resolved"; proposal: PptProposal }
  | { type: "already_resolved"; proposal: PptProposal }
  | { type: "conflict"; proposal: PptProposal };

export type SideEffectClaimResult =
  | { type: "claimed" }
  | { type: "in_progress" }
  | { type: "succeeded"; result: unknown }
  | { type: "failed"; error: string };

export interface StalePropagationResult {
  staleArtifacts: StaleArtifact[];
  earliestStage?: PptStage;
}

export interface PresentationLifecycleRepositoryOptions {
  filePath: string;
  storage: Storage;
}

/**
 * Durable Presentation business repository. Query checkpoints deliberately
 * remain in their existing tables; only explicit lifecycle calls mutate these
 * records.
 * A path owns its storage; an injected storage is borrowed and never closed here.
 */
export class PresentationLifecycleRepository {
  private readonly storage: Storage;
  private readonly ownsStorage: boolean;
  readonly filePath: string;

  constructor(source: string | PresentationLifecycleRepositoryOptions) {
    this.filePath = typeof source === "string" ? source : source.filePath;
    this.ownsStorage = typeof source === "string";
    this.storage = typeof source === "string" ? createStorage(source) : source.storage;
  }

  close(): void {
    if (this.ownsStorage) this.storage.close();
  }

  createOrGetJob(input: {
    jobId: PptJobId;
    params: PptJobParams;
    currentRequest: PptCapabilityRequest;
  }): { type: "created" | "existing"; state: PptJobState } {
    return this.transaction(() => {
      const existing = this.getJobByPresentationId(input.params.presentationId);
      if (existing) return { type: "existing", state: existing };
      const request = pptCapabilityRequestSchema.parse(input.currentRequest);
      if (request.jobId !== input.jobId) {
        throw new Error("Capability request jobId does not match the new job.");
      }
      const state = pptJobStateSchema.parse({
        jobId: input.jobId,
        params: input.params,
        currentRequest: request,
        status: "running",
        stateRevision: 0,
        currentStage: "intent",
        committedArtifacts: [],
        staleArtifacts: [],
        createdAt: input.params.createdAt,
        updatedAt: input.params.createdAt,
      });
      this.storage.pptJobs.insert(state);
      this.insertCapabilityRequest(request);
      this.appendJobEvent(state.jobId, state.stateRevision, "job_created", state);
      return { type: "created", state };
    });
  }

  getJob(jobId: PptJobId): PptJobState | undefined {
    return this.storage.pptJobs.findById(jobId);
  }

  getJobByPresentationId(presentationId: PresentationId): PptJobState | undefined {
    return this.storage.pptJobs.findByPresentationId(presentationId);
  }

  getProjectionByPresentationId(presentationId: PresentationId): PptJobProjection | undefined {
    const state = this.getJobByPresentationId(presentationId);
    if (!state) return undefined;
    const proposal = state.proposalId ? this.getProposal(state.proposalId) : undefined;
    return toPptJobProjection(state, proposal);
  }

  addCapabilityRequest(requestInput: PptCapabilityRequest): void {
    const request = pptCapabilityRequestSchema.parse(requestInput);
    this.transaction(() => this.insertCapabilityRequest(request));
  }

  getCapabilityRequest(
    requestId: PptCapabilityRequest["requestId"],
  ): PptCapabilityRequest | undefined {
    return this.storage.pptCapabilityRequests.findById(requestId);
  }

  getCapabilityRequestByQuery(
    jobId: PptJobId,
    queryId: PptCapabilityRequest["queryId"] & string,
  ): PptCapabilityRequest | undefined {
    return this.storage.pptCapabilityRequests.findByQuery(jobId, queryId);
  }

  updateJobStateCas(input: {
    expectedStateRevision: number;
    nextState: PptJobState;
    eventType?: string;
  }): JobCasResult {
    const nextState = pptJobStateSchema.parse(input.nextState);
    return this.transaction(() => {
      const current = this.requireJob(nextState.jobId);
      if (current.stateRevision === nextState.stateRevision) {
        return statesEqual(current, nextState)
          ? { type: "already_applied", state: current }
          : { type: "conflict", current };
      }
      if (
        current.stateRevision !== input.expectedStateRevision ||
        nextState.stateRevision !== input.expectedStateRevision + 1 ||
        nextState.params.presentationId !== current.params.presentationId ||
        nextState.params.projectId !== current.params.projectId ||
        nextState.createdAt !== current.createdAt
      ) {
        return { type: "conflict", current };
      }
      if (!this.getCapabilityRequest(nextState.currentRequest.requestId)) {
        throw new Error("Job state references an unknown capability request.");
      }
      const updated = this.storage.pptJobs.updateStateIfRevision(
        nextState,
        input.expectedStateRevision,
      );
      if (!updated) {
        return { type: "conflict", current: this.requireJob(nextState.jobId) };
      }
      this.appendJobEvent(
        nextState.jobId,
        nextState.stateRevision,
        input.eventType ?? "state_updated",
        nextState,
      );
      return { type: "updated", state: nextState };
    });
  }

  commitArtifactRevision<T>(
    revisionInput: ArtifactRevision<T>,
    idempotencyKey: string,
  ): ArtifactCommitResult {
    const revision = artifactRevisionSchema.parse(revisionInput) as ArtifactRevision<T>;
    if (revision.validation.status !== "passed") {
      throw new Error("Only validated artifact candidates can be committed.");
    }
    if (hashArtifactValue(revision.value) !== revision.contentHash) {
      throw new Error("Artifact contentHash does not match its value.");
    }
    if (!idempotencyKey.trim()) throw new Error("idempotencyKey is required.");

    return this.transaction(() => {
      this.requireJob(revision.jobId);
      const byId = this.readArtifactRevision(revision.revisionId);
      if (byId) {
        return artifactsEqual(byId, revision)
          ? { type: "already_committed", revision: byId }
          : { type: "conflict", existing: byId };
      }
      const byKey = this.storage.pptArtifactRevisions.findByIdempotency(
        revision.jobId,
        idempotencyKey,
      );
      if (byKey) {
        const existing = byKey;
        return artifactPayloadsEqual(existing, revision)
          ? { type: "already_committed", revision: existing }
          : { type: "conflict", existing };
      }
      for (const dependency of revision.dependencies) {
        this.assertDependency(revision.jobId, dependency);
      }

      this.storage.pptArtifactRevisions.insert(revision, idempotencyKey);
      this.storage.pptArtifactDependencies.insertForRevision({
        revisionId: revision.revisionId,
        dependencies: revision.dependencies,
      });
      this.storage.pptArtifactHeads.upsert(
        revision.jobId,
        revision.artifactId,
        revision.revisionId,
      );
      return { type: "committed", revision };
    });
  }

  getArtifactRevision<T = unknown>(
    revisionId: ArtifactRevisionId,
  ): ArtifactRevision<T> | undefined {
    return this.readArtifactRevision(revisionId) as ArtifactRevision<T> | undefined;
  }

  getArtifactRevisionByIdempotency(
    jobId: PptJobId,
    idempotencyKey: string,
  ): ArtifactRevision | undefined {
    return this.storage.pptArtifactRevisions.findByIdempotency(jobId, idempotencyKey);
  }

  getArtifactHead(jobId: PptJobId, artifactId: ArtifactId): ArtifactRevision | undefined {
    const revisionId = this.storage.pptArtifactHeads.findRevisionId(jobId, artifactId);
    return revisionId ? this.readArtifactRevision(revisionId) : undefined;
  }

  listArtifactRevisions(jobId: PptJobId): ArtifactRevision[] {
    return this.storage.pptArtifactRevisions.listByJob(jobId);
  }

  listArtifactHeads(jobId: PptJobId): ArtifactPointer[] {
    return this.storage.pptArtifactHeads.listRevisionsByJob(jobId).map(pointerFor);
  }

  startStageAttempt(input: Omit<PptStageAttempt, "attempt" | "status">): StageAttemptStartResult {
    return this.transaction(() => {
      this.requireJob(input.jobId);
      const existing = this.getStageAttempt(input.stageRunId);
      if (existing) {
        const requested = pptStageAttemptSchema.parse({
          ...input,
          attempt: existing.attempt,
          status: "running",
        });
        return attemptStartsEqual(existing, requested)
          ? { type: "already_started", attempt: existing }
          : { type: "conflict", attempt: existing };
      }
      const byKey = this.storage.pptStageAttempts.findByIdempotency(
        input.jobId,
        input.idempotencyKey,
      );
      if (byKey) {
        const attempt = byKey;
        return { type: "conflict", attempt };
      }
      const count = this.storage.pptStageAttempts.countByStage(input.jobId, input.stage);
      const attempt = pptStageAttemptSchema.parse({
        ...input,
        attempt: count + 1,
        status: "running",
      });
      this.storage.pptStageAttempts.insert(attempt);
      return { type: "started", attempt };
    });
  }

  getStageAttempt(stageRunId: PptStageRunId): PptStageAttempt | undefined {
    return this.storage.pptStageAttempts.findById(stageRunId);
  }

  finishStageAttempt(input: {
    stageRunId: PptStageRunId;
    status: Exclude<PptStageAttempt["status"], "running">;
    artifactRevisionId?: ArtifactRevisionId;
    validation?: PptStageAttempt["validation"];
    error?: string;
    completedAt: string;
  }): StageAttemptFinishResult {
    return this.transaction(() => {
      const current = this.getStageAttempt(input.stageRunId);
      if (!current) throw new Error(`Unknown stage attempt ${input.stageRunId}.`);
      const completed = pptStageAttemptSchema.parse({
        ...current,
        status: input.status,
        artifactRevisionId: input.artifactRevisionId,
        validation: input.validation,
        error: input.error,
        completedAt: input.completedAt,
      });
      if (current.status !== "running") {
        return attemptsEqual(current, completed)
          ? { type: "already_finished", attempt: current }
          : { type: "conflict", attempt: current };
      }
      if (completed.artifactRevisionId) {
        const artifact = this.readArtifactRevision(completed.artifactRevisionId);
        if (!artifact) {
          throw new Error("Stage attempt references an unknown artifact revision.");
        }
        if (artifact.jobId !== completed.jobId || artifact.stage !== completed.stage) {
          throw new Error("Stage attempt artifact must belong to the same PptJob and stage.");
        }
      }
      const updated = this.storage.pptStageAttempts.updateIfRunning(completed);
      return updated
        ? { type: "finished", attempt: completed }
        : {
            type: "conflict",
            attempt: this.getStageAttempt(completed.stageRunId)!,
          };
    });
  }

  listStageAttempts(jobId: PptJobId): PptStageAttempt[] {
    return this.storage.pptStageAttempts.listByJob(jobId);
  }

  propagateStale(input: {
    jobId: PptJobId;
    replacement: ArtifactPointer;
    reason: string;
    detectedAt: string;
  }): StalePropagationResult {
    const replacement = artifactPointerSchema.parse(input.replacement);
    const heads = this.listArtifactHeads(input.jobId);
    const revisions = new Map(
      heads.map((pointer) => [pointer.revisionId, this.getArtifactRevision(pointer.revisionId)!]),
    );
    const staleByRevision = new Map<ArtifactRevisionId, StaleArtifact>();
    const changed = new Set<ArtifactId>([replacement.artifactId]);
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const revision of revisions.values()) {
        if (
          revision.artifactId === replacement.artifactId ||
          staleByRevision.has(revision.revisionId)
        )
          continue;
        const staleDependency = revision.dependencies.find((dependency) => {
          if (!changed.has(dependency.artifactId)) return false;
          if (dependency.artifactId !== replacement.artifactId) return true;
          return (
            dependency.revisionId !== replacement.revisionId ||
            dependency.contentHash !== replacement.contentHash
          );
        });
        if (!staleDependency) continue;
        staleByRevision.set(revision.revisionId, {
          artifactId: revision.artifactId,
          revisionId: revision.revisionId,
          staleBecause: staleDependency,
          reason: input.reason,
          detectedAt: input.detectedAt,
        });
        changed.add(revision.artifactId);
        progressed = true;
      }
    }
    const staleArtifacts = [...staleByRevision.values()].sort((left, right) => {
      const leftRevision = revisions.get(left.revisionId)!;
      const rightRevision = revisions.get(right.revisionId)!;
      return PPT_STAGES.indexOf(leftRevision.stage) - PPT_STAGES.indexOf(rightRevision.stage);
    });
    const earliestStage =
      staleArtifacts.length > 0 ? revisions.get(staleArtifacts[0].revisionId)?.stage : undefined;
    return { staleArtifacts, earliestStage };
  }

  propagateStaleFromSourceChange(input: {
    jobId: PptJobId;
    artifactId: ArtifactId;
    expectedRevisionId: ArtifactRevisionId;
    observedContentHash: ArtifactDependency["contentHash"];
    reason: string;
    detectedAt: string;
  }): StalePropagationResult {
    const heads = this.listArtifactHeads(input.jobId);
    const revisions = new Map(
      heads.map((pointer) => [pointer.revisionId, this.getArtifactRevision(pointer.revisionId)!]),
    );
    const changedRevision = revisions.get(input.expectedRevisionId);
    if (
      !changedRevision ||
      changedRevision.artifactId !== input.artifactId ||
      !heads.some(
        (pointer) =>
          pointer.artifactId === input.artifactId &&
          pointer.revisionId === input.expectedRevisionId,
      )
    ) {
      return { staleArtifacts: [], earliestStage: undefined };
    }

    const staleByRevision = new Map<ArtifactRevisionId, StaleArtifact>([
      [
        changedRevision.revisionId,
        {
          artifactId: changedRevision.artifactId,
          revisionId: changedRevision.revisionId,
          staleBecause: {
            artifactId: changedRevision.artifactId,
            revisionId: changedRevision.revisionId,
            contentHash: changedRevision.contentHash,
          },
          observedContentHash: input.observedContentHash,
          reason: input.reason,
          detectedAt: input.detectedAt,
        },
      ],
    ]);
    const changed = new Set<ArtifactId>([changedRevision.artifactId]);
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const revision of revisions.values()) {
        if (staleByRevision.has(revision.revisionId)) continue;
        const staleDependency = revision.dependencies.find((dependency) =>
          changed.has(dependency.artifactId),
        );
        if (!staleDependency) continue;
        staleByRevision.set(revision.revisionId, {
          artifactId: revision.artifactId,
          revisionId: revision.revisionId,
          staleBecause: staleDependency,
          reason: input.reason,
          detectedAt: input.detectedAt,
        });
        changed.add(revision.artifactId);
        progressed = true;
      }
    }
    const staleArtifacts = [...staleByRevision.values()].sort((left, right) => {
      const leftRevision = revisions.get(left.revisionId)!;
      const rightRevision = revisions.get(right.revisionId)!;
      return PPT_STAGES.indexOf(leftRevision.stage) - PPT_STAGES.indexOf(rightRevision.stage);
    });
    return {
      staleArtifacts,
      earliestStage: changedRevision.stage,
    };
  }

  createProposal(proposalInput: PptProposal): {
    type: "created" | "existing";
    proposal: PptProposal;
  } {
    const proposal = pptProposalSchema.parse(proposalInput);
    return this.transaction(() => {
      this.requireJob(proposal.jobId);
      const request = this.getCapabilityRequest(proposal.requestId);
      if (!request || request.jobId !== proposal.jobId || request.queryId !== proposal.queryId) {
        throw new Error(
          "Proposal must reference a capability request from the same PptJob and Query.",
        );
      }
      const artifact = this.readArtifactRevision(proposal.artifactRevisionId);
      if (!artifact) {
        throw new Error("Proposal references an unknown artifact revision.");
      }
      if (
        artifact.jobId !== proposal.jobId ||
        artifact.kind !== "command_proposal" ||
        artifact.stage !== "proposal"
      ) {
        throw new Error(
          "Proposal must reference a command_proposal artifact from the same PptJob.",
        );
      }
      const existing = this.getProposal(proposal.proposalId);
      if (existing) {
        if (!proposalsEqual(existing, proposal)) {
          throw new Error(`Proposal ${proposal.proposalId} already exists with different data.`);
        }
        return { type: "existing", proposal: existing };
      }
      this.storage.pptProposals.insert(proposal);
      return { type: "created", proposal };
    });
  }

  getProposal(proposalId: ProposalId): PptProposal | undefined {
    return this.storage.pptProposals.findById(proposalId);
  }

  resolveProposal(input: {
    proposalId: ProposalId;
    status: Exclude<PptProposal["status"], "waiting_approval">;
    resolvedAt: string;
  }): ProposalResolveResult {
    return this.transaction(() => {
      const current = this.getProposal(input.proposalId);
      if (!current) throw new Error(`Unknown proposal ${input.proposalId}.`);
      if (current.status !== "waiting_approval") {
        return current.status === input.status
          ? { type: "already_resolved", proposal: current }
          : { type: "conflict", proposal: current };
      }
      const proposal = pptProposalSchema.parse({
        ...current,
        status: input.status,
        resolvedAt: input.resolvedAt,
      });
      const updated = this.storage.pptProposals.updateIfWaitingApproval(proposal);
      return updated
        ? { type: "resolved", proposal }
        : { type: "conflict", proposal: this.getProposal(proposal.proposalId)! };
    });
  }

  claimSideEffect(input: {
    jobId: PptJobId;
    operation: "apply" | "export";
    key: string;
    claimedAt: string;
  }): SideEffectClaimResult {
    return this.transaction(() => {
      this.requireJob(input.jobId);
      const effect = this.storage.pptSideEffects.findByKey(input);
      if (effect) {
        if (effect.status === "succeeded") {
          return {
            type: "succeeded",
            result: effect.result,
          };
        }
        if (effect.status === "failed") {
          return { type: "failed", error: effect.error ?? "Unknown side-effect failure." };
        }
        return { type: "in_progress" };
      }
      this.storage.pptSideEffects.insertClaim(input);
      return { type: "claimed" };
    });
  }

  completeSideEffect(input: {
    jobId: PptJobId;
    operation: "apply" | "export";
    key: string;
    status: "succeeded" | "failed";
    result?: unknown;
    error?: string;
    completedAt: string;
  }): boolean {
    if (input.status === "failed" && !input.error?.trim()) {
      throw new Error("Failed side effects require an error.");
    }
    return this.storage.pptSideEffects.completeIfInProgress(input);
  }

  private insertCapabilityRequest(request: PptCapabilityRequest): void {
    const existing = this.getCapabilityRequest(request.requestId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(request)) {
        throw new Error(
          `Capability request ${request.requestId} already exists with different data.`,
        );
      }
      return;
    }
    this.storage.pptCapabilityRequests.insert(request);
  }

  private requireJob(jobId: PptJobId): PptJobState {
    const state = this.getJob(jobId);
    if (!state) throw new Error(`Unknown PptJob ${jobId}.`);
    return state;
  }

  private readArtifactRevision(revisionId: ArtifactRevisionId): ArtifactRevision | undefined {
    return this.storage.pptArtifactRevisions.findById(revisionId);
  }

  private assertDependency(jobId: PptJobId, dependency: ArtifactDependency): void {
    const stored = this.readArtifactRevision(dependency.revisionId);
    if (
      !stored ||
      stored.jobId !== jobId ||
      stored.artifactId !== dependency.artifactId ||
      stored.contentHash !== dependency.contentHash
    ) {
      throw new Error(
        `Artifact dependency ${dependency.revisionId} does not match a committed revision.`,
      );
    }
  }

  private appendJobEvent(
    jobId: PptJobId,
    stateRevision: number,
    eventType: string,
    payload: unknown,
  ): void {
    this.storage.pptJobEvents.append({
      jobId,
      stateRevision,
      eventType,
      payload,
      createdAt: new Date().toISOString(),
    });
  }

  withTransaction<T>(operation: () => T): T {
    return this.storage.transaction(operation);
  }

  private transaction<T>(operation: () => T): T {
    return this.withTransaction(operation);
  }
}

function pointerFor(revision: ArtifactRevision): ArtifactPointer {
  return artifactPointerSchema.parse({
    artifactId: revision.artifactId,
    revisionId: revision.revisionId,
    contentHash: revision.contentHash,
    kind: revision.kind,
    stage: revision.stage,
  });
}

function statesEqual(left: PptJobState, right: PptJobState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function artifactsEqual(left: ArtifactRevision, right: ArtifactRevision): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function artifactPayloadsEqual(left: ArtifactRevision, right: ArtifactRevision): boolean {
  const { revisionId: _leftRevisionId, committedAt: _leftCommittedAt, ...leftPayload } = left;
  const { revisionId: _rightRevisionId, committedAt: _rightCommittedAt, ...rightPayload } = right;
  return JSON.stringify(leftPayload) === JSON.stringify(rightPayload);
}

function attemptsEqual(left: PptStageAttempt, right: PptStageAttempt): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function attemptStartsEqual(existing: PptStageAttempt, requested: PptStageAttempt): boolean {
  return (
    existing.stageRunId === requested.stageRunId &&
    existing.jobId === requested.jobId &&
    existing.requestId === requested.requestId &&
    existing.queryId === requested.queryId &&
    existing.stage === requested.stage &&
    existing.idempotencyKey === requested.idempotencyKey &&
    (existing.candidate === undefined
      ? requested.candidate === undefined
      : requested.candidate !== undefined &&
        hashArtifactValue(existing.candidate) === hashArtifactValue(requested.candidate))
  );
}

function proposalsEqual(left: PptProposal, right: PptProposal): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
