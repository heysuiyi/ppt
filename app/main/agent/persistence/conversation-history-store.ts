import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "@agent-harness/tools/atomic-files";
import type { Storage } from "../../storage";
import type { AgentModelMessage } from "../gateway";

export interface ConversationHistoryStore {
  load(threadId: string): Promise<AgentModelMessage[] | undefined>;
  save(threadId: string, messages: readonly AgentModelMessage[]): Promise<void>;
}

interface ConversationHistoryRecord {
  version: 1;
  threadId: string;
  messages: AgentModelMessage[];
  updatedAt: string;
}

function safeThreadId(threadId: string): string {
  return threadId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || "thread";
}

/** Canonical thread-level model history, separate from UI chat and query checkpoints. */
export class DurableConversationHistoryStore implements ConversationHistoryStore {
  constructor(private readonly storage: string | Storage) {}

  async load(threadId: string): Promise<AgentModelMessage[] | undefined> {
    if (typeof this.storage !== "string") {
      return this.storage.agentConversationHistories.load<AgentModelMessage[]>(threadId);
    }
    const record = await readJsonFile<ConversationHistoryRecord>(this.pathFor(threadId));
    if (record?.version !== 1 || record.threadId !== threadId) return undefined;
    return structuredClone(record.messages);
  }

  async save(threadId: string, messages: readonly AgentModelMessage[]): Promise<void> {
    const cloned = structuredClone([...messages]);
    if (typeof this.storage !== "string") {
      this.storage.agentConversationHistories.save(threadId, cloned);
      return;
    }
    await writeJsonFileAtomic(this.pathFor(threadId), {
      version: 1,
      threadId,
      messages: cloned,
      updatedAt: new Date().toISOString(),
    } satisfies ConversationHistoryRecord);
  }

  private pathFor(threadId: string): string {
    if (typeof this.storage !== "string") {
      throw new Error("SQLite-backed conversation history does not have a workspace path.");
    }
    return join(this.storage, ".agent", "threads", `${safeThreadId(threadId)}.json`);
  }
}
