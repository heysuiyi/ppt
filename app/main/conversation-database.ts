import type {
  AppendConversationEventInput,
  ConversationEvent,
  ConversationEventPage,
} from "@shared/conversation-events";
import {
  migrateDisplayCardsToSvgOnly,
  migratePresentationToSvgOnly,
  repairPresentationIdentities,
} from "@shared/presentation-repair";
import { type SessionSnapshot, sessionSnapshotSchema } from "@shared/session";
import { createStorage, type Storage } from "./storage";
import type { CheckpointCasInput } from "./storage/checkpoint/checkpoint.dto.ts";
import type { StoredContextSnapshot } from "./storage/context-snapshot/context-snapshot.dto.ts";
import type { BeginRunInput, FinishRunInput, LatestSessionRun } from "./storage/run/run.dto.ts";

export interface ConversationDatabaseState {
  activeSessionId: string;
  sessions: SessionSnapshot[];
}

/**
 * Coordinates durable conversation state, run lifecycle and checkpoint ownership.
 * SQL and stored-record conversion belong to the object mappers in storage.
 */
export class ConversationDatabase {
  readonly storage: Storage;

  constructor(readonly filePath: string) {
    this.storage = createStorage(filePath);
  }

  close(): void {
    this.storage.close();
  }

  withTransaction<T>(operation: () => T): T {
    return this.storage.transaction(operation);
  }

  loadState(): ConversationDatabaseState {
    const requestedActive = this.storage.appState.findActiveSessionId() ?? "";
    const sessions = this.storage.sessions.listOrdered().map((row) => {
      const stored = JSON.parse(row.snapshotJson) as Omit<SessionSnapshot, "messages">;
      const repairedPresentation = migratePresentationToSvgOnly(
        repairPresentationIdentities(stored.presentation).value,
      ).value;
      const repairedDisplayCards = migrateDisplayCardsToSvgOnly(stored.displayCards ?? []).value;
      return sessionSnapshotSchema.parse({
        ...stored,
        presentation: repairedPresentation,
        displayCards: repairedDisplayCards,
        messages: this.storage.messages.listForSession(row.id),
      });
    });
    return {
      activeSessionId: sessions.some((item) => item.session.id === requestedActive)
        ? requestedActive
        : (sessions[0]?.session.id ?? ""),
      sessions,
    };
  }

  ensureProject(workspacePath: string, title: string): string {
    const existingId = this.storage.projects.findIdByWorkspacePath(workspacePath);
    const now = new Date().toISOString();
    if (existingId !== undefined) {
      this.storage.projects.updateTitle(existingId, title, now);
      return existingId;
    }
    const id = crypto.randomUUID();
    this.storage.projects.insert(id, workspacePath, title, now);
    return id;
  }

  replaceState(state: ConversationDatabaseState): void {
    this.withTransaction(() => {
      this.storage.appState.setActiveSessionId(state.activeSessionId);
      const ids = new Set(state.sessions.map((snapshot) => snapshot.session.id));
      for (const id of this.storage.sessions.listIds()) {
        if (!ids.has(id)) this.storage.sessions.deleteById(id);
      }
      for (const [ordinal, snapshot] of state.sessions.entries()) {
        const { messages, ...storedSnapshot } = snapshot;
        this.storage.sessions.upsert({
          id: snapshot.session.id,
          ordinal,
          snapshot: storedSnapshot,
        });
        this.storage.messages.deleteForSession(snapshot.session.id);
        for (const [messageOrdinal, message] of messages.entries()) {
          this.storage.messages.insert(
            snapshot.session.id,
            messageOrdinal,
            message,
            new Date().toISOString(),
          );
        }
      }
    });
  }

  hasRun(runId: string): boolean {
    return this.storage.runs.exists(runId);
  }

  latestSessionRun(sessionId: string): LatestSessionRun | undefined {
    return this.storage.runs.latestForSession(sessionId);
  }

  acceptRun(state: ConversationDatabaseState, input: BeginRunInput): void {
    this.withTransaction(() => {
      if (this.hasRun(input.runId)) throw new Error("This request has already been accepted.");
      this.replaceState(state);
      this.beginRun(input);
      this.storage.runs.markPreparing(input.runId);
    });
  }

