import type { DatabaseSync } from "node:sqlite";
import {
  type AppendConversationEventInput,
  type ConversationEvent,
  type ConversationEventPage,
  conversationEventSchema,
} from "@shared/conversation-events";
import type { ConversationEventDO } from "./conversation-event.do.ts";

function toEvent(row: ConversationEventDO): ConversationEvent {
  return conversationEventSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    sequence: row.sequence,
    kind: row.kind,
    visibility: row.visibility,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  });
}

export class ConversationEventMapper {
  constructor(private readonly database: DatabaseSync) {}

  nextSequence(sessionId: string): number {
    return (
      this.database
        .prepare(
          "SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM conversation_events WHERE session_id = ?",
        )
        .get(sessionId) as { next: number }
    ).next;
  }

  insert(
    input: AppendConversationEventInput & { sessionId: string; createdAt: string },
    sequence: number,
  ): ConversationEvent {
    const result = this.database
      .prepare(`
      INSERT INTO conversation_events(
        session_id, run_id, thread_id, sequence, kind,
        visibility, payload_json, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        input.sessionId,
        input.runId ?? null,
        input.threadId ?? null,
        sequence,
        input.kind,
        input.visibility ?? "user_visible",
        JSON.stringify(input.payload ?? {}),
        input.createdAt,
      );
    return conversationEventSchema.parse({
      id: Number(result.lastInsertRowid),
      sessionId: input.sessionId,
      runId: input.runId,
      threadId: input.threadId,
      sequence,
      kind: input.kind,
      visibility: input.visibility ?? "user_visible",
      payload: input.payload ?? {},
      createdAt: input.createdAt,
    });
  }

  listForSession(sessionId: string, cursor: number, limit: number): ConversationEventPage {
    const rows = this.database
      .prepare(`
      SELECT id, session_id, run_id, thread_id, sequence, kind,
        visibility, payload_json, created_at
      FROM conversation_events
      WHERE session_id = ? AND sequence >= ?
      ORDER BY sequence ASC
      LIMIT ?
    `)
      .all(sessionId, cursor, limit + 1) as unknown as ConversationEventDO[];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    return {
      events: pageRows.map(toEvent),
      nextCursor: hasMore ? pageRows.at(-1)!.sequence + 1 : undefined,
    };
  }

  listForRun(runId: string): ConversationEvent[] {
    const rows = this.database
      .prepare(`
      SELECT id, session_id, run_id, thread_id, sequence, kind,
        visibility, payload_json, created_at
      FROM conversation_events
      WHERE run_id = ?
      ORDER BY sequence ASC
    `)
      .all(runId) as unknown as ConversationEventDO[];
    return rows.map(toEvent);
  }

  lastSequence(sessionId: string): number {
    return (
      this.database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM conversation_events WHERE session_id = ?",
        )
        .get(sessionId) as { sequence: number }
    ).sequence;
  }
}
