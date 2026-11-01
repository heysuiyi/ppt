import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { SessionDO } from "./session.do.ts";
import type { SessionWrite, StoredSession } from "./session.dto.ts";

export class SessionMapper {
  private upsertStatement?: StatementSync;
  private deleteStatement?: StatementSync;

  constructor(private readonly database: DatabaseSync) {}

  listOrdered(): StoredSession[] {
    const rows = this.database
      .prepare("SELECT id, ordinal, snapshot_json FROM sessions ORDER BY ordinal ASC")
      .all() as unknown as Pick<SessionDO, "id" | "ordinal" | "snapshot_json">[];
    return rows.map((row) => ({
      id: row.id,
      ordinal: row.ordinal,
      snapshotJson: row.snapshot_json,
    }));
  }

  listIds(): string[] {
    return (this.database.prepare("SELECT id FROM sessions").all() as Pick<SessionDO, "id">[]).map(
      (row) => row.id,
    );
  }

  deleteById(id: string): void {
    this.deleteStatement ??= this.database.prepare("DELETE FROM sessions WHERE id = ?");
    this.deleteStatement.run(id);
  }

  upsert(record: SessionWrite): void {
    const { session } = record.snapshot;
    this.upsertStatement ??= this.database.prepare(`
      INSERT INTO sessions(id, ordinal, snapshot_json, created_at, updated_at, workspace_path)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ordinal = excluded.ordinal,
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at,
        workspace_path = excluded.workspace_path
    `);
    this.upsertStatement.run(
      record.id,
      record.ordinal,
      JSON.stringify(record.snapshot),
      session.createdAt,
      session.updatedAt,
      session.workspacePath ?? null,
    );
  }
}
