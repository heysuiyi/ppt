import type { DatabaseSync, StatementSync } from "node:sqlite";
import { type SessionChatMessage, sessionChatMessageSchema } from "@shared/session";

export class MessageMapper {
  private deleteStatement?: StatementSync;
  private insertStatement?: StatementSync;

  constructor(private readonly database: DatabaseSync) {}

  listForSession(sessionId: string): SessionChatMessage[] {
    const rows = this.database
      .prepare("SELECT message_json FROM messages WHERE session_id = ? ORDER BY ordinal ASC")
      .all(sessionId) as Array<{ message_json: string }>;
    return rows.map((row) => sessionChatMessageSchema.parse(JSON.parse(row.message_json)));
  }

  deleteForSession(sessionId: string): void {
    this.deleteStatement ??= this.database.prepare("DELETE FROM messages WHERE session_id = ?");
    this.deleteStatement.run(sessionId);
  }

  insert(sessionId: string, ordinal: number, message: SessionChatMessage, now: string): void {
    this.insertStatement ??= this.database.prepare(`
      INSERT INTO messages(
        session_id, message_id, ordinal, role, thread_id,
        message_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertStatement.run(
      sessionId,
      message.id,
      ordinal,
      message.role,
      message.threadId ?? null,
      JSON.stringify(message),
      now,
      now,
    );
  }
}
