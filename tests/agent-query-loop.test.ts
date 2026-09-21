import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  AgentModelContentBlock,
  AgentModelGateway,
  AgentModelRequest,
} from "../src/main/agent/gateway/types";
import { DurableRunStore } from "../src/main/agent/persistence/durable-run-store";
import type { AgentQueryLoopEvent } from "../src/main/agent/runtime/query/query-types";
import {
  type AgentCommandProposalResult,
  agentCommandProposalResultSchema,
} from "../src/main/agent/runtime/runtime-types";
import { askUserTool } from "../src/main/agent/tools/core/ask-user";
import { executeExtraToolTool } from "../src/main/agent/tools/core/execute-extra-tool";
import { searchExtraToolsTool } from "../src/main/agent/tools/core/search-extra-tools";
import type { ToolDefinition } from "../src/main/agent/tools/tool-definition";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";
import { createFakeCommandProposalTool } from "./fake-command-proposal-tool";

function gatewayFor(turns: AgentModelContentBlock[][]): AgentModelGateway & {
  requests: AgentModelRequest[];
} {
  const requests: AgentModelRequest[] = [];
  let index = 0;
  return {
    requests,
    async queryModel(request) {
      requests.push(request);
      const content = turns[index++];
      if (!content) throw new Error("Unexpected gateway call");
      return { provider: "openai", model: "test", content };
    },
    async *queryModelStream(request) {
      const response = await this.queryModel(request);
      yield { type: "complete" as const, content: response.content };
    },
  };
}

function countingTool(onExecute: () => void): ToolDefinition<any, any> {
  return {
    name: "CountingTool",
    description: "Counts executions.",
    category: "core",
    loadPolicy: "core",
    inputSchema: z.object({ value: z.number() }),
    outputSchema: z.object({ ok: z.literal(true) }),
    risk: "low",
    async execute() {
      onExecute();
      return { ok: true };
    },
  };
}

