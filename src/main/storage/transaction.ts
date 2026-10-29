import type { DatabaseSync } from "node:sqlite";

interface TransactionState {
  sequence: number;
}

const transactionStates = new WeakMap<DatabaseSync, TransactionState>();

/**
 * SAVEPOINT works both as a top-level transaction and when another repository
 * already owns the same SQLite connection. That lets the session snapshot and
 * Presentation lifecycle records commit or roll back as one unit.
 */
export function withSqliteTransaction<T>(database: DatabaseSync, operation: () => T): T {
  const state = transactionStates.get(database) ?? { sequence: 0 };
  transactionStates.set(database, state);
  state.sequence += 1;
  const savepoint = `agent_ppt_tx_${state.sequence}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = operation();
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
