import { readJsonFile, writeJsonFileAtomic } from "@agent-harness/tools/atomic-files";
import type { AgentMailboxMessage } from "./message-bus";

export type ProtocolType = "shutdown" | "plan_approval";
export type ProtocolStatus = "pending" | "approved" | "rejected";
export type ProtocolRequestMessageType = "shutdown_request" | "plan_approval_request";
export type ProtocolResponseMessageType = "shutdown_response" | "plan_approval_response";

export interface ProtocolState {
  requestId: string;
  type: ProtocolType;
  sender: string;
  target: string;
  status: ProtocolStatus;
  payload: string;
  createdAt: number;
}

const RESPONSE_TYPES: Record<ProtocolType, ProtocolResponseMessageType> = {
  shutdown: "shutdown_response",
  plan_approval: "plan_approval_response",
};

export class ProtocolStateStore {
  private readonly requests = new Map<string, ProtocolState>();
  private hydratePromise?: Promise<void>;

  constructor(private readonly filePath?: string) {}

  async hydrate(): Promise<void> {
    if (!this.hydratePromise) {
      this.hydratePromise = (async () => {
        if (!this.filePath) return;
        const stored = await readJsonFile<{ version: 1; requests: ProtocolState[] }>(this.filePath);
        for (const state of stored?.requests ?? []) {
          this.requests.set(state.requestId, state);
        }
      })();
    }
    await this.hydratePromise;
  }

  async flush(): Promise<void> {
    if (!this.filePath) return;
    await writeJsonFileAtomic(this.filePath, {
      version: 1,
      requests: this.list(),
    });
  }

  createRequest(input: {
    type: ProtocolType;
    sender: string;
    target: string;
    payload: string;
  }): ProtocolState {
    const state: ProtocolState = {
      requestId: newRequestId(),
      type: input.type,
      sender: input.sender,
      target: input.target,
      status: "pending",
      payload: input.payload,
      createdAt: Date.now() / 1_000,
    };
    this.requests.set(state.requestId, state);
    return { ...state };
  }

  get(requestId: string): ProtocolState | undefined {
    const state = this.requests.get(requestId);
    return state ? { ...state } : undefined;
  }

  list(): ProtocolState[] {
    return Array.from(this.requests.values()).map((state) => ({ ...state }));
  }

  findPending(input: {
    type: ProtocolType;
    sender?: string;
    target?: string;
  }): ProtocolState | undefined {
    const state = Array.from(this.requests.values()).find(
      (candidate) =>
        candidate.type === input.type &&
        candidate.status === "pending" &&
        (!input.sender || candidate.sender === input.sender) &&
        (!input.target || candidate.target === input.target),
    );
    return state ? { ...state } : undefined;
  }

  remove(requestId: string): void {
    this.requests.delete(requestId);
  }

  matchResponse(input: {
    responseType: string;
    requestId: string;
    approve: boolean;
    sender?: string;
    target?: string;
  }): ProtocolState | undefined {
    const state = this.requests.get(input.requestId);
    if (!state) return undefined;
    if (RESPONSE_TYPES[state.type] !== input.responseType) return undefined;
    if (state.status !== "pending") return undefined;
    if (input.sender && state.target !== input.sender) return undefined;
    if (input.target && state.sender !== input.target) return undefined;

    state.status = input.approve ? "approved" : "rejected";
    return { ...state };
  }
}

export function routeProtocolResponses(
  messages: AgentMailboxMessage[],
  states: ProtocolStateStore,
): ProtocolState[] {
  const matched: ProtocolState[] = [];
  for (const message of messages) {
    if (!isProtocolResponseType(message.type)) continue;
    const requestId = readProtocolRequestId(message.payload);
    if (!requestId) continue;
    const state = states.matchResponse({
      responseType: message.type,
      requestId,
      approve: message.payload?.approve === true,
      sender: message.from,
      target: message.to,
    });
    if (state) matched.push(state);
  }
  return matched;
}

export function readProtocolRequestId(payload: Record<string, unknown> | undefined): string {
  if (typeof payload?.requestId === "string") return payload.requestId;
  if (typeof payload?.request_id === "string") return payload.request_id;
  return "";
}

export function isProtocolResponseType(value: string): value is ProtocolResponseMessageType {
  return value === "shutdown_response" || value === "plan_approval_response";
}

function newRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}