describe("agent query loop batches", () => {
  it("emits semantic query events without exposing loop control to observers", async () => {
    const events: AgentQueryLoopEvent[] = [];
    const gateway = gatewayFor([[{ type: "text", text: "done" }]]);

    const result = await createPptRuntime(new ToolRegistry(), gateway).run({
      threadId: "query-events",
      request: "inspect",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      onQueryEvent(event) {
        events.push(event);
        if (event.type === "model_turn_completed") {
          throw new Error("observers cannot stop the query");
        }
      },
    });

    expect(result).toEqual({ type: "message", content: "done" });
    expect(events.map((event) => event.type)).toEqual([
      "query_started",
      "model_turn_completed",
      "state_committed",
      "query_completed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "query_completed",
      resultType: "message",
    });
  });

  it("emits a query_failed observation before propagating execution errors", async () => {
    const events: AgentQueryLoopEvent[] = [];
    const gateway: AgentModelGateway = {
      async queryModel() {
        throw new Error("provider unavailable");
      },
      async *queryModelStream() {
        throw new Error("provider unavailable");
      },
    };

    await expect(
      createPptRuntime(new ToolRegistry(), gateway).run({
        threadId: "query-failed-events",
        request: "inspect",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        onQueryEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow("provider unavailable");

    expect(events.map((event) => event.type)).toEqual(["query_started", "query_failed"]);
    expect(events.at(-1)).toMatchObject({
      type: "query_failed",
      error: "provider unavailable",
    });
  });

  it("passes stable query context and output-token policy to the gateway", async () => {
    const gateway = gatewayFor([[{ type: "text", text: "done" }]]);

    await createPptRuntime(new ToolRegistry(), gateway).run({
      threadId: "query-policy",
      runId: "query-policy-run",
      request: "inspect",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      userContext: { locale: "zh-CN" },
      systemContext: { surface: "desktop" },
      maxOutputTokensOverride: 12_345,
    });

    expect(gateway.requests[0]?.maxOutputTokens).toBe(12_345);
    expect(JSON.parse(gateway.requests[0]!.prompt)).toEqual({
      transcript: [],
      queryContext: {
        source: "user",
        user: { locale: "zh-CN" },
        system: {
          surface: "desktop",
          threadId: "query-policy",
          runId: "query-policy-run",
        },
      },
    });
  });

  it("rejects a mixed terminal batch as one complete error result turn", async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(askUserTool);
    registry.register(
      countingTool(() => {
        executions += 1;
      }),
    );
    const gateway = gatewayFor([
      [
        {
          type: "tool_use",
          id: "ask",
          name: "AskUser",
          input: { message: "clarify" },
        },
        {
          type: "tool_use",
          id: "count",
          name: "CountingTool",
          input: { value: 1 },
        },
      ],
      [{ type: "text", text: "retried with a valid batch" }],
    ]);

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "mixed-terminal-batch",
      request: "run",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    expect(result).toEqual({ type: "message", content: "retried with a valid batch" });
    expect(executions).toBe(0);
    const resultTurns = gateway.requests[1]!.messages!.filter(
      (message) =>
        message.role === "user" && message.content.some((block) => block.type === "tool_result"),
    );
    expect(resultTurns).toHaveLength(1);
    expect(resultTurns[0]!.content).toEqual([
      expect.objectContaining({ type: "tool_result", toolUseId: "ask", isError: true }),
      expect.objectContaining({ type: "tool_result", toolUseId: "count", isError: true }),
    ]);
  });

  it("isolates an exclusive terminal tool before execution and pairs every mixed tool_use", async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(createFakeCommandProposalTool());
    registry.register(
      countingTool(() => {
        executions += 1;
      }),
    );
    const gateway = gatewayFor([
      [
        {
          type: "tool_use",
          id: "layout",
          name: "FakeSubmitCommands",
          input: {
            summary: "terminal",
            risk: "low",
            commands: [{ id: "cmd-1", type: "set-presentation-title", title: "X" }],
          },
        },
        {
          type: "tool_use",
          id: "count",
          name: "CountingTool",
          input: { value: 1 },
        },
      ],
      [{ type: "text", text: "retried separately" }],
    ]);

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "mixed-layout-terminal-batch",
      request: "execute the layout plan",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    expect(result).toEqual({ type: "message", content: "retried separately" });
    expect(executions).toBe(0);
    const pairedResults = gateway.requests[1]!.messages!.filter(
      (message) => message.role === "user",
    )
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result");
    expect(pairedResults).toEqual([
      expect.objectContaining({ toolUseId: "layout", isError: true }),
      expect.objectContaining({ toolUseId: "count", isError: true }),
    ]);
  });

  it("fail-closes unresolved delegation before a sibling can reveal a terminal target", async () => {
    let terminalExecutions = 0;
    let ordinaryExecutions = 0;
    const terminalSchema = z.object({});
    const terminalDeferred: ToolDefinition<typeof terminalSchema, AgentCommandProposalResult> = {
      name: "DeferredTerminal",
      description: "A dynamically discovered terminal capability.",
      category: "deferred",
      loadPolicy: "deferred",
      inputSchema: terminalSchema,
      outputSchema: agentCommandProposalResultSchema,
      behavior: {
        capabilities: ["command_proposal"],
        completion: {
          terminalResult: "command_proposal",
          expectation: "always",
          exclusiveBatch: true,
        },
      },
      risk: "low",
      async execute() {
        terminalExecutions += 1;
        return {
          type: "command_proposal",
          summary: "Deferred terminal result",
          commands: [],
          risk: "low",
        };
      },
    };
    const registry = new ToolRegistry();
    registry.register(searchExtraToolsTool);
    registry.register(executeExtraToolTool);
    registry.register(terminalDeferred);
    registry.register(
      countingTool(() => {
        ordinaryExecutions += 1;
      }),
    );
    const gateway = gatewayFor([
      [
        {
          type: "tool_use",
          id: "discover",
          name: "SearchExtraTools",
          input: { query: "select:DeferredTerminal" },
        },
        {
          type: "tool_use",
          id: "delegate",
          name: "ExecuteExtraTool",
          input: { toolName: "DeferredTerminal", toolArgs: {} },
        },
        {
          type: "tool_use",
          id: "ordinary",
          name: "CountingTool",
          input: { value: 1 },
        },
      ],
      [{ type: "text", text: "retried with isolated delegation" }],
    ]);

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "dynamic-delegation-terminal-batch",
      request: "discover and execute the optional terminal capability",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    expect(result).toEqual({
      type: "message",
      content: "retried with isolated delegation",
    });
    expect(terminalExecutions).toBe(0);
    expect(ordinaryExecutions).toBe(0);
    const pairedResults = gateway.requests[1]!.messages!.filter(
      (message) => message.role === "user",
    )
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_result");
    expect(pairedResults).toEqual([
      expect.objectContaining({ toolUseId: "discover", isError: true }),
      expect.objectContaining({ toolUseId: "delegate", isError: true }),
      expect.objectContaining({ toolUseId: "ordinary", isError: true }),
    ]);
  });

  it("uses definition metadata, not a magic tool name, to terminate with ask_user", async () => {
    const schema = z.object({ question: z.string() });
    const resultSchema = z.object({
      type: z.literal("ask_user"),
      content: z.string(),
    });
    const renamedTerminalTool: ToolDefinition<typeof schema, z.infer<typeof resultSchema>> = {
      name: "RequestMissingDecision",
      description: "Request a missing user decision.",
      category: "core",
      loadPolicy: "core",
      inputSchema: schema,
      outputSchema: resultSchema,
      behavior: {
        capabilities: ["user_interaction"],
        completion: {
          terminalResult: "ask_user",
          expectation: "always",
          exclusiveBatch: true,
        },
      },
      risk: "low",
      async execute(args) {
        return { type: "ask_user", content: args.question };
      },
    };
    const registry = new ToolRegistry();
    registry.register(renamedTerminalTool);
    const gateway = gatewayFor([
      [
        {
          type: "tool_use",
          id: "renamed-terminal",
          name: renamedTerminalTool.name,
          input: { question: "Which audience should I target?" },
        },
      ],
    ]);

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "metadata-terminal-tool",
      request: "ask for the audience",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    expect(result).toEqual({
      type: "ask_user",
      content: "Which audience should I target?",
    });
  });

  it("derives required-outcome guidance from registered capability metadata", async () => {
    const schema = z.object({});
    const renamedProposalTool: ToolDefinition<typeof schema, AgentCommandProposalResult> = {
      name: "CompletePresentationAction",
      description: "Complete a presentation action.",
      category: "core",
      loadPolicy: "core",
      inputSchema: schema,
      outputSchema: agentCommandProposalResultSchema,
      behavior: {
        capabilities: ["command_proposal"],
        completion: {
          terminalResult: "command_proposal",
          expectation: "always",
          exclusiveBatch: true,
        },
      },
      risk: "low",
      async execute() {
        return {
          type: "command_proposal",
          summary: "Update title",
          commands: [
            {
              id: "metadata-title",
              type: "set-presentation-title",
              title: "Metadata-driven completion",
            },
          ],
          risk: "low",
        };
      },
    };
    const registry = new ToolRegistry();
    registry.register(renamedProposalTool);
    const gateway = gatewayFor([
      [{ type: "text", text: "I will do that later." }],
      [
        {
          type: "tool_use",
          id: "renamed-proposal",
          name: renamedProposalTool.name,
          input: {},
        },
      ],
    ]);

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "metadata-required-capability",
      request: "update title",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      requiredOutcome: "command_proposal",
    });

    expect(result.type).toBe("command_proposal");
    const followUp = gateway.requests[1]!.messages!.flatMap((message) =>
      message.role === "user" ? message.content : [],
    )
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(followUp).toContain(renamedProposalTool.name);
  });

  it("counts a complete multi-tool batch as one agentic turn", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-query-batch-"));
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(
      countingTool(() => {
        executions += 1;
      }),
    );
    const gateway = gatewayFor([
      [
        { type: "tool_use", id: "count-1", name: "CountingTool", input: { value: 1 } },
        { type: "tool_use", id: "count-2", name: "CountingTool", input: { value: 2 } },
      ],
    ]);

    const result = await createPptRuntime(registry, gateway).run({
      threadId: "batch-turn-limit",
      request: "run twice",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      maxSteps: 1,
      workspaceRoot,
    });

    expect(result.type).toBe("message");
    expect(executions).toBe(2);
    expect(gateway.requests).toHaveLength(1);
    const checkpoint = await new DurableRunStore(workspaceRoot).load("batch-turn-limit");
    expect(checkpoint).toMatchObject({
      version: 2,
      committedState: { turnCount: 1 },
    });
    expect(checkpoint?.version === 2 ? checkpoint.inflight : undefined).toBeUndefined();
  });

  it("checkpoints a completed tool result before committing the next State", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-tool-result-checkpoint-"));
    const checkpoints: Parameters<DurableRunStore["saveCas"]>[0]["checkpoint"][] = [];
    const originalSaveCas = DurableRunStore.prototype.saveCas;
    const saveSpy = vi
      .spyOn(DurableRunStore.prototype, "saveCas")
      .mockImplementation(async function (this: DurableRunStore, input) {
        checkpoints.push(structuredClone(input.checkpoint));
        return await originalSaveCas.call(this, input);
      });
    try {
      const registry = new ToolRegistry();
      registry.register(countingTool(() => undefined));
      const gateway = gatewayFor([
        [{ type: "tool_use", id: "durable-result", name: "CountingTool", input: { value: 1 } }],
        [{ type: "text", text: "done" }],
      ]);

      await createPptRuntime(registry, gateway).run({
        threadId: "durable-tool-result",
        request: "run once",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        workspaceRoot,
      });
    } finally {
      saveSpy.mockRestore();
    }

    expect(
      checkpoints.some(
        (checkpoint) =>
          checkpoint.version === 2 &&
          checkpoint.status === "running" &&
          checkpoint.inflight?.phase === "model_received" &&
          checkpoint.inflight.workspace.toolResults.some(
            (result) => result.toolUseId === "durable-result",
          ),
      ),
    ).toBe(true);
  });

  it("assembles canUseTool from the tools exposed to this query", async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({
      ...countingTool(() => {
        executions += 1;
      }),
      name: "DeferredCountingTool",
      category: "deferred",
      loadPolicy: "deferred",
    });
    const gateway = gatewayFor([
      [
        {
          type: "tool_use",
          id: "deferred-direct",
          name: "DeferredCountingTool",
          input: { value: 1 },
        },
      ],
      [{ type: "text", text: "used the available tool boundary" }],
    ]);

    await createPptRuntime(registry, gateway).run({
      threadId: "query-tool-boundary",
      request: "call a deferred tool directly",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
    });

    expect(executions).toBe(0);
    expect(gateway.requests[1]!.messages!.flatMap((message) => message.content)).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolUseId: "deferred-direct",
        isError: true,
        content: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("not permitted in this query"),
          }),
        ],
      }),
    );
  });
});
