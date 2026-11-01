import type { DurableRunPhase, DurableRunStatus } from "../../persistence/durable-run-store";
import type { AgentRuntimeResult } from "../runtime-types";
import type { AgentTransition } from "./agent-transition";

export interface AgentTerminalState {
  status: DurableRunStatus;
  result?: AgentRuntimeResult;
  error?: string;
  sealed: boolean;
}

export interface AgentSessionInput {
  transcript: Array<Record<string, unknown>>;
  pendingUserContent?: string[];
  processedInboxMessageIds?: string[];
  phase?: DurableRunPhase;
  totalModelSteps?: number;
}

/**
 * Mutable state for one Runtime invocation.
 *
 * Recoverable collections expose read-only views. Collaborators update them
 * through explicit Session commands or AgentTransition values so checkpoint
 * snapshots never depend on scattered mutable aliases.
 */
export class AgentSession {
  private readonly transcriptValue: Array<Record<string, unknown>>;
  private readonly pendingUserContentValue: string[];
  private readonly processedInboxMessageIdsValue: Set<string>;
  private phaseValue: DurableRunPhase;
  private totalModelStepsValue: number;
  private runModelStepsValue = 0;
  private terminalStateValue?: AgentTerminalState;

  constructor(input: AgentSessionInput) {
    this.transcriptValue = input.transcript;
    this.pendingUserContentValue = input.pendingUserContent ?? [];
    this.processedInboxMessageIdsValue = new Set(input.processedInboxMessageIds ?? []);
    this.phaseValue = input.phase ?? "before_model";
    this.totalModelStepsValue = input.totalModelSteps ?? 0;
  }

  get transcript(): readonly Record<string, unknown>[] {
    return this.transcriptValue;
  }

  appendTranscript(entry: Record<string, unknown>): void {
    this.transcriptValue.push(entry);
  }

  get pendingUserContent(): readonly string[] {
    return this.pendingUserContentValue;
  }

  appendPendingUserContent(content: string): void {
    if (content) this.pendingUserContentValue.push(content);
  }

  takePendingUserContent(): string[] {
    return this.pendingUserContentValue.splice(0);
  }

  get processedInboxMessageIds(): ReadonlySet<string> {
    return this.processedInboxMessageIdsValue;
  }

  hasProcessedInboxMessage(id: string): boolean {
    return this.processedInboxMessageIdsValue.has(id);
  }

  recordInboxConsumption(ids: readonly string[], transcriptEntry: Record<string, unknown>): void {
    this.transcriptValue.push(transcriptEntry);
    for (const id of ids) this.processedInboxMessageIdsValue.add(id);
  }

  get phase(): DurableRunPhase {
    return this.phaseValue;
  }

  setPhase(phase: DurableRunPhase): void {
    this.phaseValue = phase;
  }

  get totalModelSteps(): number {
    return this.totalModelStepsValue;
  }

  get runModelSteps(): number {
    return this.runModelStepsValue;
  }

  beginModelStep(): number {
    const current = this.totalModelStepsValue;
    this.runModelStepsValue += 1;
    this.totalModelStepsValue += 1;
    this.phaseValue = "before_model";
    return current;
  }

  get terminalState(): AgentTerminalState | undefined {
    return this.terminalStateValue;
  }

  setTerminalState(terminal: AgentTerminalState): void {
    if (this.terminalStateValue?.sealed) {
      throw new Error("Cannot replace a sealed AgentSession terminal state.");
    }
    this.terminalStateValue = terminal;
    this.phaseValue = "finished";
  }

  overrideTerminalCandidate(terminal: Omit<AgentTerminalState, "sealed">): void {
    if (this.terminalStateValue?.sealed) {
      throw new Error("Cannot override a sealed AgentSession terminal state.");
    }
    this.setTerminalState({ ...terminal, sealed: false });
  }

  sealTerminal(): void {
    if (!this.terminalStateValue) {
      throw new Error("Cannot seal AgentSession before a terminal candidate exists.");
    }
    this.terminalStateValue = { ...this.terminalStateValue, sealed: true };
  }

  apply(transition: AgentTransition): void {
    switch (transition.type) {
      case "model_input_prepared":
        this.beginModelStep();
        return;
      case "model_response_received":
        if (transition.toolUses.length > 0) this.phaseValue = "model_committed";
        return;
      case "tool_claimed":
        this.phaseValue = "tool_running";
        return;
      case "tool_processed":
        this.phaseValue = "tool_committed";
        return;
      case "run_terminal":
        this.setTerminalState({
          status: transition.status,
          result: transition.result,
          error: transition.error,
          sealed: false,
        });
        return;
    }
  }
}
