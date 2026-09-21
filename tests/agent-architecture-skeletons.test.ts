import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { createPptToolRegistry } from "@main/plugins/ppt/tools";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentGatewayError,
  type AgentModelGateway,
  type AgentModelRequest,
} from "../src/main/agent/gateway";
import type { AgentModelContentBlock } from "../src/main/agent/gateway/types";
import { DurableServiceStore } from "../src/main/agent/persistence/durable-service-store";
import { assumptionsSchema } from "../src/main/agent/tools/assumptions-schema";
import { askUserTool } from "../src/main/agent/tools/core/ask-user";
import { executeExtraToolTool } from "../src/main/agent/tools/core/execute-extra-tool";
import { searchExtraToolsTool } from "../src/main/agent/tools/core/search-extra-tools";
import { toToolCard } from "../src/main/agent/tools/tool-card";
import type { ToolDefinition } from "../src/main/agent/tools/tool-definition";
import { ToolLoader } from "../src/main/agent/tools/tool-loader";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { DesignPolicy } from "../src/main/plugins/ppt/design/design-policy";
import { CommitGate } from "../src/main/plugins/ppt/gate/commit-gate";
import { RiskPolicy } from "../src/main/plugins/ppt/gate/risk-policy";
import { SystemPromptBuilder } from "../src/main/plugins/ppt/prompts/system-prompt";
import { AgentService } from "../src/main/plugins/ppt/service";
import { beginPptCapabilityTool } from "../src/main/plugins/ppt/tools/begin-ppt-capability";
import { getSelectionTool } from "../src/main/plugins/ppt/tools/get-selection";
import { listSlidesTool } from "../src/main/plugins/ppt/tools/list-slides";
import { previewSlideTool } from "../src/main/plugins/ppt/tools/preview-slide";
import { readCurrentSlideTool } from "../src/main/plugins/ppt/tools/read-current-slide";
import { readPresentationSnapshotTool } from "../src/main/plugins/ppt/tools/read-presentation-snapshot";
import { ContentAddressedBlobStore } from "../src/main/presentation-lifecycle/content-addressed-blob-store";
import { PresentationLifecycleOrchestrator } from "../src/main/presentation-lifecycle/presentation-lifecycle-orchestrator";
import { PresentationLifecycleRepository } from "../src/main/presentation-lifecycle/presentation-lifecycle-repository";
import { PresentationLifecycleToolBridge } from "../src/main/presentation-lifecycle/presentation-lifecycle-tool-bridge";
import type { AgentModelSelection } from "../src/shared/agent";
import { CommandBus } from "../src/shared/commands";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";
import { asProjectId } from "../src/shared/presentation-lifecycle";
import { createFakeCommandProposalTool } from "./fake-command-proposal-tool";

function createSequenceGateway(
  responses: Array<AgentModelContentBlock | Error>,
): AgentModelGateway & { requests: AgentModelRequest[] } {
  let index = 0;
  const requests: AgentModelRequest[] = [];
  return {
    requests,
    async queryModel(request) {
      requests.push(request);
      const value = responses[index++];
      if (value === undefined) throw new Error("Unexpected gateway call");
      if (value instanceof Error) throw value;
      return {
        provider: "openai",
        model: "test-model",
        content: [value],
      };
    },
    async *queryModelStream(request) {
      requests.push(request);
      const value = responses[index++];
      if (value === undefined) throw new Error("Unexpected gateway call");
      if (value instanceof Error) throw value;
      if (value.type === "text") yield { type: "text_delta" as const, text: value.text };
      yield { type: "complete" as const, content: [value] };
    },
  };
}

function modelToolCall(toolName: string, args: Record<string, unknown> = {}) {
  return {
    type: "tool_use" as const,
    id: crypto.randomUUID(),
    name: toolName,
    input: args,
  };
}

function modelMessage(content: string) {
  return { type: "text" as const, text: content };
}

function modelAskUser(content: string, missingFields?: string[]) {
  return modelToolCall("AskUser", { message: content, missingFields });
}

function createDeferredProbeTool(name: string): ToolDefinition<any, any> {
  return {
    name,
    description: `Deferred probe tool ${name} for discovery tests.`,
    category: "deferred",
    loadPolicy: "deferred",
    inputSchema: z.object({}),
    risk: "low",
    execute: async () => ({ ok: true, toolName: name }),
  };
}

const fakeSubmit = createFakeCommandProposalTool();

