import { describe, expect, it } from "vitest";
import { LeadInboxInputSource } from "../app/main/agent/runtime/background/lead-inbox-input-source";
import { AgentSession } from "../app/main/agent/runtime/lifecycle/agent-session";
import type { MessageBus } from "../app/main/agent/teammate/message-bus";

function createSession(): AgentSession {
  return new AgentSession({ transcript: [] });
}

describe("LeadInboxInputSource", () => {
  it("replays a permission response with the same stable id after a pre-checkpoint crash", async () => {
    const sentIds: string[] = [];
    const order: string[] = [];
    const claim = {
      version: 1 as const,
      claimId: "claim-1",
      agent: "lead",
      createdAt: new Date(0).toISOString(),
      messages: [
        {
          id: "message-1",
          from: "worker",
          to: "lead",
          type: "permission_request" as const,
          content: "need access",
          ts: 1,
          payload: { requestId: "request-1", toolName: "ExportPptx" },
        },
      ],
    };
    const bus = {
      claimInbox: async () => claim,
      send: async (message: { id?: string }) => {
        order.push("send");
        sentIds.push(message.id ?? "");
      },
      ackInboxClaim: async () => {
        order.push("ack");
      },
    } as unknown as MessageBus;

    const interrupted = new LeadInboxInputSource({
      messageBus: bus,
      requestToolApproval: async () => true,
      session: createSession(),
      commit: async () => {
        order.push("commit");
        throw new Error("checkpoint unavailable");
      },
    });
    await expect(interrupted.drain()).rejects.toThrow("checkpoint unavailable");
    expect(order).toEqual(["send", "commit"]);

    order.length = 0;
    const recovered = new LeadInboxInputSource({
      messageBus: bus,
      requestToolApproval: async () => true,
      session: createSession(),
      commit: async () => {
        order.push("commit");
      },
    });
    await recovered.drain();

    expect(sentIds).toEqual(["permission-response-request-1", "permission-response-request-1"]);
    expect(order).toEqual(["send", "commit", "ack"]);
  });
});
