import { DatabaseSync } from "node:sqlite";
import { init } from "@main/storage";
import { describe, expect, it } from "vitest";

describe("storage init", () => {
  it.each([false, true])(
    "upgrades legacy checkpoints without losing data (partial migration: %s)",
    (partiallyMigrated) => {
      const database = new DatabaseSync(":memory:");
      try {
        database.exec(`
          CREATE TABLE run_checkpoints (
            thread_id TEXT PRIMARY KEY,
            run_id TEXT,
            checkpoint_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO run_checkpoints VALUES (
            'thread', 'run', '{"step":3}', '2026-10-29T00:00:00.000Z'
          );
        `);
        if (partiallyMigrated) {
          database.exec(`
            ALTER TABLE run_checkpoints ADD COLUMN writer_generation INTEGER NOT NULL DEFAULT 0;
            UPDATE run_checkpoints SET writer_generation = 7;
          `);
        }

        init(database);
        expect(
          database.prepare("SELECT * FROM run_checkpoints WHERE thread_id = ?").get("thread"),
        ).toEqual({
          thread_id: "thread",
          run_id: "run",
          checkpoint_json: '{"step":3}',
          updated_at: "2026-10-29T00:00:00.000Z",
          active_run_id: null,
          writer_generation: partiallyMigrated ? 7 : 0,
          writer_revision: 0,
          lease_updated_at: null,
        });

        database.exec("UPDATE run_checkpoints SET writer_revision = 4, active_run_id = 'owner'");
        init(database);
        expect(
          database
            .prepare("SELECT checkpoint_json, writer_revision, active_run_id FROM run_checkpoints")
            .get(),
        ).toEqual({ checkpoint_json: '{"step":3}', writer_revision: 4, active_run_id: "owner" });
      } finally {
        database.close();
      }
    },
  );
});
