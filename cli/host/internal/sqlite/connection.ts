import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentError } from "@agent-harness/core/protocol-errors";
import { initializeSqliteSchema } from "./schema.js";

/** 仅适配器内部共享；同一写连接协调 history/checkpoint/binding 的跨表不变量。 */
export class SqliteConnection {
  private closed = false;

  constructor(readonly database: DatabaseSync) {}

  assertOpen(): void {
    if (this.closed) throw new AgentError("store-disposed", "Agent stores have been disposed.");
  }

  transaction<T>(operation: () => T, mode: "read" | "write" = "write"): T {
    this.assertOpen();
    this.database.exec(mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // 回滚失败后不再复用连接；清理不能覆盖原操作（尤其提交确认未知）的异常。
        this.closeAfterFailure();
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  closeAfterFailure(): void {
    try {
      this.close();
    } catch {
      // 调用方仍须报告原始失败，关闭异常不能把提交未知改写成确定失败。
    }
  }
}

export function openSqliteWriter(filePath: string): SqliteConnection {
  if (filePath === ":memory:" || filePath.length === 0) {
    throw new AgentError(
      "invalid-database-path",
      "Agent stores require a persistent database file.",
    );
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const connection = new SqliteConnection(new DatabaseSync(filePath));
  try {
    connection.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
    `);
    initializeSqliteSchema(connection.database);
    return connection;
  } catch (error) {
    connection.closeAfterFailure();
    throw error;
  }
}

/** 发现路径只打开已有文件，不建目录、不初始化 schema，也不取得写锁。 */
export function openSqliteReader(filePath: string): SqliteConnection {
  const connection = new SqliteConnection(new DatabaseSync(filePath, { readOnly: true }));
  try {
    connection.database.exec("PRAGMA busy_timeout = 5000");
    return connection;
  } catch (error) {
    connection.closeAfterFailure();
    throw error;
  }
}