  markRunRunning(runId: string): void {
    this.storage.runs.markRunning(runId);
  }

  beginRun(input: BeginRunInput): void {
    this.storage.runs.upsertStarted(input, new Date().toISOString());
    this.appendEvent({
      sessionId: input.sessionId,
      runId: input.runId,
      threadId: input.threadId ?? input.runId,
      kind: "run_started",
      payload: { request: input.request ?? "", provider: input.provider, model: input.model },
    });
    this.appendEvent({
      sessionId: input.sessionId,
      runId: input.runId,
      threadId: input.threadId ?? input.runId,
      kind: "user_message",
      payload: { content: input.request ?? "" },
    });
    this.appendEvent({
      sessionId: input.sessionId,
      runId: input.runId,
      threadId: input.threadId ?? input.runId,
      kind: "assistant_started",
      payload: {},
    });
  }

  bindRunQueryId(runId: string, queryId: string): void {
    const row = this.storage.runs.findQueryBinding(runId);
    if (!row) throw new Error(`Run not found: ${runId}`);
    if (queryId === runId || queryId === row.threadId) {
      throw new Error("QueryId must be distinct from runId and threadId.");
    }
    if (row.queryId === queryId) return;
    if (row.queryId) {
      throw new Error(`Run ${runId} is already bound to QueryId ${row.queryId}.`);
    }
    this.storage.runs.bindQueryIdIfUnbound(runId, queryId, new Date().toISOString());
    this.appendEvent({
      sessionId: row.sessionId,
      runId,
      threadId: row.threadId,
      kind: "query_started",
      visibility: "internal",
      payload: { queryId },
    });
  }

  getRunQueryId(runId: string): string | undefined {
    return this.storage.runs.findQueryId(runId);
  }

  finishRun(input: FinishRunInput): void {
    const row = this.storage.runs.findSession(input.runId);
    if (!row) return;
    this.storage.runs.finish(input, new Date().toISOString());
    this.appendEvent({
      sessionId: row.sessionId,
      runId: input.runId,
      threadId: input.threadId ?? row.threadId,
      kind:
        input.status === "completed"
          ? "run_completed"
          : input.status === "interrupted"
            ? "run_interrupted"
            : "run_failed",
      payload: { result: input.result, error: input.error },
    });
  }

  loadTerminalRunResult<T>(runId: string): T | undefined {
    const row = this.storage.runs.findResult(runId);
    if (!row || row.status === "running" || row.resultJson === undefined) return undefined;
    return JSON.parse(row.resultJson) as T;
  }

  interruptRunningRuns(error = "Application restarted before the run completed."): string[] {
    const ids = this.storage.runs.listUnfinishedIds();
    for (const runId of ids) this.finishRun({ runId, status: "interrupted", error });
    return ids;
  }

  appendEvent(input: AppendConversationEventInput): ConversationEvent | undefined {
    const sessionId = input.sessionId ?? this.sessionIdForRun(input.runId);
    if (!sessionId) return undefined;
    const createdAt = input.createdAt ?? new Date().toISOString();
    const sequence = this.storage.conversationEvents.nextSequence(sessionId);
    return this.storage.conversationEvents.insert({ ...input, sessionId, createdAt }, sequence);
  }

  appendRuntimeEvent(
    runId: string,
    kind: AppendConversationEventInput["kind"],
    payload: Record<string, unknown>,
    visibility: AppendConversationEventInput["visibility"] = "user_visible",
  ): ConversationEvent | undefined {
    return this.appendEvent({ runId, kind, payload, visibility });
  }

  listEvents(sessionId: string, cursor = 0, limit = 200): ConversationEventPage {
    const safeLimit = Math.max(1, Math.min(500, limit));
    return this.storage.conversationEvents.listForSession(sessionId, cursor, safeLimit);
  }

  listRunEvents(runId: string): ConversationEvent[] {
    return this.storage.conversationEvents.listForRun(runId);
  }

