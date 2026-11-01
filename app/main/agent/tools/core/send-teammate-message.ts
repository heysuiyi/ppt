import { z } from "zod";
import type { AgentMailboxMessageType } from "../../teammate/message-bus";
import type { ToolDefinition } from "../tool-definition";

const leadMessageTypeSchema = z.enum([
  "message",
  "result",
  "idle_notification",
  "permission_request",
  "permission_response",
  "error",
]);

export const sendTeammateMessageSchema = z.object({
  name: z.string().describe("Existing teammate name to message"),
  content: z.string().describe("Message content to deliver to the teammate"),
  msg_type: leadMessageTypeSchema
    .optional()
    .describe(
      "Structured message type; defaults to message. Use shutdown_teammate for shutdown requests.",
    ),
  payload: z.record(z.string(), z.unknown()).optional().describe("Optional structured payload"),
});

export type SendTeammateMessageToolResult = {
  id: string;
  to: string;
  type: AgentMailboxMessageType;
  status: "sent";
  message: string;
};

export const sendTeammateMessageTool: ToolDefinition<
  typeof sendTeammateMessageSchema,
  SendTeammateMessageToolResult
> = {
  name: "send_teammate_message",
  description:
    "Send a message to an existing long-lived teammate agent. " +
    "Use this to give follow-up instructions after a teammate reports a result or goes idle.",
  category: "core",
  loadPolicy: "core",
  inputSchema: sendTeammateMessageSchema,
  risk: "low",
  permission: {
    profile: "teammate-message",
    description: "Send a structured mailbox message to an existing teammate.",
    scopes: ["main"],
    effects: ["workflow.delegate"],
    sandbox: "workspace",
    approval: "never",
  },
  async execute(args, context) {
    if (!context.messageBus) {
      throw new Error("Message bus is not configured.");
    }
    if (!context.teammateManager) {
      throw new Error("Teammate manager is not configured.");
    }

    const handle = context.teammateManager.get(args.name);
    if (!handle) {
      throw new Error(`Unknown teammate: ${args.name}`);
    }
    if (handle.status === "stopped" || handle.status === "failed") {
      throw new Error(`Teammate ${handle.name} is ${handle.status}.`);
    }

    const message = await context.messageBus.send({
      from: "lead",
      to: handle.name,
      content: args.content,
      type: args.msg_type ?? "message",
      payload: args.payload,
    });

    return {
      id: message.id,
      to: message.to,
      type: message.type,
      status: "sent",
      message: `Sent ${message.type} to ${message.to}.`,
    };
  },
};
