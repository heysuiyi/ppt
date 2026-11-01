import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ConversationMappers, createConversationMappers } from "./conversation";
import { init } from "./init";
import { createPresentationMappers, type PresentationMappers } from "./presentation";
import { withSqliteTransaction } from "./transaction";

export { init } from "./init";

export interface Storage extends ConversationMappers, PresentationMappers {
  readonly filePath: string;
  transaction<T>(operation: () => T): T;
  close(): void;
}

/** Owns one connection shared by all mappers and synchronous business transactions. */
export function createStorage(filePath: string): Storage {
  mkdirSync(dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  try {
    init(database);
    return {
      filePath,
      ...createConversationMappers(database),
      ...createPresentationMappers(database),
      transaction<T>(operation: () => T): T {
        return withSqliteTransaction(database, operation);
      },
      close(): void {
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
