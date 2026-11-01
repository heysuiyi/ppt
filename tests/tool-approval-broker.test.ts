import { describe, expect, it, vi } from "vitest";
import { ToolApprovalBroker } from "../app/main/agent/runtime/tools/tool-approval-broker";

describe("ToolApprovalBroker", () => {
  it("waits for resolve before returning approval decision", async () => {
    const broker = new ToolApprovalBroker();
    const emit = vi.fn();
    const handler = broker.createHandler("run-1", emit);

    const pending = handler({
      toolName: "bash",
      args: { command: "echo hi" },
      reason: "Shell 命令：echo hi",
    });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool-approval-waiting",
        toolName: "bash",
        reason: "Shell 命令：echo hi",
      }),
    );

    const approvalId = emit.mock.calls[0]![0].approvalId as string;
    expect(broker.resolve(approvalId, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(emit).toHaveBeenLastCalledWith({
      type: "tool-approval-resolved",
      approvalId,
      toolName: "bash",
      status: "approved",
      message: "工具授权已确认",
    });
  });

  it("cancels pending approvals when a run is aborted", async () => {
    const broker = new ToolApprovalBroker();
    const emit = vi.fn();
    const handler = broker.createHandler("run-2", emit);
    const pending = handler({
      toolName: "WriteFile",
      args: { path: "a.md", content: "x" },
      reason: "文件修改",
    });

    broker.cancelForRun("run-2");
    await expect(pending).resolves.toBe(false);
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "tool-approval-resolved",
        status: "denied",
      }),
    );
  });

  it("rejects approvals created after the run was already cancelled", async () => {
    const broker = new ToolApprovalBroker();
    const emit = vi.fn();
    const handler = broker.createHandler("run-3", emit);

    broker.cancelForRun("run-3");

    await expect(
      handler({
        toolName: "WriteFile",
        args: { path: "late.md", content: "x" },
        reason: "文件修改",
      }),
    ).resolves.toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("ends a pending approval when its run signal aborts", async () => {
    const broker = new ToolApprovalBroker();
    const controller = new AbortController();
    const emit = vi.fn();
    const handler = broker.createHandler("run-4", emit);
    const pending = handler({
      toolName: "bash",
      args: { command: "sleep 10" },
      reason: "Shell 命令",
      signal: controller.signal,
    });
    const approvalId = emit.mock.calls[0]![0].approvalId as string;

    controller.abort();

    await expect(pending).resolves.toBe(false);
    expect(broker.resolve(approvalId, true)).toBe(false);
  });

  it("does not strand an approval when cancellation occurs during notification", async () => {
    const broker = new ToolApprovalBroker();
    const handler = broker.createHandler("run-5", () => {
      broker.cancelForRun("run-5");
    });

    await expect(
      handler({
        toolName: "bash",
        args: { command: "echo hi" },
        reason: "Shell 命令",
      }),
    ).resolves.toBe(false);
  });

  it("releases cancelled run state when the run lifecycle finishes", async () => {
    const broker = new ToolApprovalBroker();
    const firstHandler = broker.createHandler("run-reused", () => {});
    broker.cancelForRun("run-reused");
    await expect(
      firstHandler({
        toolName: "bash",
        args: { command: "echo first" },
        reason: "Shell 命令",
      }),
    ).resolves.toBe(false);

    broker.finishForRun("run-reused");

    const emit = vi.fn();
    const nextHandler = broker.createHandler("run-reused", emit);
    const pending = nextHandler({
      toolName: "bash",
      args: { command: "echo next" },
      reason: "Shell 命令",
    });
    const approvalId = emit.mock.calls[0]![0].approvalId as string;
    expect(broker.resolve(approvalId, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
  });
});
