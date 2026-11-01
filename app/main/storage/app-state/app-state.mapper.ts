import type { DatabaseSync } from "node:sqlite";

export class AppStateMapper {
  constructor(private readonly database: DatabaseSync) {}

  findActiveSessionId(): string | undefined {
    const row = this.database
      .prepare("SELECT value FROM app_state WHERE key = 'active_session_id'")
      .get() as { value: string } | undefined;
    return row?.value;
  }

  setActiveSessionId(sessionId: string): void {
    this.database
      .prepare(
        "INSERT INTO app_state(key, value) VALUES('active_session_id', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(sessionId);
  }
}
