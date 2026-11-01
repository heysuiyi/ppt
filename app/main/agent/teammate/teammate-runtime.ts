import type { TeammateProgressEvent } from "@shared/teammate-progress";
import { TeammateConversation } from "./teammate-conversation";
import type {
  AssignmentSource,
  TeammateAssignedPhase,
  TeammateExit,
  TeammateIdlePhase,
  TeammatePhase,
  TeammateState,
} from "./teammate-types";

export class TeammateCancellationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeammateCancellationError";
  }
}

export class TeammateRuntime {
  phase: TeammatePhase;
  readonly conversation: TeammateConversation;
  readonly workSummaries: string[] = [];

  constructor(
    private readonly state: TeammateState,
    input: {
      startIdle: boolean;
      prompt: string;
      emitProgress: (event: TeammateProgressEvent) => void;
    },
  ) {
    this.emitProgress = input.emitProgress;
    this.conversation = new TeammateConversation(input.startIdle ? undefined : input.prompt);
    if (input.startIdle) {
      const now = Date.now();
      this.phase = { kind: "idle", since: now, nextPollAt: now };
      this.syncActiveStatus("idle", now);
      return;
    }

    const activityId = this.createActivityId();
    this.phase = {
      kind: "assigned",
      assignment: { input: input.prompt, source: "spawn-prompt" },
      activityId,
      activityFinished: false,
      modelSteps: 0,
    };
    this.syncActiveStatus("running");
    this.emitAssignmentStarted(activityId, input.prompt);
  }

  private readonly emitProgress: (event: TeammateProgressEvent) => void;

  get signal(): AbortSignal {
    return this.state.controller.signal;
  }

  get name(): string {
    return this.state.name;
  }

  get role(): string {
    return this.state.role;
  }

  beginAssignment(input: {
    assignment: string;
    source: AssignmentSource;
    description: string;
    activityTaskId?: string;
    transcriptFields?: Record<string, unknown>;
  }): void {
    if (this.phase.kind !== "idle") {
      throw new Error(`Cannot begin assignment while teammate is ${this.phase.kind}.`);
    }
    this.conversation.appendUser(input.assignment, input.transcriptFields);
    const activityId = input.activityTaskId ?? this.createActivityId();
    this.phase = {
      kind: "assigned",
      assignment: {
        input: input.assignment,
        source: input.source,
        ...(input.activityTaskId ? { activityTaskId: input.activityTaskId } : {}),
      },
      activityId,
      activityFinished: false,
      modelSteps: 0,
    };
    this.syncActiveStatus("running");
    this.emitAssignmentStarted(activityId, input.description, input.activityTaskId);
  }

  continueAssignment(input: string, resetStepCount: boolean): void {
    const phase = this.requireAssigned();
    this.conversation.appendUser(input);
    phase.assignment = { ...phase.assignment, input };
    if (resetStepCount) phase.modelSteps = 0;
    this.syncActiveStatus("running");
  }

  incrementModelSteps(): void {
    this.requireAssigned().modelSteps += 1;
  }

  assignmentStepLimitReached(maxSteps: number): boolean {
    return this.requireAssigned().modelSteps >= maxSteps;
  }

  currentTurn(): TeammateAssignedPhase {
    return this.requireAssigned();
  }

  finishCurrentActivity(status: "completed" | "failed" | "interrupted", message?: string): void {
    const assignment = this.assignmentForActivity();
    if (!assignment || assignment.activityFinished) return;
    assignment.activityFinished = true;
    this.emitProgress({
      type: "teammate-assignment-finished",
      teammateName: this.state.name,
      activityId: assignment.activityId,
      ...(assignment.assignment.activityTaskId
        ? { taskId: assignment.assignment.activityTaskId }
        : {}),
      status,
      ...(message ? { message } : {}),
    });
  }

  transitionToIdle(idlePollMs: number): void {
    if (this.phase.kind !== "assigned") {
      throw new Error(`Cannot enter idle while teammate is ${this.phase.kind}.`);
    }
    if (!this.phase.activityFinished) {
      throw new Error("Cannot enter idle before the current activity is finished.");
    }
    const now = Date.now();
    this.phase = { kind: "idle", since: now, nextPollAt: now + idlePollMs };
    this.syncActiveStatus("idle", now);
  }

  updateIdlePhase(idle: TeammateIdlePhase): void {
    if (this.phase.kind !== "idle") {
      throw new Error(`Cannot update idle timing while teammate is ${this.phase.kind}.`);
    }
    this.phase = idle;
  }

  transitionToStopping(exit: Exclude<TeammateExit, { kind: "failed" }>): void {
    if (this.phase.kind === "stopping" || this.phase.kind === "failed") return;
    this.phase = {
      kind: "stopping",
      exit,
      ...(this.phase.kind === "assigned" ? { assignment: this.phase } : {}),
    };
  }

  transitionToFailed(error: Error): void {
    const assignment =
      this.phase.kind === "assigned"
        ? this.phase
        : this.phase.kind === "stopping" || this.phase.kind === "failed"
          ? this.phase.assignment
          : undefined;
    this.phase = {
      kind: "failed",
      exit: { kind: "failed", error },
      ...(assignment ? { assignment } : {}),
    };
    this.state.status = "failed";
    this.state.lastError = error.message;
    this.state.lastActiveAt = Date.now();
  }

  terminalExit(): TeammateExit {
    if (this.phase.kind !== "stopping" && this.phase.kind !== "failed") {
      throw new Error(`Teammate is not terminal: ${this.phase.kind}.`);
    }
    return this.phase.exit;
  }

  isTerminal(): boolean {
    return this.phase.kind === "stopping" || this.phase.kind === "failed";
  }

  finalizeStopped(): void {
    if (this.phase.kind !== "stopping") {
      throw new Error(`Cannot finalize stopped teammate from ${this.phase.kind}.`);
    }
    this.state.status = "stopped";
    this.state.lastActiveAt = Date.now();
  }

  recordSummary(summary: string): void {
    this.workSummaries.push(summary);
  }

  emitThinking(chunk: string): void {
    const assignment = this.assignmentForActivity();
    if (!assignment || assignment.activityFinished) return;
    this.emitProgress({
      type: "teammate-thinking-chunk",
      teammateName: this.state.name,
      activityId: assignment.activityId,
      ...(assignment.assignment.activityTaskId
        ? { taskId: assignment.assignment.activityTaskId }
        : {}),
      chunk,
    });
  }

  private requireAssigned(): TeammateAssignedPhase {
    if (this.phase.kind !== "assigned") {
      throw new Error(`Expected assigned teammate, received ${this.phase.kind}.`);
    }
    return this.phase;
  }

  private assignmentForActivity(): TeammateAssignedPhase | undefined {
    if (this.phase.kind === "assigned") return this.phase;
    if (this.phase.kind === "stopping" || this.phase.kind === "failed") {
      return this.phase.assignment;
    }
    return undefined;
  }

  private syncActiveStatus(status: "running" | "idle", at = Date.now()): void {
    this.state.status = status;
    this.state.lastActiveAt = at;
  }

  private createActivityId(): string {
    return `teammate:${this.state.name}:${crypto.randomUUID()}`;
  }

  private emitAssignmentStarted(activityId: string, description: string, taskId?: string): void {
    this.emitProgress({
      type: "teammate-assignment-started",
      teammateName: this.state.name,
      activityId,
      ...(taskId ? { taskId } : {}),
      description,
    });
  }
}
