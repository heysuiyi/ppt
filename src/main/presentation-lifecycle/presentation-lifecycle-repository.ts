import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { withSqliteTransaction } from "../sqlite-transaction";

interface JsonRow {
  json: string;
}

interface ArtifactRow {
  revision_json: string;
}

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
  connection: DatabaseSync;
}

/**
 * Durable Presentation business repository. Query checkpoints deliberately
 * remain in their existing tables; only explicit lifecycle calls mutate these
 * records.
 */
export class PresentationLifecycleRepository {
  private readonly database: DatabaseSync;
  private readonly ownsDatabase: boolean;
  readonly filePath: string;

  constructor(source: string | PresentationLifecycleRepositoryOptions) {
    this.filePath = typeof source === "string" ? source : source.filePath;
    this.ownsDatabase = typeof source === "string";
    if (typeof source === "string") {
      mkdirSync(dirname(source), { recursive: true });
      this.database = new DatabaseSync(source);
    } else {
      this.database = source.connection;
    }
    this.initializeSchema();
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
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
      this.database
        .prepare(`
        INSERT INTO ppt_jobs(
          job_id, project_id, presentation_id, state_revision,
          state_json, created_at, updated_at
        ) VALUES(?, ?, ?, 0, ?, ?, ?)
      `)
        .run(
          state.jobId,
          state.params.projectId,
          state.params.presentationId,
          JSON.stringify(state),
          state.createdAt,
          state.updatedAt,
        );
      this.insertCapabilityRequest(request);
      this.appendJobEvent(state.jobId, state.stateRevision, "job_created", state);
      return { type: "created", state };
    });
  }

  getJob(jobId: PptJobId): PptJobState | undefined {
    const row = this.database
      .prepare("SELECT state_json AS json FROM ppt_jobs WHERE job_id = ?")
      .get(jobId) as JsonRow | undefined;
    return row ? pptJobStateSchema.parse(JSON.parse(row.json)) : undefined;
  }

  getJobByPresentationId(presentationId: PresentationId): PptJobState | undefined {
    const row = this.database
      .prepare("SELECT state_json AS json FROM ppt_jobs WHERE presentation_id = ?")
      .get(presentationId) as JsonRow | undefined;
    return row ? pptJobStateSchema.parse(JSON.parse(row.json)) : undefined;
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
    const row = this.database
      .prepare("SELECT request_json AS json FROM ppt_capability_requests WHERE request_id = ?")
      .get(requestId) as JsonRow | undefined;
    return row ? pptCapabilityRequestSchema.parse(JSON.parse(row.json)) : undefined;
  }

  getCapabilityRequestByQuery(
    jobId: PptJobId,
    queryId: PptCapabilityRequest["queryId"] & string,
  ): PptCapabilityRequest | undefined {
    const row = this.database
      .prepare(`
      SELECT request_json AS json FROM ppt_capability_requests
      WHERE job_id = ? AND query_id = ?
    `)
      .get(jobId, queryId) as JsonRow | undefined;
    return row ? pptCapabilityRequestSchema.parse(JSON.parse(row.json)) : undefined;
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
      const result = this.database
        .prepare(`
        UPDATE ppt_jobs
        SET state_revision = ?, state_json = ?, updated_at = ?
        WHERE job_id = ? AND state_revision = ?
      `)
        .run(
          nextState.stateRevision,
          JSON.stringify(nextState),
          nextState.updatedAt,
          nextState.jobId,
          input.expectedStateRevision,
        );
      if (result.changes !== 1) {
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
      const byKey = this.database
        .prepare(`
        SELECT revision_json FROM ppt_artifact_revisions
        WHERE job_id = ? AND idempotency_key = ?
      `)
        .get(revision.jobId, idempotencyKey) as ArtifactRow | undefined;
      if (byKey) {
        const existing = parseArtifactRow(byKey);
        return artifactPayloadsEqual(existing, revision)
          ? { type: "already_committed", revision: existing }
          : { type: "conflict", existing };
      }
      for (const dependency of revision.dependencies) {
        this.assertDependency(revision.jobId, dependency);
      }

      this.database
        .prepare(`
        INSERT INTO ppt_artifact_revisions(
          revision_id, artifact_id, job_id, kind, stage, schema_version,
          content_hash, revision_json, idempotency_key, committed_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          revision.revisionId,
          revision.artifactId,
          revision.jobId,
          revision.kind,
          revision.stage,
          revision.schemaVersion,
          revision.contentHash,
          JSON.stringify(revision),
          idempotencyKey,
          revision.committedAt,
        );
      const insertDependency = this.database.prepare(`
        INSERT INTO ppt_artifact_dependencies(
          artifact_revision_id, dependency_artifact_id,
          dependency_revision_id, dependency_content_hash
        ) VALUES(?, ?, ?, ?)
      `);
      for (const dependency of revision.dependencies) {
        insertDependency.run(
          revision.revisionId,
          dependency.artifactId,
          dependency.revisionId,
          dependency.contentHash,
        );
      }
      this.database
        .prepare(`
        INSERT INTO ppt_artifact_heads(job_id, artifact_id, revision_id)
        VALUES(?, ?, ?)
        ON CONFLICT(job_id, artifact_id)
        DO UPDATE SET revision_id = excluded.revision_id
      `)
        .run(revision.jobId, revision.artifactId, revision.revisionId);
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
    const row = this.database
      .prepare(`
      SELECT revision_json FROM ppt_artifact_revisions
      WHERE job_id = ? AND idempotency_key = ?
    `)
      .get(jobId, idempotencyKey) as ArtifactRow | undefined;
    return row ? parseArtifactRow(row) : undefined;
  }

  getArtifactHead(jobId: PptJobId, artifactId: ArtifactId): ArtifactRevision | undefined {
    const row = this.database
      .prepare(`
      SELECT revision_id FROM ppt_artifact_heads
      WHERE job_id = ? AND artifact_id = ?
    `)
      .get(jobId, artifactId) as { revision_id: string } | undefined;
    return row ? this.readArtifactRevision(row.revision_id as ArtifactRevisionId) : undefined;
  }

  listArtifactRevisions(jobId: PptJobId): ArtifactRevision[] {
    const rows = this.database
      .prepare(`
      SELECT revision_json FROM ppt_artifact_revisions
      WHERE job_id = ? ORDER BY committed_at, revision_id
    `)
      .all(jobId) as unknown as ArtifactRow[];
    return rows.map(parseArtifactRow);
  }

  listArtifactHeads(jobId: PptJobId): ArtifactPointer[] {
    const rows = this.database
      .prepare(`
      SELECT r.revision_json
      FROM ppt_artifact_heads h
      JOIN ppt_artifact_revisions r ON r.revision_id = h.revision_id
      WHERE h.job_id = ?
      ORDER BY r.committed_at, r.revision_id
    `)
      .all(jobId) as unknown as ArtifactRow[];
    return rows.map((row) => pointerFor(parseArtifactRow(row)));
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
      const byKey = this.database
        .prepare(`
        SELECT attempt_json AS json FROM ppt_stage_attempts
        WHERE job_id = ? AND idempotency_key = ?
      `)
        .get(input.jobId, input.idempotencyKey) as JsonRow | undefined;
      if (byKey) {
        const attempt = pptStageAttemptSchema.parse(JSON.parse(byKey.json));
        return { type: "conflict", attempt };
      }
      const count = this.database
        .prepare(`
        SELECT COUNT(*) AS count FROM ppt_stage_attempts
        WHERE job_id = ? AND stage = ?
      `)
        .get(input.jobId, input.stage) as { count: number };
      const attempt = pptStageAttemptSchema.parse({
        ...input,
        attempt: count.count + 1,
        status: "running",
      });
      this.database
        .prepare(`
        INSERT INTO ppt_stage_attempts(
          stage_run_id, job_id, stage, attempt, status,
          idempotency_key, attempt_json, started_at, completed_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `)
        .run(
          attempt.stageRunId,
          attempt.jobId,
          attempt.stage,
          attempt.attempt,
          attempt.status,
          attempt.idempotencyKey,
          JSON.stringify(attempt),
          attempt.startedAt,
        );
      return { type: "started", attempt };
    });
  }

  getStageAttempt(stageRunId: PptStageRunId): PptStageAttempt | undefined {
    const row = this.database
      .prepare("SELECT attempt_json AS json FROM ppt_stage_attempts WHERE stage_run_id = ?")
      .get(stageRunId) as JsonRow | undefined;
    return row ? pptStageAttemptSchema.parse(JSON.parse(row.json)) : undefined;
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
      const result = this.database
        .prepare(`
        UPDATE ppt_stage_attempts
        SET status = ?, attempt_json = ?, completed_at = ?
        WHERE stage_run_id = ? AND status = 'running'
      `)
        .run(
          completed.status,
          JSON.stringify(completed),
          completed.completedAt!,
          completed.stageRunId,
        );
      return result.changes === 1
        ? { type: "finished", attempt: completed }
        : {
            type: "conflict",
            attempt: this.getStageAttempt(completed.stageRunId)!,
          };
    });
  }

  listStageAttempts(jobId: PptJobId): PptStageAttempt[] {
    const rows = this.database
      .prepare(`
      SELECT attempt_json AS json FROM ppt_stage_attempts
      WHERE job_id = ? ORDER BY started_at, attempt
    `)
      .all(jobId) as unknown as JsonRow[];
    return rows.map((row) => pptStageAttemptSchema.parse(JSON.parse(row.json)));
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
      this.database
        .prepare(`
        INSERT INTO ppt_proposals(
          proposal_id, job_id, status, proposal_json, created_at, resolved_at
        ) VALUES(?, ?, ?, ?, ?, NULL)
      `)
        .run(
          proposal.proposalId,
          proposal.jobId,
          proposal.status,
          JSON.stringify(proposal),
          proposal.createdAt,
        );
      return { type: "created", proposal };
    });
  }

  getProposal(proposalId: ProposalId): PptProposal | undefined {
    const row = this.database
      .prepare("SELECT proposal_json AS json FROM ppt_proposals WHERE proposal_id = ?")
      .get(proposalId) as JsonRow | undefined;
    return row ? pptProposalSchema.parse(JSON.parse(row.json)) : undefined;
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
      const result = this.database
        .prepare(`
        UPDATE ppt_proposals
        SET status = ?, proposal_json = ?, resolved_at = ?
        WHERE proposal_id = ? AND status = 'waiting_approval'
      `)
        .run(proposal.status, JSON.stringify(proposal), proposal.resolvedAt!, proposal.proposalId);
      return result.changes === 1
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
      const row = this.database
        .prepare(`
        SELECT status, result_json, error FROM ppt_side_effects
        WHERE job_id = ? AND operation = ? AND effect_key = ?
      `)
        .get(input.jobId, input.operation, input.key) as
        | { status: string; result_json: string | null; error: string | null }
        | undefined;
      if (row) {
        if (row.status === "succeeded") {
          return {
            type: "succeeded",
            result: row.result_json ? JSON.parse(row.result_json) : undefined,
          };
        }
        if (row.status === "failed") {
          return { type: "failed", error: row.error ?? "Unknown side-effect failure." };
        }
        return { type: "in_progress" };
      }
      this.database
        .prepare(`
        INSERT INTO ppt_side_effects(
          job_id, operation, effect_key, status, claimed_at
        ) VALUES(?, ?, ?, 'in_progress', ?)
      `)
        .run(input.jobId, input.operation, input.key, input.claimedAt);
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
    const result = this.database
      .prepare(`
      UPDATE ppt_side_effects
      SET status = ?, result_json = ?, error = ?, completed_at = ?
      WHERE job_id = ? AND operation = ? AND effect_key = ?
        AND status = 'in_progress'
    `)
      .run(
        input.status,
        input.result === undefined ? null : JSON.stringify(input.result),
        input.error ?? null,
        input.completedAt,
        input.jobId,
        input.operation,
        input.key,
      );
    return result.changes === 1;
  }

  private initializeSchema(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS ppt_jobs (
        job_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        presentation_id TEXT NOT NULL UNIQUE,
        state_revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ppt_capability_requests (
        request_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
        query_id TEXT,
        capability TEXT NOT NULL,
        request_json TEXT NOT NULL,
        requested_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ppt_requests_job_requested
        ON ppt_capability_requests(job_id, requested_at);
      CREATE UNIQUE INDEX IF NOT EXISTS ppt_requests_query
        ON ppt_capability_requests(job_id, query_id)
        WHERE query_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS ppt_artifact_revisions (
        revision_id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        stage TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        revision_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        UNIQUE(job_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS ppt_revisions_job_artifact
        ON ppt_artifact_revisions(job_id, artifact_id, committed_at);

      CREATE TABLE IF NOT EXISTS ppt_artifact_dependencies (
        artifact_revision_id TEXT NOT NULL
          REFERENCES ppt_artifact_revisions(revision_id) ON DELETE CASCADE,
        dependency_artifact_id TEXT NOT NULL,
        dependency_revision_id TEXT NOT NULL
          REFERENCES ppt_artifact_revisions(revision_id),
        dependency_content_hash TEXT NOT NULL,
        PRIMARY KEY(artifact_revision_id, dependency_revision_id)
      );

      CREATE TABLE IF NOT EXISTS ppt_artifact_heads (
        job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL,
        revision_id TEXT NOT NULL
          REFERENCES ppt_artifact_revisions(revision_id),
        PRIMARY KEY(job_id, artifact_id)
      );

      CREATE TABLE IF NOT EXISTS ppt_stage_attempts (
        stage_run_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        attempt_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(job_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS ppt_proposals (
        proposal_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        proposal_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS ppt_side_effects (
        job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        effect_key TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        claimed_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY(job_id, operation, effect_key)
      );

      CREATE TABLE IF NOT EXISTS ppt_job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES ppt_jobs(job_id) ON DELETE CASCADE,
        state_revision INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ppt_events_job_revision
        ON ppt_job_events(job_id, state_revision, id);
    `);
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
    this.database
      .prepare(`
      INSERT INTO ppt_capability_requests(
        request_id, job_id, query_id, capability, request_json, requested_at
      ) VALUES(?, ?, ?, ?, ?, ?)
    `)
      .run(
        request.requestId,
        request.jobId,
        request.queryId ?? null,
        request.capability,
        JSON.stringify(request),
        request.requestedAt,
      );
  }

  private requireJob(jobId: PptJobId): PptJobState {
    const state = this.getJob(jobId);
    if (!state) throw new Error(`Unknown PptJob ${jobId}.`);
    return state;
  }

  private readArtifactRevision(revisionId: ArtifactRevisionId): ArtifactRevision | undefined {
    const row = this.database
      .prepare("SELECT revision_json FROM ppt_artifact_revisions WHERE revision_id = ?")
      .get(revisionId) as ArtifactRow | undefined;
    return row ? parseArtifactRow(row) : undefined;
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
    this.database
      .prepare(`
      INSERT INTO ppt_job_events(
        job_id, state_revision, event_type, payload_json, created_at
      ) VALUES(?, ?, ?, ?, ?)
    `)
      .run(jobId, stateRevision, eventType, JSON.stringify(payload), new Date().toISOString());
  }

  withTransaction<T>(operation: () => T): T {
    return withSqliteTransaction(this.database, operation);
  }

  private transaction<T>(operation: () => T): T {
    return this.withTransaction(operation);
  }
}

function parseArtifactRow(row: ArtifactRow): ArtifactRevision {
  return artifactRevisionSchema.parse(JSON.parse(row.revision_json));
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