  openRunCheckpointLease(input: {
    threadId: string;
    runId: string;
    resume: boolean;
    allowTakeover?: boolean;
  }):
    | { type: "opened"; generation: number; revision: number; checkpoint?: unknown }
    | { type: "lease_busy"; activeRunId: string; generation: number } {
    return this.withTransaction(() => {
      const row = this.storage.checkpoints.findLease(input.threadId);
      if (row?.activeRunId && row.activeRunId !== input.runId && !input.allowTakeover) {
        // Recovery may interrupt a crashed owner; only a known terminal owner can be fenced out.
        if (!this.storage.runs.isTerminal(row.activeRunId)) {
          return {
            type: "lease_busy" as const,
            activeRunId: row.activeRunId,
            generation: row.writerGeneration,
          };
        }
      }
      if (row?.activeRunId === input.runId) {
        const checkpoint = JSON.parse(row.checkpointJson) as unknown;
        return {
          type: "opened" as const,
          generation: row.writerGeneration,
          revision: row.writerRevision,
          ...(checkpoint ? { checkpoint } : {}),
        };
      }
      const generation = (row?.writerGeneration ?? 0) + 1;
      this.storage.checkpoints.acquireLease(
        input.threadId,
        input.runId,
        generation,
        new Date().toISOString(),
      );
      const checkpoint = row ? (JSON.parse(row.checkpointJson) as unknown) : undefined;
      return {
        type: "opened" as const,
        generation,
        revision: 0,
        ...(checkpoint ? { checkpoint } : {}),
      };
    });
  }

  saveRunCheckpointCas(
    input: CheckpointCasInput,
  ): "saved" | "already_applied" | "stale_generation" | "revision_conflict" {
    return this.withTransaction(() => {
      const row = this.storage.checkpoints.findLease(input.threadId);
      if (!row || row.activeRunId !== input.runId || row.writerGeneration !== input.generation) {
        return "stale_generation";
      }
      const payload = JSON.stringify(input.checkpoint);
      if (row.writerRevision === input.nextRevision) {
        return row.checkpointJson === payload ? "already_applied" : "revision_conflict";
      }
      if (
        row.writerRevision !== input.expectedRevision ||
        input.nextRevision !== input.expectedRevision + 1
      ) {
        return "revision_conflict";
      }
      return this.storage.checkpoints.updateIfLeaseMatches(input, payload)
        ? "saved"
        : "revision_conflict";
    });
  }

  closeRunCheckpointLease(input: { threadId: string; runId: string; generation: number }): boolean {
    return this.storage.checkpoints.releaseLease(input.threadId, input.runId, input.generation);
  }

  inspectRunCheckpointLease(input: {
    threadId: string;
    runId: string;
    generation: number;
  }): { type: "active"; revision: number; checkpoint?: unknown } | { type: "stale" } {
    const row = this.storage.checkpoints.findLease(input.threadId);
    if (!row || row.activeRunId !== input.runId || row.writerGeneration !== input.generation) {
      return { type: "stale" };
    }
    const checkpoint = JSON.parse(row.checkpointJson) as unknown;
    return {
      type: "active",
      revision: row.writerRevision,
      ...(checkpoint ? { checkpoint } : {}),
    };
  }

  saveContextSnapshot(
    input: Omit<StoredContextSnapshot, "id" | "createdAt">,
  ): StoredContextSnapshot {
    return this.storage.contextSnapshots.insert(input, new Date().toISOString());
  }

  saveContextSnapshotForRun(
    runId: string,
    modelContext: unknown,
    notes: string[],
  ): StoredContextSnapshot | undefined {
    const run = this.storage.runs.findSession(runId);
    if (!run) return undefined;
    const boundary = this.storage.conversationEvents.lastSequence(run.sessionId);
    const previous = this.latestContextSnapshot(run.sessionId);
    return this.saveContextSnapshot({
      sessionId: run.sessionId,
      threadId: run.threadId,
      coveredSequenceStart: previous ? previous.coveredSequenceEnd + 1 : 0,
      coveredSequenceEnd: boundary,
      summary: notes.join("\n") || "Prepared model context snapshot.",
      modelContext,
    });
  }

  latestContextSnapshot(sessionId: string): StoredContextSnapshot | undefined {
    return this.storage.contextSnapshots.latestForSession(sessionId);
  }

  private sessionIdForRun(runId: string | undefined): string | undefined {
    return runId ? this.storage.runs.findSession(runId)?.sessionId : undefined;
  }
}
