import { z } from "zod";
import type { ProtocolState } from "../../teammate/protocol-state";
import type { ToolDefinition } from "../tool-definition";

export const respondPlanApprovalSchema = z.object({
  request_id: z
    .string()
    .trim()
    .min(1)
    .describe("requestId from the teammate's plan_approval_request"),
  approve: z.boolean().describe("Whether lead approves the proposed plan"),
  reason: z.string().optional().describe("Approval note or actionable rejection reason"),
});

export type RespondPlanApprovalToolResult = {
  request: ProtocolState;
  response: "approved" | "rejected";
  message: string;
};

export const respondPlanApprovalTool: ToolDefinition<
  typeof respondPlanApprovalSchema,
  RespondPlanApprovalToolResult
> = {
  name: "respond_plan_approval",
  description:
    "Approve or reject a pending teammate plan_approval_request by request ID. " +
    "Use this before the teammate begins high-risk or broad changes.",
  category: "core",
  loadPolicy: "core",
  inputSchema: respondPlanApprovalSchema,
  risk: "low",
  permission: {
    profile: "teammate-message",
    description: "Respond to a teammate plan approval request.",
    scopes: ["main"],
    effects: ["workflow.delegate"],
    sandbox: "workspace",
    approval: "never",
  },
  async execute(args, context) {
    if (!context.teammateManager) {
      throw new Error("Teammate manager is not configured.");
    }

    const request = await context.teammateManager.respondPlanApproval(
      args.request_id,
      args.approve,
      args.reason,
    );
    const response = args.approve ? "approved" : "rejected";
    return {
      request,
      response,
      message: `Plan ${request.requestId} from ${request.sender} was ${response}; response sent.`,
    };
  },
};
