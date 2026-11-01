import type { DatabaseSync } from "node:sqlite";

export class ServiceThreadMapper {
  constructor(private readonly database: DatabaseSync) {}

  save(threadId: string, state: unknown): void {
    this.database
      .prepare(`
      INSERT INTO service_threads(thread_id, state_json, updated_at)
      VALUES(?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `)
      .run(threadId, JSON.stringify(state), new Date().toISOString());
  }

  load<T>(threadId: string): T | undefined {
    const row = this.database
      .prepare("SELECT state_json FROM service_threads WHERE thread_id = ?")
      .get(threadId) as { state_json: string } | undefined;
    return row ? (JSON.parse(row.state_json) as T) : undefined;
  }
}
