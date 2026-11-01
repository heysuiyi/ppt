import type { DatabaseSync } from "node:sqlite";

export class AgentConversationHistoryMapper {
  constructor(private readonly database: DatabaseSync) {}

  save(threadId: string, messages: unknown): void {
    this.database
      .prepare(`
      INSERT INTO agent_conversation_histories(thread_id, messages_json, updated_at)
      VALUES(?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        messages_json = excluded.messages_json,
        updated_at = excluded.updated_at
    `)
      .run(threadId, JSON.stringify(messages), new Date().toISOString());
  }

  load<T>(threadId: string): T | undefined {
    const row = this.database
      .prepare("SELECT messages_json FROM agent_conversation_histories WHERE thread_id = ?")
      .get(threadId) as { messages_json: string } | undefined;
    return row ? (JSON.parse(row.messages_json) as T) : undefined;
  }
}
