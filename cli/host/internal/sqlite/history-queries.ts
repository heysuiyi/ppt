import type { StatementSync } from "node:sqlite";
import type { SqliteConnection } from "./connection.js";

/** 写端历史快照与宿主目录复用同一批次顺序；事务边界由调用方包住所有读取。 */
export function prepareHistoryBatches(connection: SqliteConnection): StatementSync {
  return connection.database.prepare(
    "SELECT payload FROM general_agent_history_batches WHERE thread_id = ? ORDER BY revision",
  );
}
