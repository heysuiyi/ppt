import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../../../tools/internal/atomic";

type LockRelease = () => Promise<void>;
type LockOptions = {
  realpath?: boolean;
  stale?: number;
  retries?:
    | number
    | {
        retries?: number;
        factor?: number;
        minTimeout?: number;
        maxTimeout?: number;
      };
};
type ProperLockfile = {
  lock(file: string, options?: LockOptions): Promise<LockRelease>;
};

const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile") as ProperLockfile;

export type AgentMailboxMessageType =
  | "message"
  | "result"
  | "idle_notification"
  | "permission_request"
  | "permission_response"
  | "shutdown_request"
  | "shutdown_response"
  | "plan_approval_request"
  | "plan_approval_response"
  | "error";

export interface AgentMailboxMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  type: AgentMailboxMessageType;
  ts: number;
  payload?: Record<string, unknown>;
}

export interface SendMailboxMessageInput {
  /** 稳定 ID 用于保证协议响应在 claim 重放时保持幂等。 */
  id?: string;
  from: string;
  to: string;
  content: string;
  type?: AgentMailboxMessageType;
  payload?: Record<string, unknown>;
}

export interface InboxClaim {
  version: 1;
  claimId: string;
  agent: string;
  messages: AgentMailboxMessage[];
  createdAt: string;
}

const LOCK_OPTIONS: LockOptions = {
  realpath: false,
  stale: 5_000,
  retries: {
    retries: 20,
    factor: 1,
    minTimeout: 10,
    maxTimeout: 75,
  },
};

/** 每个 inbox 文件在本进程内的串行队列，避免同进程竞争者互相消耗文件锁的重试预算。 */
const mailboxQueues = new Map<string, Promise<unknown>>();

export function sanitizeAgentName(name: string): string {
  const sanitized = name.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return sanitized || "agent";
}

export function formatMailboxMessagesForHistory(
  messages: AgentMailboxMessage[],
  maxContentChars?: number,
): string {
  return messages
    .map((message) => {
      const normalizedContent = message.content.trim();
      const content =
        maxContentChars === undefined
          ? normalizedContent
          : normalizedContent.slice(0, Math.max(0, maxContentChars));
      const prefix = `From ${message.from} [${message.type}]`;
      if (message.type === "permission_request") {
        const toolName =
          typeof message.payload?.toolName === "string" ? message.payload.toolName : "unknown";
        const reason =
          typeof message.payload?.reason === "string" ? message.payload.reason : content;
        return `${prefix}: permission requested for ${toolName}. ${reason}`;
      }
      if (message.type === "permission_response") {
        const approved = message.payload?.approved === true ? "approved" : "denied";
        return `${prefix}: permission ${approved}. ${content}`;
      }
      if (message.type === "shutdown_response" || message.type === "plan_approval_response") {
        const status = message.payload?.approve === true ? "approved" : "rejected";
        const requestId =
          typeof message.payload?.requestId === "string" ? message.payload.requestId : "unknown";
        return `${prefix}: request ${requestId} ${status}. ${content}`;
      }
      if (message.type === "shutdown_request" || message.type === "plan_approval_request") {
        const requestId =
          typeof message.payload?.requestId === "string" ? message.payload.requestId : "unknown";
        return `${prefix}: request ${requestId}. ${content}`;
      }
      return `${prefix}: ${content}`;
    })
    .join("\n");
}

export class MessageBus {
  constructor(private readonly mailboxDir: string) {}

  static defaultMailboxDir(workspaceRoot: string): string {
    return join(workspaceRoot, ".agents", "mailboxes");
  }

  getProtocolStatePath(): string {
    return join(this.mailboxDir, "..", "protocol-state.json");
  }

  getTeammateStatePath(): string {
    return join(this.mailboxDir, "..", "teammates.json");
  }

  getInboxPath(agent: string): string {
    return join(this.mailboxDir, `${sanitizeAgentName(agent)}.jsonl`);
  }

