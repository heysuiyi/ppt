import { describe, expect, it } from "vitest";
import { CheckpointPolicy } from "../app/main/agent/runtime/lifecycle/checkpoint-policy";

describe("CheckpointPolicy", () => {
  const policy = new CheckpointPolicy();

  it("maps model and tool transitions to the legacy recovery boundaries", () => {
    expect(policy.afterTransition({ type: "model_input_prepared" })).toBe("commit");
    expect(
      policy.afterTransition({
        type: "model_response_received",
        content: [{ type: "text", text: "done" }],
        toolUses: [],
      }),
    ).toBe("none");
    expect(
      policy.afterTransition({
        type: "model_response_received",
        content: [],
        toolUses: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
      }),
    ).toBe("commit");
    expect(
      policy.afterTransition({
        type: "tool_claimed",
        toolUse: { type: "tool_use", id: "tool-1", name: "Read", input: {} },
      }),
    ).toBe("commit");
    expect(
      policy.afterTransition({
        type: "tool_processed",
        result: { type: "tool_result", toolUseId: "tool-1", content: [] },
      }),
    ).toBe("commit_before_next");
  });

  it("uses only terminal commit for direct terminal results", () => {
    expect(
      policy.afterTransition(
        {
          type: "tool_processed",
          result: { type: "tool_result", toolUseId: "tool-1", content: [] },
        },
        { toolResultTerminates: true },
      ),
    ).toBe("terminal");
    expect(policy.afterTransition({ type: "run_terminal", status: "completed" })).toBe("terminal");
  });
});
