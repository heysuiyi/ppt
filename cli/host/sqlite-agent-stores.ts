import type { CheckpointStore } from "@agent-harness/core/session/checkpoint-contract";
import type { SessionHistoryStore } from "@agent-harness/core/session/session-contract";
import type { HostSessionBindingStore } from "./host-session-binding.js";
import { createSqliteBindingStore } from "./internal/sqlite/binding.js";
import { createSqliteCheckpointStore } from "./internal/sqlite/checkpoint.js";
import { openSqliteWriter } from "./internal/sqlite/connection.js";
import { createSqliteHistoryStore } from "./internal/sqlite/history.js";

export interface SqliteAgentStores {
  readonly history: SessionHistoryStore;
  readonly checkpoints: CheckpointStore;
  readonly bindings: HostSessionBindingStore;
  dispose(): Promise<void>;
}

/** 只装配宿主持久化端口；连接、事务和表结构不越过此入口。 */
export function createSqliteAgentStores(filePath: string): SqliteAgentStores {
  const connection = openSqliteWriter(filePath);
  try {
    return {
      history: createSqliteHistoryStore(connection),
      checkpoints: createSqliteCheckpointStore(connection),
      bindings: createSqliteBindingStore(connection),
      async dispose() {
        connection.close();
      },
    };
  } catch (error) {
    connection.closeAfterFailure();
    throw error;
  }
}
