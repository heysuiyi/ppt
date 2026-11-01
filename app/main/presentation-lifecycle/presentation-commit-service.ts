import { canonicalJson, hashArtifactValue } from "@ppt/core/artifact-hash";
import type { CommandBus, PreparedCommandMutation, PresentationCommand } from "@shared/commands";
import type { Presentation } from "@shared/presentation";
import type {
  PptJobId,
  PresentationId,
  ProjectId,
  ProposalId,
} from "@shared/presentation-lifecycle";
import type { FileSessionStore } from "../session-store";
import type { ContentAddressedBlobStore } from "./content-addressed-blob-store";
import type { PresentationLifecycleOrchestrator } from "./presentation-lifecycle-orchestrator";

export interface ProposalCommitIdentity {
  jobId: PptJobId;
  proposalId: ProposalId;
}

/**
 * Single write boundary for the authoritative Presentation. It prepares the
 * CommandBus mutation first, commits the session snapshot and lifecycle facts
 * in SQLite, then publishes the prepared state to memory and the workspace.
 */
export class PresentationCommitService {
  private readonly inFlightProposalApplies = new Map<ProposalId, Promise<Presentation>>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionId: string,
    private readonly projectId: ProjectId,
    private readonly presentationId: PresentationId,
    private readonly commandBus: CommandBus,
    private readonly sessionStore: FileSessionStore,
    private readonly lifecycle: PresentationLifecycleOrchestrator,
    private readonly blobStore: ContentAddressedBlobStore,
  ) {}

  execute(
    command: PresentationCommand,
    instruction = "Manual presentation command",
  ): Promise<Presentation> {
    return this.enqueueMutation(() =>
      this.commitManual(this.commandBus.prepareExecute(command), instruction),
    );
  }

  executeMany(
    commands: PresentationCommand[],
    instruction = "Apply validated presentation commands",
  ): Promise<Presentation> {
    return this.enqueueMutation(() =>
      this.commitManual(this.commandBus.prepareExecuteMany(commands), instruction),
    );
  }

  undo(): Promise<Presentation> {
    return this.enqueueMutation(() =>
      this.commitManual(this.commandBus.prepareUndo(), "Undo presentation edit"),
    );
  }

  redo(): Promise<Presentation> {
    return this.enqueueMutation(() =>
      this.commitManual(this.commandBus.prepareRedo(), "Redo presentation edit"),
    );
  }

  async applyProposal(
    commands: PresentationCommand[],
    identity: ProposalCommitIdentity,
  ): Promise<Presentation> {
    this.assertOwnedProposal(identity);
    const inFlight = this.inFlightProposalApplies.get(identity.proposalId);
    if (inFlight) return inFlight;

    const operation = this.enqueueMutation(() => this.applyProposalOnce(commands, identity));
    this.inFlightProposalApplies.set(identity.proposalId, operation);
    const clear = () => {
      if (this.inFlightProposalApplies.get(identity.proposalId) === operation) {
        this.inFlightProposalApplies.delete(identity.proposalId);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationQueue.then(operation);
    this.mutationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async applyProposalOnce(
    commands: PresentationCommand[],
    identity: ProposalCommitIdentity,
  ): Promise<Presentation> {
    const effectKey = `proposal:${identity.proposalId}`;
    const claimedAt = new Date().toISOString();
    const claim = this.lifecycle.repository.claimSideEffect({
      jobId: identity.jobId,
      operation: "apply",
      key: effectKey,
      claimedAt,
    });
    if (claim.type === "succeeded") {
      const proof = claim.result as {
        presentationRevisionId?: unknown;
        presentationRevisionNumber?: unknown;
      };
      const job = this.lifecycle.repository.getJob(identity.jobId);
      const presentation = this.commandBus.getSnapshot();
      if (
        typeof proof.presentationRevisionId === "string" &&
        typeof proof.presentationRevisionNumber === "number" &&
        job?.presentationRevisionId === proof.presentationRevisionId &&
        job.presentationRevisionNumber === proof.presentationRevisionNumber &&
        presentation.revision === proof.presentationRevisionNumber
      ) {
        this.lifecycle.assertPresentationSnapshot(identity.jobId, presentation);
        return presentation;
      }
      throw new Error("The durable apply proof does not match the authoritative Presentation.");
    }
    if (claim.type === "in_progress") {
      this.lifecycle.waitForUser(
        identity.jobId,
        "A previous proposal apply has an unproven outcome and will not be replayed.",
      );
      throw new Error(
        "This proposal apply is already in progress; its outcome must be reconciled before retry.",
      );
    }
    if (claim.type === "failed") {
      this.lifecycle.waitForUser(
        identity.jobId,
        "The previous proposal apply failed and cannot be replayed.",
      );
      throw new Error(
        `This proposal apply previously failed and will not be replayed: ${claim.error}`,
      );
    }
    try {
      return await this.commitPrepared(
        this.commandBus.prepareExecuteMany(commands),
        () => identity,
        effectKey,
      );
    } catch (error) {
      this.lifecycle.repository.completeSideEffect({
        jobId: identity.jobId,
        operation: "apply",
        key: effectKey,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      });
      const state = this.lifecycle.repository.getJob(identity.jobId);
      if (state && (state.status === "running" || state.status === "waiting_approval")) {
        this.lifecycle.waitForUser(
          identity.jobId,
          "Proposal apply failed; generate or approve a fresh proposal after reconciliation.",
        );
      }
      throw error;
    }
  }

  private assertOwnedProposal(identity: ProposalCommitIdentity): void {
    const job = this.lifecycle.repository.getJob(identity.jobId);
    if (
      !job ||
      job.params.projectId !== this.projectId ||
      job.params.presentationId !== this.presentationId
    ) {
      throw new Error(
        `PptJob ${identity.jobId} does not belong to this Presentation commit service.`,
      );
    }
    const proposal = this.lifecycle.repository.getProposal(identity.proposalId);
    if (!proposal || proposal.jobId !== identity.jobId) {
      throw new Error(
        `Proposal ${identity.proposalId} does not belong to PptJob ${identity.jobId}.`,
      );
    }
  }

  private async commitManual(
    prepared: PreparedCommandMutation,
    instruction: string,
  ): Promise<Presentation> {
    if (prepared.noOp) {
      return this.commandBus.commitPreparedMutation(prepared);
    }
    const existing = this.lifecycle.getState(this.presentationId);
    const state = this.lifecycle.beginCapability({
      projectId: this.projectId,
      presentationId: this.presentationId,
      capability: "edit",
      instruction,
      basePresentationRevisionId: existing?.presentationRevisionId,
    });
    return this.commitPrepared(prepared, () => ({ jobId: state.jobId }));
  }

  private async commitPrepared(
    prepared: PreparedCommandMutation,
    identity: () => {
      jobId: PptJobId;
      proposalId?: ProposalId;
    },
    applyEffectKey?: string,
  ): Promise<Presentation> {
    const presentationBlob = await this.blobStore.put(
      Buffer.from(canonicalJson(prepared.presentation), "utf8"),
      "application/vnd.agent-ppt.presentation+json",
    );
    try {
      await this.lifecycle.withProjectionNotificationBatch(() =>
        this.sessionStore.commitPresentationTransaction({
          sessionId: this.sessionId,
          presentation: prepared.presentation,
          commitLifecycle: () =>
            this.lifecycle.withTransaction(() => {
              const resolved = identity();
              const state = this.lifecycle.completePresentation({
                jobId: resolved.jobId,
                proposalId: resolved.proposalId,
                presentationRevisionNumber: prepared.presentation.revision,
                presentationBlob,
              });
              if (applyEffectKey) {
                const completed = this.lifecycle.repository.completeSideEffect({
                  jobId: resolved.jobId,
                  operation: "apply",
                  key: applyEffectKey,
                  status: "succeeded",
                  result: {
                    proposalId: resolved.proposalId,
                    presentationRevisionId: state.presentationRevisionId,
                    presentationRevisionNumber: state.presentationRevisionNumber,
                  },
                  completedAt: new Date().toISOString(),
                });
                if (!completed) {
                  throw new Error("Apply side-effect claim was not active.");
                }
              }
              return state;
            }),
          afterDatabaseCommit: () => {
            try {
              this.commandBus.commitPreparedMutation(prepared);
            } catch (error) {
              if (
                hashArtifactValue(this.commandBus.getSnapshot()) ===
                hashArtifactValue(prepared.presentation)
              ) {
                this.commandBus.discardPreparedMutation(prepared);
                return;
              }
              throw error;
            }
          },
        }),
      );
    } catch (error) {
      this.commandBus.discardPreparedMutation(prepared);
      throw error;
    }
    return this.commandBus.getSnapshot();
  }
}
