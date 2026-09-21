import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { describe, expect, it } from "vitest";
import type { AgentModelGateway } from "../src/main/agent/gateway/types";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { CommitGate } from "../src/main/plugins/ppt/gate/commit-gate";
import { RiskPolicy } from "../src/main/plugins/ppt/gate/risk-policy";
import { AgentService } from "../src/main/plugins/ppt/service";
import { CommandBus } from "../src/shared/commands";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";

describe("AgentService thread run ownership", () => {
  it("rejects a concurrent run for the same thread before it reaches the Runtime", async () => {
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let markModelStarted!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    let modelCalls = 0;
    const gateway: AgentModelGateway = {
      async queryModel() {
        modelCalls += 1;
        markModelStarted();
        await modelGate;
        return {
          provider: "anthropic",
          model: "test",
          content: [{ type: "text", text: "done" }],
        };
      },
      async *queryModelStream() {
        throw new Error("streaming not expected");
      },
    };
    const service = new AgentService(
      new CommandBus(createStarterPresentation()),
      createPptRuntime(new ToolRegistry(), gateway),
      new CommitGate(new RiskPolicy()),
    );

    const first = service.start(
      "first",
      undefined,
      "REQUEST_APPROVAL",
      undefined,
      undefined,
      [],
      undefined,
      "shared-thread",
    );
    await modelStarted;

    await expect(
      service.start(
        "second",
        undefined,
        "REQUEST_APPROVAL",
        undefined,
        undefined,
        [],
        undefined,
        "shared-thread",
      ),
    ).rejects.toThrow("already has an active run");

    expect(modelCalls).toBe(1);
    releaseModel();
    await expect(first).resolves.toMatchObject({ status: "chat", message: "done" });
  });
});
