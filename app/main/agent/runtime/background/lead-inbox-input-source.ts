import type { AgentMailboxMessage, InboxClaim, MessageBus } from "../../teammate/message-bus";
import { formatMailboxMessagesForHistory } from "../../teammate/message-bus";
import type { TeammateManager } from "../../teammate/spawn-teammate";
import type { AgentSession } from "../lifecycle/agent-session";
import type { ToolApprovalHandler } from "../tools/permission-check";

/**
 * Claims and commits lead inbox input. Permission responses intentionally retain
 * at-least-once delivery with a stable response id; checkpoint precedes claim ack.
 */
export class LeadInboxInputSource {
  constructor(
    private readonly input: {
      messageBus?: MessageBus;
      teammateManager?: TeammateManager;
      requestToolApproval?: ToolApprovalHandler;
      session: AgentSession;
      commit(): Promise<void>;
    },
  ) {}

  async drain(): Promise<string | undefined> {
    const { messageBus, teammateManager } = this.input;
    if (!messageBus) return undefined;
    const claim = teammateManager
      ? await teammateManager.claimLeadInbox()
      : await messageBus.claimInbox("lead");
    if (!claim) return undefined;

    const inbox = claim.messages.filter(
      (message) => !this.input.session.hasProcessedInboxMessage(message.id),
    );
    if (inbox.length === 0) {
      await this.ack(claim);
      return undefined;
    }

    const visibleMessages: AgentMailboxMessage[] = [];
    const systemNotes: string[] = [];
    for (const message of inbox) {
      if (message.type === "permission_request") {
        systemNotes.push(await this.handlePermissionRequest(message));
      } else {
        visibleMessages.push(message);
      }
    }

    const parts = [
      visibleMessages.length > 0
        ? `[Inbox]\n${formatMailboxMessagesForHistory(visibleMessages)}`
        : "",
      systemNotes.length > 0 ? `[Inbox permissions]\n${systemNotes.join("\n")}` : "",
    ].filter(Boolean);
    if (parts.length === 0) return undefined;

    const content = parts.join("\n\n");
    this.input.session.recordInboxConsumption(
      inbox.map((message) => message.id),
      { role: "user", content, inbox },
    );
    await this.input.commit();
    await this.ack(claim);
    return content;
  }

  private async handlePermissionRequest(message: AgentMailboxMessage): Promise<string> {
    const payload = message.payload ?? {};
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "unknown";
    const reason = typeof payload.reason === "string" ? payload.reason : message.content;
    const approved = this.input.requestToolApproval
      ? await this.input.requestToolApproval({ toolName, args: payload.args, reason })
      : false;

    await this.input.messageBus?.send({
      id: `permission-response-${requestId || message.id}`,
      from: "lead",
      to: message.from,
      type: "permission_response",
      content: approved ? "Permission approved by lead." : "Permission denied by lead.",
      payload: { requestId, approved, toolName, reason },
    });

    return `Permission request from ${message.from} for ${toolName} was ${approved ? "approved" : "denied"} and the response was sent.`;
  }

  private async ack(claim: InboxClaim): Promise<void> {
    if (this.input.teammateManager) {
      await this.input.teammateManager.ackLeadInboxClaim(claim.claimId);
    } else {
      await this.input.messageBus!.ackInboxClaim(claim.claimId);
    }
  }
}