  async send(input: SendMailboxMessageInput): Promise<AgentMailboxMessage> {
    const message: AgentMailboxMessage = {
      id: input.id ?? crypto.randomUUID(),
      from: sanitizeAgentName(input.from),
      to: sanitizeAgentName(input.to),
      content: input.content,
      type: input.type ?? "message",
      ts: Date.now() / 1_000,
      ...(input.payload ? { payload: input.payload } : {}),
    };
    const inboxPath = this.getInboxPath(message.to);

    await this.withMailboxLock(inboxPath, async () => {
      const handle = await open(inboxPath, "a");
      try {
        await handle.writeFile(`${JSON.stringify(message)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });

    return message;
  }

  async readInbox(agent: string): Promise<AgentMailboxMessage[]> {
    const inboxPath = this.getInboxPath(agent);
    return this.withMailboxLock(inboxPath, async () => {
      const messages = await this.readMessagesUnlocked(inboxPath);
      if (messages.length > 0) {
        await rm(inboxPath, { force: true });
      }
      return messages;
    });
  }

  async claimInbox(agent: string): Promise<InboxClaim | undefined> {
    const safeAgent = sanitizeAgentName(agent);
    const inboxPath = this.getInboxPath(safeAgent);
    return this.withMailboxLock(inboxPath, async () => {
      const existing = await this.readPendingClaim(safeAgent);
      if (existing) return existing;

      const messages = await this.readMessagesUnlocked(inboxPath);
      if (messages.length === 0) return undefined;
      const claim: InboxClaim = {
        version: 1,
        claimId: `${safeAgent}-${crypto.randomUUID()}`,
        agent: safeAgent,
        messages,
        createdAt: new Date().toISOString(),
      };
      // 删除 mailbox 前先持久化 claim。两步之间崩溃可能造成批次重复，
      // 但不会丢失消息；Runtime 消息 ID 是重放时的幂等边界。
      await writeJsonFileAtomic(this.claimPath(claim.claimId), claim);
      await rm(inboxPath, { force: true });
      return claim;
    });
  }

  async ackInboxClaim(claimId: string): Promise<void> {
    await rm(this.claimPath(claimId), { force: true });
    await rm(`${this.claimPath(claimId)}.bak`, { force: true });
  }

  async peekInbox(agent: string): Promise<AgentMailboxMessage[]> {
    const inboxPath = this.getInboxPath(agent);
    return this.withMailboxLock(inboxPath, async () => this.readMessagesUnlocked(inboxPath));
  }

  /**
   * 同一进程内的并发访问先在内存里排队，文件锁只用于跨进程互斥。
   * proper-lockfile 的重试间隔固定，N 个同进程竞争者需要 N 个轮询周期才能排空，
   * 竞争者稍多就会耗尽重试预算并抛出 ELOCKED。
   */
  private withMailboxLock<T>(inboxPath: string, fn: () => Promise<T>): Promise<T> {
    const previous = mailboxQueues.get(inboxPath) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.withInterProcessLock(inboxPath, fn));
    mailboxQueues.set(inboxPath, current);
    return current.finally(() => {
      if (mailboxQueues.get(inboxPath) === current) mailboxQueues.delete(inboxPath);
    });
  }

  private async withInterProcessLock<T>(inboxPath: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.mailboxDir, { recursive: true });
    const release = await lockfile.lock(inboxPath, LOCK_OPTIONS);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private claimPath(claimId: string): string {
    return join(this.mailboxDir, ".processing", `${sanitizeAgentName(claimId)}.json`);
  }

  private async readPendingClaim(agent: string): Promise<InboxClaim | undefined> {
    const directory = join(this.mailboxDir, ".processing");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    const prefix = `${sanitizeAgentName(agent)}-`;
    for (const name of names
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json"))
      .sort()) {
      const claim = await readJsonFile<InboxClaim>(join(directory, name));
      if (claim?.version === 1 && claim.agent === sanitizeAgentName(agent)) return claim;
    }
    return undefined;
  }

  private async readMessagesUnlocked(inboxPath: string): Promise<AgentMailboxMessage[]> {
    let raw = "";
    try {
      raw = await readFile(inboxPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const messages = raw
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [parseMailboxMessage(JSON.parse(line))];
        } catch {
          return [];
        }
      });
    const seen = new Set<string>();
    return messages.filter((message) => {
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
  }
}

function parseMailboxMessage(value: unknown): AgentMailboxMessage {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid mailbox message.");
  }
  const record = value as Record<string, unknown>;
  return {
    id: typeof record.id === "string" ? record.id : crypto.randomUUID(),
    from: sanitizeAgentName(typeof record.from === "string" ? record.from : "unknown"),
    to: sanitizeAgentName(typeof record.to === "string" ? record.to : "unknown"),
    content: typeof record.content === "string" ? record.content : "",
    type: isMailboxMessageType(record.type) ? record.type : "message",
    ts: typeof record.ts === "number" ? record.ts : Date.now() / 1_000,
    ...(record.payload && typeof record.payload === "object"
      ? { payload: record.payload as Record<string, unknown> }
      : {}),
  };
}

function isMailboxMessageType(value: unknown): value is AgentMailboxMessageType {
  return (
    value === "message" ||
    value === "result" ||
    value === "idle_notification" ||
    value === "permission_request" ||
    value === "permission_response" ||
    value === "shutdown_request" ||
    value === "shutdown_response" ||
    value === "plan_approval_request" ||
    value === "plan_approval_response" ||
    value === "error"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