describe("Agent Architecture Skeletons & Types", () => {
  it("creates the production registry with Core tools and no Deferred surface", () => {
    const registry = createPptToolRegistry();
    expect(registry.get("ReadPresentationSnapshot")?.loadPolicy).toBe("core");
    expect(registry.get("Task")).toBeUndefined();
    expect(registry.get("TaskCreate")?.loadPolicy).toBe("core");
    expect(registry.get("TaskReviewApprove")?.loadPolicy).toBe("core");
    expect(registry.get("AutoLayoutSlide")).toBeUndefined();
    expect(registry.get("ExportPptx")).toBeUndefined();
    expect(registry.searchDeferredTools("ExportPptx")).toEqual([]);
    expect(registry.get("PreviewSlide")?.loadPolicy).toBe("core");
    expect(registry.get("ValidateDeckLayout")).toBeUndefined();
    expect(registry.get("ExecuteLayoutPlan")).toBeUndefined();
    expect(registry.get("SubmitCommands")).toBeUndefined();
    expect(registry.getCoreTools().length).toBeGreaterThan(0);
    expect(registry.getCoreTools().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["PreviewSvgPage", "SubmitSvgDeck", "PreviewSlide"]),
    );
    expect(registry.getDeferredTools()).toEqual([]);
  });

  it("ToolRegistry can register and retrieve tools by category", () => {
    const registry = new ToolRegistry();
    const deferredAlpha = createDeferredProbeTool("DeferredAlpha");
    const deferredBeta = createDeferredProbeTool("DeferredBeta");

    registry.register(askUserTool);
    registry.register(searchExtraToolsTool);
    registry.register(executeExtraToolTool);
    registry.register(fakeSubmit);
    registry.register(getSelectionTool);
    registry.register(listSlidesTool);
    registry.register(readCurrentSlideTool);
    registry.register(readPresentationSnapshotTool);
    registry.register(previewSlideTool);
    registry.register(deferredAlpha);
    registry.register(deferredBeta);

    expect(registry.get("AskUser")).toBe(askUserTool);
    expect(registry.getCoreTools()).toContain(askUserTool);
    expect(registry.getCoreTools()).toContain(previewSlideTool);
    expect(registry.getCoreTools()).toContain(fakeSubmit);
    expect(registry.getCoreTools()).not.toContain(deferredAlpha);
    expect(registry.getDeferredTools()).toContain(deferredAlpha);
    expect(registry.getDeferredTools()).not.toContain(previewSlideTool);
    expect(registry.getDeferredTools()).not.toContain(askUserTool);

    const results = registry.searchDeferredTools("DeferredAlpha");
    expect(results.map((r) => r.name)).toContain("DeferredAlpha");
    expect(
      registry.searchDeferredTools("select:DeferredAlpha DeferredBeta").map((r) => r.name),
    ).toEqual(expect.arrayContaining(["DeferredAlpha", "DeferredBeta"]));
  });

  it("toToolCard converts complete tool definitions to model-visible summaries", () => {
    const card = toToolCard(askUserTool);
    expect(card.name).toBe("AskUser");
    expect(card.risk).toBe("low");
    expect(card.parameterSummary).toHaveProperty("message");
  });

  it("ToolLoader classifies tools correctly", () => {
    const deferredAlpha = createDeferredProbeTool("DeferredAlpha");
    const allTools = [askUserTool, deferredAlpha];
    const core = ToolLoader.loadCoreTools(allTools);
    const deferred = ToolLoader.loadDeferredTools(allTools);

    expect(core).toContain(askUserTool);
    expect(core).not.toContain(deferredAlpha);
    expect(deferred).toContain(deferredAlpha);
    expect(deferred).not.toContain(askUserTool);
  });

  it("SystemPromptBuilder builds prompt containing core tools description", () => {
    const prompt = SystemPromptBuilder.build({
      request: "你好",
      presentation: createStarterPresentation(),
      coreTools: [askUserTool],
      currentSlideId: "slide-123",
    });

    expect(prompt).toContain("AskUser");
    expect(prompt).toContain("不要询问工具名");
    expect(prompt).toContain("参数彼此独立的工具调用应在同一个 assistant 响应中一次发出");
    expect(prompt).toContain("execution.batch=exclusive");
  });

  it("AgentRuntime executes a Gateway-driven Core Tool loop", async () => {
    const registry = new ToolRegistry();
    registry.register(readPresentationSnapshotTool);
    registry.register(fakeSubmit);
    const runtime = createPptRuntime(
      registry,
      createSequenceGateway([
        modelToolCall("ReadPresentationSnapshot"),
        modelToolCall("FakeSubmitCommands", {
          summary: "Update title",
          commands: [{ id: "cmd-runtime", type: "set-presentation-title", title: "Runtime title" }],
          risk: "low",
          assumptions: ["Only the title changes"],
        }),
      ]),
    );
    const presentation = createStarterPresentation();

    const result = await runtime.run({
      threadId: "test-thread",
      request: "Create title",
      presentationSnapshot: presentation,
      selectedElementIds: [],
    });

    expect(result.type).toBe("command_proposal");
    if (result.type === "command_proposal") {
      expect(result.commands.length).toBeGreaterThan(0);
      expect(result.commands[0].type).toBe("set-presentation-title");
      expect(result.assumptions).toEqual(["Only the title changes"]);
    }
  });

  it("does not let an action continuation end with a narrative message", async () => {
    const registry = new ToolRegistry();
    registry.register(searchExtraToolsTool);
    registry.register(fakeSubmit);
    const runtime = createPptRuntime(
      registry,
      createSequenceGateway([
        modelToolCall("SearchExtraTools", { query: "theme layout" }),
        modelMessage("我先搜索一下高级工具，然后再开始生成。"),
        modelToolCall("FakeSubmitCommands", {
          summary: "Create the presentation",
          commands: [
            { id: "cmd-action-continuation", type: "set-presentation-title", title: "Vibe Coding" },
          ],
          risk: "low",
        }),
      ]),
    );

    const result = await runtime.run({
      threadId: "test-action-continuation",
      request: "按默认方案",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      messageHistory: [
        { role: "user", content: "生成 30 页 Vibe Coding 分享 PPT" },
        { role: "assistant", content: "请确认语言、时长和代码示例。" },
      ],
      requiredOutcome: "command_proposal",
    });

    expect(result.type).toBe("command_proposal");
  });

  it("keeps AskUser context but refuses an ephemeral proposal after continuation", async () => {
    const registry = new ToolRegistry();
    registry.register(askUserTool);
    registry.register(searchExtraToolsTool);
    registry.register(fakeSubmit);
    const runtime = createPptRuntime(
      registry,
      createSequenceGateway([
        modelToolCall("AskUser", {
          message: "请确认语言、时长和代码示例。",
          missingFields: ["language", "duration", "codeExamples"],
          responseUi: {
            variant: "cards",
            options: [
              { id: "default", title: "按默认方案", value: "按默认方案" },
              { id: "custom", title: "我补充细节", value: "我需要补充细节" },
            ],
          },
        }),
        modelToolCall("SearchExtraTools", { query: "theme layout" }),
        modelToolCall("FakeSubmitCommands", {
          summary: "Create the Vibe Coding presentation",
          commands: [
            { id: "cmd-service-context", type: "set-presentation-title", title: "Vibe Coding" },
          ],
          risk: "low",
          assumptions: ["中文为主，关键术语保留英文"],
        }),
      ]),
    );
    const service = new AgentService(
      new CommandBus(createStarterPresentation()),
      runtime,
      new CommitGate(new RiskPolicy()),
    );

    const clarification = await service.start("生成 30 页 Vibe Coding 技术分享 PPT");
    expect(clarification.status).toBe("waiting-user");
    if (clarification.status !== "waiting-user") throw new Error("Expected clarification");
    expect(clarification.question?.variant).toBe("cards");
    expect(clarification.question?.options?.map((option) => option.id)).toEqual([
      "default",
      "custom",
    ]);

    await expect(service.continueAgentRun(clarification.threadId!, "按默认方案")).rejects.toThrow(
      "Presentation proposals require the durable lifecycle repository",
    );
  });

  it("uses the current model selection when continuing a restored conversation", async () => {
    let usedSelection: AgentModelSelection | undefined;
    const gateway: AgentModelGateway = {
      async queryModel(_request, selection) {
        usedSelection = selection;
        return {
          provider: "anthropic",
          model: selection?.model ?? "missing-model",
          content: [modelMessage("Inbox processed.")],
        };
      },
      async *queryModelStream(_request, selection) {
        usedSelection = selection;
        yield { type: "complete" as const, content: [modelMessage("Inbox processed.")] };
      },
    };
    const service = new AgentService(
      new CommandBus(createStarterPresentation()),
      createPptRuntime(createPptToolRegistry(), gateway),
      new CommitGate(new RiskPolicy()),
    );
    const threadId = "restored-model-selection";
    service.restoreAgentRunConversation(threadId, [
      { role: "user", content: "智能自动排版" },
      { role: "assistant", content: "已成功应用变更方案。" },
    ]);
    const selectedModel: AgentModelSelection = {
      provider: "anthropic",
      model: "deepseek-v4-flash",
    };

    const result = await service.continueAgentRun(
      threadId,
      "[Inbox poller] process lead inbox",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      selectedModel,
    );

    expect(result).toEqual({ status: "chat", message: "Inbox processed." });
    expect(usedSelection).toEqual(selectedModel);
  });

  it("keeps a failed continuation request in the next runtime context", async () => {
    const requests: AgentModelRequest[] = [];
    const gateway: AgentModelGateway = {
      async queryModel(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            provider: "openai",
            model: "test-model",
            content: [modelAskUser("请补充具体主题。", ["topic"])],
          };
        }
        if (requests.length === 2) {
          throw new AgentGatewayError("Provider request timed out", "timeout", "openai");
        }
        return {
          provider: "openai",
          model: "test-model",
          content: [modelAskUser("上一条是 Agent 范式与架构演进。", ["confirmation"])],
        };
      },
      async *queryModelStream() {
        yield { type: "complete" as const, content: [] };
      },
    };
    const service = new AgentService(
      new CommandBus(createStarterPresentation()),
      createPptRuntime(createPptToolRegistry(), gateway),
      new CommitGate(new RiskPolicy()),
    );

    const first = await service.start("帮我做一份 PPT");
    expect(first.status).toBe("waiting-user");
    if (first.status !== "waiting-user") throw new Error("Expected clarification");

    const failed = await service.continueAgentRun(
      first.threadId!,
      "Agent 范式与架构演进：从 ReAct / Plan / Workflow 看智能体设计",
    );
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect(failed.error).toContain("Provider request timed out");
      expect(failed.threadId).toBe(first.threadId);
    }

    await service.continueAgentRun(first.threadId!, "我刚才说了什么？");

    const textContent = requests[2]!
      .messages!.flatMap((message) => message.content)
      .filter((block) => block.type === "text")
      .map((block) => block.text);
    expect(textContent).toEqual(
      expect.arrayContaining([
        "帮我做一份 PPT",
        "Agent 范式与架构演进：从 ReAct / Plan / Workflow 看智能体设计",
        "我刚才说了什么？",
      ]),
    );
    expect(JSON.parse(requests[2]!.prompt)).not.toHaveProperty("conversation");
    expect(JSON.parse(requests[2]!.prompt)).not.toHaveProperty("request");
  });

  it("passes restored chat history into a normal start request", async () => {
    let modelRequest: AgentModelRequest | undefined;
    const service = new AgentService(
      new CommandBus(createStarterPresentation()),
      createPptRuntime(createPptToolRegistry(), {
        async queryModel(request) {
          modelRequest = request;
          return {
            provider: "openai",
            model: "test-model",
            content: [modelMessage("你刚才说的是 Agent 范式与架构演进。")],
          };
        },
        async *queryModelStream() {
          yield { type: "complete" as const, content: [] };
        },
      }),
      new CommitGate(new RiskPolicy()),
    );

    const result = await service.start(
      "我刚才说了什么？",
      undefined,
      "REQUEST_APPROVAL",
      undefined,
      undefined,
      [{ role: "user", content: "Agent 范式与架构演进：从 ReAct / Plan / Workflow 看智能体设计" }],
    );

    expect(result.status).toBe("chat");
    expect(modelRequest?.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Agent 范式与架构演进：从 ReAct / Plan / Workflow 看智能体设计",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "我刚才说了什么？" }],
      },
    ]);
    expect(JSON.parse(modelRequest!.prompt)).not.toHaveProperty("conversation");
    expect(JSON.parse(modelRequest!.prompt)).not.toHaveProperty("request");
  });

  it("requires Deferred Tools to be discovered in the same session before execution", async () => {
    const registry = new ToolRegistry();
    const deferredProbe = createDeferredProbeTool("DeferredProbe");
    registry.register(searchExtraToolsTool);
    registry.register(executeExtraToolTool);
    registry.register(deferredProbe);
    const context = {
      presentation: createStarterPresentation(),
      selectedElementIds: [],
      discoverySession: { discoveredToolNames: new Set<string>() },
      registry,
      messageHistory: [],
    };

    await expect(
      executeExtraToolTool.execute(
        {
          toolName: "DeferredProbe",
          toolArgs: {},
        },
        context,
      ),
    ).rejects.toThrow("has not been discovered");

    const search = await searchExtraToolsTool.execute({ query: "DeferredProbe" }, context);
    expect(search.tools.map((tool) => tool.name)).toContain("DeferredProbe");
    const emptySearch = await searchExtraToolsTool.execute(
      { query: "create-new-slide-tool" },
      context,
    );
    expect(emptySearch.tools).toEqual([]);
    expect(emptySearch.baseEditingAvailable).toBe(false);
    expect(emptySearch.guidance).toContain("No command-proposal capability");
    const execution = await executeExtraToolTool.execute(
      {
        toolName: "DeferredProbe",
        toolArgs: {},
      },
      context,
    );
    expect(execution.toolName).toBe("DeferredProbe");
  });

  it("CommitGate and RiskPolicy correctly filter and validate commands", async () => {
    const riskPolicy = new RiskPolicy();
    const gate = new CommitGate(riskPolicy);
    const presentation = createStarterPresentation();

    const result1 = await gate.evaluate(
      presentation,
      [{ id: "cmd-1", type: "set-presentation-title", title: "Title A" }],
      "low",
    );

    expect(result1.success).toBe(true);
    expect(result1.diff).toBeDefined();
    expect(result1.diff?.titleChanged).toBe(true);
    expect(result1.risk).toBe("low");
    expect(result1.decision).toBe("AUTO");

    const result2 = await gate.evaluate(
      presentation,
      [{ id: "cmd-2", type: "remove-slide", slideId: presentation.slides[0].id }],
      "low",
    );

    expect(result2.success).toBe(true);
    expect(result2.risk).toBe("high");
    expect(result2.decision).toBe("REQUIRES_APPROVAL");

    const result3 = await gate.evaluate(
      presentation,
      [{ id: "cmd-3", type: "invalid-type" } as any],
      "low",
    );

    expect(result3.success).toBe(false);
    expect(result3.errors.length).toBeGreaterThan(0);
  });

  it("DesignPolicy passes through without element-IR constraints", () => {
    const policy = new DesignPolicy();
    const before = createStarterPresentation();
    const after = structuredClone(before);
    after.slides[0].title = "Updated SVG slide title";

    expect(policy.validate(before, after).valid).toBe(true);
    expect(before.slides[0].visualSource.kind).toBe("svg");
    expect(after.slides[0].visualSource.kind).toBe("svg");
  });

  it("does not create an in-memory REQUEST_APPROVAL fallback", async () => {
    const registry = new ToolRegistry();
    registry.register(askUserTool);
    registry.register(fakeSubmit);

    const runtime = createPptRuntime(
      registry,
      createSequenceGateway([
        modelToolCall("FakeSubmitCommands", {
          summary: "Update title",
          commands: [
            { id: "cmd-service", type: "set-presentation-title", title: "Approved title" },
          ],
          risk: "low",
        }),
      ]),
    );
    const riskPolicy = new RiskPolicy();
    const commitGate = new CommitGate(riskPolicy);
    const presentation = createStarterPresentation();
    const bus = new CommandBus(presentation);

    const service = new AgentService(bus, runtime, commitGate);
    await expect(
      service.start("Make a title presentation", undefined, "REQUEST_APPROVAL"),
    ).rejects.toThrow("Presentation proposals require the durable lifecycle repository");
    expect(bus.getSnapshot()).toEqual(presentation);
  });

  it("does not auto-apply a proposal without durable lifecycle services", async () => {
    const registry = new ToolRegistry();
    registry.register(fakeSubmit);
    const runtime = createPptRuntime(
      registry,
      createSequenceGateway([
        modelToolCall("FakeSubmitCommands", {
          summary: "Update title",
          commands: [{ id: "cmd-auto", type: "set-presentation-title", title: "Auto title" }],
          risk: "low",
        }),
      ]),
    );
    const bus = new CommandBus(createStarterPresentation());
    const service = new AgentService(bus, runtime, new CommitGate(new RiskPolicy()));
    const before = bus.getSnapshot();
    await expect(service.start("Update title", undefined, "AUTO")).rejects.toThrow(
      "Presentation proposals require the durable lifecycle repository",
    );
    expect(bus.getSnapshot()).toEqual(before);
  });

  it("keeps a continued AUTO request fail-closed without lifecycle services", async () => {
    const registry = new ToolRegistry();
    registry.register(fakeSubmit);
    const runtime = createPptRuntime(
      registry,
      createSequenceGateway([
        modelToolCall("FakeSubmitCommands", {
          summary: "Update title",
          commands: [
            {
              id: "cmd-auto-continued",
              type: "set-presentation-title",
              title: "Continued auto title",
            },
          ],
          risk: "low",
        }),
      ]),
    );
    const bus = new CommandBus(createStarterPresentation());
    const service = new AgentService(bus, runtime, new CommitGate(new RiskPolicy()));
    const threadId = "execution-strategy-override";
    service.restoreAgentRunConversation(threadId, [
      { role: "user", content: "先准备演示文档" },
      { role: "assistant", content: "准备好了。" },
    ]);

    const before = bus.getSnapshot();
    await expect(
      service.continueAgentRun(
        threadId,
        "更新标题",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "AUTO",
      ),
    ).rejects.toThrow("Presentation proposals require the durable lifecycle repository");
    expect(bus.getSnapshot()).toEqual(before);
  });

  it("rejects an approved proposal when the presentation changed after preview", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-stale-approval-"));
    const repository = new PresentationLifecycleRepository(join(workspaceRoot, "lifecycle.sqlite"));
    const lifecycle = new PresentationLifecycleOrchestrator(repository);
    const blobStore = new ContentAddressedBlobStore(join(workspaceRoot, "blobs"));
    const projectId = asProjectId("stale-approval-project");
    const presentation = createStarterPresentation();
    const registry = new ToolRegistry();
    registry.register(beginPptCapabilityTool);
    registry.register(fakeSubmit);
    const runtime = createPptRuntime(
      registry,
      createSequenceGateway([
        modelToolCall("BeginPptCapability", {
          capability: "edit",
          instruction: "Update title",
        }),
        modelToolCall("FakeSubmitCommands", {
          summary: "Update title",
          commands: [{ id: "cmd-stale", type: "set-presentation-title", title: "Stale title" }],
          risk: "low",
        }),
      ]),
      undefined,
      undefined,
      ({ queryId, options }) =>
        new PresentationLifecycleToolBridge(
          lifecycle,
          projectId,
          presentation.id,
          queryId,
          options.request,
          blobStore,
        ),
    );
    const bus = new CommandBus(presentation);
    const service = new AgentService(
      bus,
      runtime,
      new CommitGate(new RiskPolicy()),
      workspaceRoot,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lifecycle,
      undefined,
      blobStore,
    );
    try {
      const result = await service.start("Update title", undefined, "REQUEST_APPROVAL");
      if (result.status !== "approval-required") throw new Error("Expected approval");
      bus.execute({ id: "external-change", type: "set-presentation-title", title: "Newer title" });

      await expect(service.resumeProposal(result.approval.proposalId, true)).rejects.toThrow(
        "changed after preview",
      );
      expect(bus.getSnapshot().title).toBe("Newer title");
      const durableState = await new DurableServiceStore(workspaceRoot).load(
        result.approval.threadId,
      );
      expect(durableState?.status).toBe("completed");
      expect(durableState).not.toHaveProperty("pendingApproval");
    } finally {
      repository.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("coerces string assumptions to array", () => {
    expect(assumptionsSchema.parse("仅排版，不改文案")).toEqual(["仅排版，不改文案"]);
    expect(
      fakeSubmit.inputSchema.parse({
        summary: "Apply theme and layouts",
        commands: [{ id: "cmd-1", type: "set-presentation-title", title: "Assumptions" }],
        assumptions: "仅排版，不改文案",
      }).assumptions,
    ).toEqual(["仅排版，不改文案"]);
  });

  it("aborts production AgentService execution immediately when aborted signal is passed", async () => {
    const bus = new CommandBus(createStarterPresentation());
    const mockRuntime = {
      run: vi.fn(),
      clearSession: vi.fn(),
    } as any;
    const service = new AgentService(bus, mockRuntime, new CommitGate(new RiskPolicy()));
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.start("Hello", undefined, "AUTO", undefined, undefined, [], controller.signal),
    ).resolves.toEqual({ status: "interrupted" });
    expect(mockRuntime.run).not.toHaveBeenCalled();
  });
});
