import type { DatabaseSync } from "node:sqlite";
import type { StoredContextSnapshot } from "./context-snapshot.dto.ts";

export class ContextSnapshotMapper {
  constructor(private readonly database: DatabaseSync) {}

  insert(
    input: Omit<StoredContextSnapshot, "id" | "createdAt">,
    createdAt: string,
  ): StoredContextSnapshot {
    const result = this.database
      .prepare(`
      INSERT INTO context_snapshots(
        session_id, thread_id, covered_sequence_start, covered_sequence_end,
        summary, model_context_json, token_estimate, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        input.sessionId,
        input.threadId ?? null,
        input.coveredSequenceStart,
        input.coveredSequenceEnd,
        input.summary,
        JSON.stringify(input.modelContext),
        input.tokenEstimate ?? null,
        createdAt,
      );
    return { ...input, id: Number(result.lastInsertRowid), createdAt };
  }

  latestForSession(sessionId: string): StoredContextSnapshot | undefined {
    const row = this.database
      .prepare(`
      SELECT id, session_id, thread_id, covered_sequence_start, covered_sequence_end,
        summary, model_context_json, token_estimate, created_at
      FROM context_snapshots WHERE session_id = ?
      ORDER BY covered_sequence_end DESC, id DESC LIMIT 1
    `)
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      sessionId: String(row.session_id),
      threadId: row.thread_id ? String(row.thread_id) : undefined,
      coveredSequenceStart: Number(row.covered_sequence_start),
      coveredSequenceEnd: Number(row.covered_sequence_end),
      summary: String(row.summary),
      modelContext: JSON.parse(String(row.model_context_json)),
      tokenEstimate:
        row.token_estimate === null || row.token_estimate === undefined
          ? undefined
          : Number(row.token_estimate),
      createdAt: String(row.created_at),
    };
  }
}
