import { DatabaseSync } from "node:sqlite";
import { init } from "@main/storage/init";
import { withSqliteTransaction } from "@main/storage/transaction";
import { describe, expect, it } from "vitest";

function writeState(database: DatabaseSync, key: string) {
  database.prepare("INSERT INTO app_state(key, value) VALUES(?, ?)").run(key, key);
}

describe("storage transactions", () => {
  it("rolls back a failed inner operation while allowing the outer transaction to commit", () => {
    const database = new DatabaseSync(":memory:");
    try {
      init(database);
      withSqliteTransaction(database, () => {
        writeState(database, "before");
        expect(() =>
          withSqliteTransaction(database, () => {
            writeState(database, "discarded");
            throw new Error("inner operation failed");
          }),
        ).toThrow("inner operation failed");
        withSqliteTransaction(database, () => writeState(database, "after"));
      });
      expect(database.prepare("SELECT key, value FROM app_state ORDER BY key").all()).toEqual([
        { key: "after", value: "after" },
        { key: "before", value: "before" },
      ]);
    } finally {
      database.close();
    }
  });

  it("rolls back successful inner writes when the outer transaction fails and allows later writes", () => {
    const database = new DatabaseSync(":memory:");
    try {
      init(database);
      writeState(database, "existing");
      expect(() =>
        withSqliteTransaction(database, () => {
          writeState(database, "outer");
          withSqliteTransaction(database, () => writeState(database, "inner"));
          throw new Error("outer operation failed");
        }),
      ).toThrow("outer operation failed");
      withSqliteTransaction(database, () => writeState(database, "later"));
      expect(database.prepare("SELECT key, value FROM app_state ORDER BY key").all()).toEqual([
        { key: "existing", value: "existing" },
        { key: "later", value: "later" },
      ]);
    } finally {
      database.close();
    }
  });
});
