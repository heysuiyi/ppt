import { describe, expect, it } from "vitest";
import { AgentSession } from "../app/main/agent/runtime/lifecycle/agent-session";

function createSession(): AgentSession {
  return new AgentSession({ transcript: [] });
}

describe("AgentSession terminal lifecycle", () => {
  it("allows an unsealed success candidate to be replaced by failure", () => {
    const session = createSession();
    session.apply({
      type: "run_terminal",
      status: "completed",
      result: { type: "message", content: "done" },
    });

    session.overrideTerminalCandidate({ status: "failed", error: "checkpoint failed" });

    expect(session.terminalState).toEqual({
      status: "failed",
      error: "checkpoint failed",
      sealed: false,
    });
  });

  it("rejects terminal replacement after the checkpoint seals it", () => {
    const session = createSession();
    session.apply({
      type: "run_terminal",
      status: "completed",
      result: { type: "message", content: "done" },
    });
    session.sealTerminal();

    expect(() => session.overrideTerminalCandidate({ status: "failed", error: "late" })).toThrow(
      "sealed",
    );
  });
});
