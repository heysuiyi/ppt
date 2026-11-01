import type { AgentServiceEventListener } from "../../../plugins/ppt/service";
import { formatToolApprovalDetail } from "./format-tool-approval";
import type { ToolApprovalHandler, ToolApprovalRequest } from "./permission-check";

type PendingApproval = {
  runId: string;
  resolve: (status: "approved" | "denied") => void;
};

export class ToolApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly cancelledRuns = new Set<string>();

  createHandler(runId: string, emit: AgentServiceEventListener): ToolApprovalHandler {
    return async (request: ToolApprovalRequest) => {
      if (this.cancelledRuns.has(runId) || request.signal?.aborted) return false;

      const approvalId = crypto.randomUUID();
      return await new Promise<boolean>((resolve, reject) => {
        let settled = false;
        const finish = (status: "approved" | "denied"): void => {
          if (settled) return;
          settled = true;
          this.pending.delete(approvalId);
          request.signal?.removeEventListener("abort", onAbort);
          try {
            emit({
              type: "tool-approval-resolved",
              approvalId,
              toolName: request.toolName,
              status,
              message: status === "approved" ? "工具授权已确认" : "工具授权已拒绝",
            });
          } catch {
            // The authorization result remains authoritative if its observer has gone away.
          }
          resolve(status === "approved");
        };
        const onAbort = (): void => finish("denied");

        if (this.cancelledRuns.has(runId) || request.signal?.aborted) {
          finish("denied");
          return;
        }
        this.pending.set(approvalId, { runId, resolve: finish });
        request.signal?.addEventListener("abort", onAbort, { once: true });
        if (request.signal?.aborted) {
          finish("denied");
          return;
        }

        try {
          emit({
            type: "tool-approval-waiting",
            approvalId,
            toolName: request.toolName,
            reason: request.reason,
            detail: formatToolApprovalDetail(request.toolName, request.args),
            message: `工具 ${request.toolName} 需要您的确认`,
          });
        } catch (error) {
          if (!settled) {
            settled = true;
            this.pending.delete(approvalId);
            request.signal?.removeEventListener("abort", onAbort);
            reject(error);
          }
        }
      });
    };
  }

  resolve(approvalId: string, approved: boolean): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    entry.resolve(approved ? "approved" : "denied");
    return true;
  }

  cancelForRun(runId: string): void {
    this.cancelledRuns.add(runId);
    for (const entry of this.pending.values()) {
      if (entry.runId !== runId) continue;
      entry.resolve("denied");
    }
  }

  finishForRun(runId: string): void {
    this.cancelForRun(runId);
    this.cancelledRuns.delete(runId);
  }
}
