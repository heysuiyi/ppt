import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const runtimeRoot = join(process.cwd(), "src", "main", "agent", "runtime");

async function source(file: string): Promise<string> {
  return await readFile(join(runtimeRoot, file), "utf8");
}

describe("AgentRuntime query-loop structure", () => {
  it("delegates orchestration to the observable query state machine", async () => {
    const runtime = await source("agent-runtime.ts");
    const query = await source("query/query.ts");

    expect(runtime).toContain("const iterator = query(run)");
    expect(runtime).toContain("safelyNotifyQueryEvent");
    expect(runtime).not.toContain("let state = run.initialState");
    expect(runtime).not.toContain("AgentLoopDriver");

    expect(query).toContain("export async function* query(");
    expect(query).toContain('type: "query_started"');
    expect(query).toContain('type: "query_completed"');
    const modelIndex = query.indexOf("driver.modelTurns.run(run, state, workspace)");
    const toolsIndex = query.indexOf("driver.toolTurns.runBatch", modelIndex);
    const stateIndex = query.indexOf("state = reduceQueryState(", toolsIndex);
    expect(modelIndex).toBeGreaterThan(-1);
    expect(toolsIndex).toBeGreaterThan(modelIndex);
    expect(stateIndex).toBeGreaterThan(toolsIndex);
  });

  it("keeps query messages and tool-batch state out of AgentSession", async () => {
    const collaborators = [
      "lifecycle/agent-run-scope.ts",
      "agent-run-finalizer.ts",
      "turns/prepared-agent-run.ts",
      "agent-run-factory.ts",
      "turns/model-turn-runner.ts",
      "turns/tool-turn-runner.ts",
      "agent-runtime.ts",
      "background/lead-inbox-input-source.ts",
      "lifecycle/agent-event-ports.ts",
    ];
    const combined = (await Promise.all(collaborators.map(source))).join("\n");
    const session = await source("lifecycle/agent-session.ts");

    expect(combined).not.toMatch(
      /session\.(?:modelMessages|queuedToolUses|pendingToolResults|validationFailuresByTool)/,
    );
    expect(session).not.toMatch(
      /modelMessagesValue|queuedToolUsesValue|pendingToolResultsValue|validationFailuresByToolValue/,
    );
  });

  it("keeps application-level Runtime options out of turn runners", async () => {
    const turns = await Promise.all([
      source("turns/model-turn-runner.ts"),
      source("turns/tool-turn-runner.ts"),
    ]);

    expect(turns.join("\n")).not.toMatch(
      /scope\.options|options\.(?:request|messageHistory|model|runtimeRoot|onStreamChunk)/,
    );
  });
});
