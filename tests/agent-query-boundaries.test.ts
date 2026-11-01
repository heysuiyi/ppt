import { describe, expect, it } from "vitest";
import { AgentQueryAssembler } from "../app/main/agent/runtime/query/agent-query-assembler";
import {
  createInitialQueryState,
  createIterationWorkspace,
  reduceQueryState,
} from "../app/main/agent/runtime/query/query-types";
import { normalizeAgentRuntimeOptions } from "../app/main/agent/runtime/runtime-types";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";
import { asQueryId } from "../src/shared/presentation-lifecycle";

function context() {
  return {
    presentation: createStarterPresentation(),
    selectedElementIds: [],
    discoverySession: { discoveredToolNames: new Set<string>() },
    registry: { get: () => undefined } as never,
    messageHistory: [],
  };
}

describe("agent query lifecycle boundaries", () => {
  it("normalizes public string identities and defaults a new query at the runtime boundary", () => {
    expect(
      normalizeAgentRuntimeOptions({
        threadId: "thread",
        request: "start",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
      }),
    ).toMatchObject({
      threadId: "thread",
      startMode: { type: "new_query" },
    });
  });

  it("assembles stable params once and creates an independent committed state", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hello" }],
      },
    ];
    const params = new AgentQueryAssembler().assemble({
      queryId: asQueryId("query-stable"),
      options: normalizeAgentRuntimeOptions({
        threadId: "thread",
        runId: "run",
        request: "hello",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        fallbackModel: { provider: "anthropic", model: "fallback" },
        userContext: { locale: "zh-CN" },
        systemContext: { surface: "desktop" },
        maxOutputTokensOverride: 12_345,
      }),
      messages,
      systemPrompt: "system",
      toolUseContext: context(),
      maxTurns: 8,
      deps: { marker: "deps" },
    });
    const state = createInitialQueryState(params);

    messages[0]!.content[0]!.text = "mutated outside";
    expect(params.messages[0]!.content).toEqual([{ type: "text", text: "hello" }]);
    expect(state.messages).not.toBe(params.messages);
    expect(state.turnCount).toBe(0);
    expect(params.querySource).toBe("user");
    expect(params.queryId).toBe("query-stable");
    expect(params.queryId).not.toBe(params.systemContext.threadId);
    expect(params.queryId).not.toBe(params.systemContext.runId);
    expect(params.fallbackModel).toEqual({ provider: "anthropic", model: "fallback" });
    expect(params.userContext).toEqual({ locale: "zh-CN" });
    expect(params.systemContext).toMatchObject({
      surface: "desktop",
      threadId: "thread",
      runId: "run",
    });
    expect(state.maxOutputTokensOverride).toBe(12_345);
  });

  it("commits a complete multi-tool batch in one user result message", () => {
    const params = new AgentQueryAssembler().assemble({
      queryId: asQueryId("query-multi-tool"),
      options: normalizeAgentRuntimeOptions({
        threadId: "thread",
        request: "inspect",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
      }),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "inspect" }],
        },
      ],
      systemPrompt: "system",
      toolUseContext: context(),
      maxTurns: 8,
      deps: {},
    });
    const state = createInitialQueryState(params);
    const workspace = createIterationWorkspace(state);
    workspace.assistantMessages.push({
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "ReadA", input: {} },
        { type: "tool_use", id: "b", name: "ReadB", input: {} },
      ],
    });
    workspace.toolUseBlocks.push(
      { type: "tool_use", id: "a", name: "ReadA", input: {} },
      { type: "tool_use", id: "b", name: "ReadB", input: {} },
    );
    workspace.toolResults.push(
      { type: "tool_result", toolUseId: "a", content: [{ type: "text", text: "A" }] },
      { type: "tool_result", toolUseId: "b", content: [{ type: "text", text: "B" }] },
    );
    workspace.validationFailuresByTool.set("ReadA", 2);
    workspace.maxOutputTokensRecoveryCount = 1;

    const next = reduceQueryState(state, workspace);

    expect(state.messages).toHaveLength(1);
    expect(next.messages).toHaveLength(3);
    expect(next.messages[2]).toEqual({
      role: "user",
      content: workspace.toolResults,
    });
    expect(next.turnCount).toBe(1);
    expect(next.validationFailuresByTool.get("ReadA")).toBe(2);
    expect(next.maxOutputTokensRecoveryCount).toBe(1);
    expect(state.validationFailuresByTool.size).toBe(0);
  });

  it("rejects an incomplete batch before changing committed state", () => {
    const params = new AgentQueryAssembler().assemble({
      queryId: asQueryId("query-incomplete"),
      options: normalizeAgentRuntimeOptions({
        threadId: "thread",
        request: "inspect",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
      }),
      messages: [],
      systemPrompt: "system",
      toolUseContext: context(),
      maxTurns: 8,
      deps: {},
    });
    const state = createInitialQueryState(params);
    const workspace = createIterationWorkspace(state);
    workspace.toolUseBlocks.push({
      type: "tool_use",
      id: "missing",
      name: "Read",
      input: {},
    });

    expect(() => reduceQueryState(state, workspace)).toThrow("incomplete tool batch");
    expect(state.messages).toEqual([]);
  });
});
