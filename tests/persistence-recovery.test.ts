import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { describe, expect, it } from "vitest";
import type {
  AgentModelContentBlock,
  AgentModelGateway,
  AgentModelRequest,
  AgentModelResponse,
} from "../src/main/agent/gateway/types";
import { DurableRunStore } from "../src/main/agent/persistence/durable-run-store";
import { asRunId, asThreadId } from "../src/main/agent/runtime/query/query-types";
import { MessageBus } from "../src/main/agent/teammate/message-bus";
import { askUserTool } from "../src/main/agent/tools/core/ask-user";
import { ToolRegistry } from "../src/main/agent/tools/tool-registry";
import { CommitGate } from "../src/main/plugins/ppt/gate/commit-gate";
import { RiskPolicy } from "../src/main/plugins/ppt/gate/risk-policy";
import { AgentService } from "../src/main/plugins/ppt/service";
import { beginPptCapabilityTool } from "../src/main/plugins/ppt/tools/begin-ppt-capability";
import { ContentAddressedBlobStore } from "../src/main/presentation-lifecycle/content-addressed-blob-store";
import { PresentationCommitService } from "../src/main/presentation-lifecycle/presentation-commit-service";
import { PresentationLifecycleOrchestrator } from "../src/main/presentation-lifecycle/presentation-lifecycle-orchestrator";
import { PresentationLifecycleRepository } from "../src/main/presentation-lifecycle/presentation-lifecycle-repository";
import { PresentationLifecycleToolBridge } from "../src/main/presentation-lifecycle/presentation-lifecycle-tool-bridge";
import { FileSessionStore } from "../src/main/session-store";
import { CommandBus } from "../src/shared/commands";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";
import {
  asPresentationId,
  asProjectId,
  asProposalId,
  asQueryId,
} from "../src/shared/presentation-lifecycle";
import { createFakeCommandProposalTool } from "./fake-command-proposal-tool";

function gatewayFor(turns: AgentModelContentBlock[][]): AgentModelGateway & {
  requests: AgentModelRequest[];
} {
  let index = 0;
  const requests: AgentModelRequest[] = [];
  return {
    requests,
    async queryModel(request): Promise<AgentModelResponse> {
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

describe("durable agent recovery", () => {
  it("keeps an ordinary completed chat Query out of the Presentation lifecycle", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-ordinary-chat-"));
    const repository = new PresentationLifecycleRepository(join(workspaceRoot, "lifecycle.sqlite"));
    const lifecycle = new PresentationLifecycleOrchestrator(repository);
    const presentation = createStarterPresentation();
    const runtime = createPptRuntime(
      new ToolRegistry(),
      gatewayFor([[{ type: "text", text: "这是普通问答。" }]]),
      undefined,
      undefined,
      ({ queryId, options }) =>
        new PresentationLifecycleToolBridge(
          lifecycle,
          asProjectId("ordinary-chat-project"),
          presentation.id,
          queryId,
          options.request,
        ),
    );
    const service = new AgentService(
      new CommandBus(presentation),
      runtime,
      new CommitGate(new RiskPolicy()),
      workspaceRoot,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lifecycle,
    );

    try {
      await expect(service.start("解释一下演示结构")).resolves.toEqual({
        status: "chat",
        message: "这是普通问答。",
      });
      expect(lifecycle.getState(asPresentationId(presentation.id))).toBeUndefined();
    } finally {
      repository.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("moves an active PPT Query ending in a message to waiting_user at its committed stage", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-ppt-message-"));
    const repository = new PresentationLifecycleRepository(join(workspaceRoot, "lifecycle.sqlite"));
    const lifecycle = new PresentationLifecycleOrchestrator(repository);
    const presentation = createStarterPresentation();
    const registry = new ToolRegistry();
    registry.register(beginPptCapabilityTool);
    const runtime = createPptRuntime(
      registry,
      gatewayFor([
        [
          {
            type: "tool_use",
            id: "begin-create",
            name: "BeginPptCapability",
            input: { capability: "create", instruction: "Create a deck" },
          },
        ],
        [{ type: "text", text: "我还需要用户补充素材。" }],
      ]),
      undefined,
      undefined,
      ({ queryId, options }) =>
        new PresentationLifecycleToolBridge(
          lifecycle,
          asProjectId("ppt-message-project"),
          presentation.id,
          queryId,
          options.request,
        ),
    );
    const service = new AgentService(
      new CommandBus(presentation),
      runtime,
      new CommitGate(new RiskPolicy()),
      workspaceRoot,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lifecycle,
    );

    try {
      await expect(service.start("创建演示文稿")).resolves.toEqual({
        status: "chat",
        message: "我还需要用户补充素材。",
      });
      expect(lifecycle.getState(asPresentationId(presentation.id))).toMatchObject({
        status: "waiting_user",
        currentStage: "intent",
        waitingReason: expect.stringContaining("Last committed stage: intent"),
      });
    } finally {
      repository.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("fails an active PptJob when CommitGate rejects a completed Query candidate", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-gate-rejection-"));
    const lifecyclePath = join(workspaceRoot, "lifecycle.sqlite");
    const repository = new PresentationLifecycleRepository(lifecyclePath);
    const lifecycle = new PresentationLifecycleOrchestrator(repository);
    const blobStore = new ContentAddressedBlobStore(join(workspaceRoot, "blobs"));
    const presentation = createStarterPresentation();
    const registry = new ToolRegistry();
    registry.register(beginPptCapabilityTool);
    registry.register(createFakeCommandProposalTool());
    const gateway = gatewayFor([
      [
        {
          type: "tool_use",
          id: "begin-edit",
          name: "BeginPptCapability",
          input: { capability: "edit", instruction: "Apply an invalid edit" },
        },
      ],
      [
        {
          type: "tool_use",
          id: "submit-invalid",
          name: "FakeSubmitCommands",
          input: {
            summary: "Remove a slide that does not exist",
            risk: "low",
            commands: [
              {
                id: "missing-slide",
                type: "remove-slide",
                slideId: "does-not-exist",
              },
            ],
          },
        },
      ],
    ]);
    const runtime = createPptRuntime(
      registry,
      gateway,
      undefined,
      undefined,
      ({ queryId, options }) =>
        new PresentationLifecycleToolBridge(
          lifecycle,
          asProjectId("gate-project"),
          presentation.id,
          queryId,
          options.request,
          blobStore,
          undefined,
          options.startMode.type === "resume_query",
        ),
    );
    const service = new AgentService(
      new CommandBus(presentation),
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
      await expect(
        service.start("Apply an invalid edit", undefined, "REQUEST_APPROVAL"),
      ).rejects.toThrow("Commit Gate rejected proposal");

      const job = lifecycle.getState(asPresentationId(presentation.id))!;
      expect(job.status).toBe("failed");
      const candidateAttempts = repository
        .listStageAttempts(job.jobId)
        .filter((attempt) => attempt.stage === "candidate");
      expect(candidateAttempts).toEqual([
        expect.objectContaining({
          status: "failed",
        }),
      ]);
      expect(candidateAttempts[0]).not.toHaveProperty("artifactRevisionId");
      expect(
        repository
          .listArtifactRevisions(job.jobId)
          .filter(
            (revision) =>
              revision.kind === "candidate_commands" || revision.kind === "candidate_deck",
          ),
      ).toHaveLength(0);
    } finally {
      repository.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("acks a replayed Inbox claim without exposing an already committed message twice", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-inbox-recovery-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    await bus.send({
      id: "already-committed",
      from: "worker",
      to: "lead",
      content: "should not replay",
    });
    await bus.claimInbox("lead");
    const now = new Date().toISOString();
    await new DurableRunStore(workspaceRoot).save({
      version: 1,
      threadId: "inbox-recovery",
      status: "running",
      phase: "before_model",
      request: "old request",
      baseRevision: 0,
      modelStep: 0,
      modelMessages: [{ role: "user", content: [{ type: "text", text: "old request" }] }],
      transcript: [{ role: "user", content: "old request" }],
      queuedToolUses: [],
      pendingToolResults: [],
      pendingUserContent: [],
      discoveredToolNames: [],
      loadedSkillNames: [],
      backgroundTasks: [],
      processedInboxMessageIds: ["already-committed"],
      createdAt: now,
      updatedAt: now,
    });
    const gateway = gatewayFor([[{ type: "text", text: "continued once" }]]);

    await createPptRuntime(new ToolRegistry(), gateway).run({
      threadId: "inbox-recovery",
      request: "continue",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
      startMode: { type: "resume_query", reason: "interrupted" },
      messageBus: bus,
    });

    expect(JSON.stringify(gateway.requests[0].messages)).not.toContain("should not replay");
    expect(await bus.claimInbox("lead")).toBeUndefined();
  });

  it("does not replay an interrupted tool with uncertain side effects", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-tool-recovery-"));
    const toolUse = {
      type: "tool_use" as const,
      id: "uncertain-tool",
      name: "ReadPresentationSnapshot",
      input: {},
    };
    const now = new Date().toISOString();
    await new DurableRunStore(workspaceRoot).save({
      version: 1,
      threadId: "interrupted-thread",
      status: "running",
      phase: "tool_running",
      request: "inspect",
      baseRevision: 0,
      modelStep: 1,
      modelMessages: [{ role: "assistant", content: [toolUse] }],
      transcript: [{ role: "user", content: "inspect" }],
      queuedToolUses: [],
      pendingToolResults: [],
      pendingUserContent: [],
      discoveredToolNames: [],
      loadedSkillNames: [],
      activeToolUse: toolUse,
      createdAt: now,
      updatedAt: now,
    });

    const registry = new ToolRegistry();
    const gateway = gatewayFor([[{ type: "text", text: "已先对账持久化状态。" }]]);
    const result = await createPptRuntime(registry, gateway).run({
      threadId: "interrupted-thread",
      request: "继续",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
      startMode: { type: "resume_query", reason: "crash_recovery" },
    });
    expect(result.type).toBe("message");
    const resultBlock = gateway.requests[0]
      .messages!.flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");
    expect(resultBlock).toMatchObject({
      type: "tool_result",
      toolUseId: "uncertain-tool",
      isError: true,
    });
  });

  it("pairs every unfinished tool in a recovered concurrent wave", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-tool-wave-recovery-"));
    const toolUses = [
      { type: "tool_use" as const, id: "uncertain-a", name: "WriteFile", input: {} },
      { type: "tool_use" as const, id: "uncertain-b", name: "WriteFile", input: {} },
    ];
    const userMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "write" }],
    };
    const assistantMessage = { role: "assistant" as const, content: toolUses };
    const now = new Date().toISOString();
    await new DurableRunStore(workspaceRoot).save({
      version: 2,
      threadId: asThreadId("interrupted-wave-thread"),
      queryId: asQueryId("interrupted-wave-query"),
      lastRunId: asRunId("interrupted-wave-run"),
      status: "running",
      phase: "tool_running",
      request: "write",
      baseRevision: 0,
      transcript: [{ role: "user", content: "write" }],
      pendingUserContent: [],
      discoveredToolNames: [],
      loadedSkillNames: [],
      committedState: {
        messages: [userMessage],
        turnCount: 0,
        maxOutputTokensRecoveryCount: 0,
        hasAttemptedReactiveCompact: false,
        validationFailuresByTool: [],
      },
      inflight: {
        phase: "tool_running",
        workspace: {
          messagesForQuery: [userMessage],
          assistantMessages: [assistantMessage],
          toolUseBlocks: toolUses,
          toolResults: [],
          userContent: [],
          followUpMessages: [],
          needsFollowUp: false,
          maxOutputTokensRecoveryCount: 0,
          hasAttemptedReactiveCompact: false,
          validationFailuresByTool: [],
        },
        activeToolUses: toolUses,
      },
      createdAt: now,
      updatedAt: now,
    });

    const gateway = gatewayFor([[{ type: "text", text: "reconciled" }]]);
    await createPptRuntime(new ToolRegistry(), gateway).run({
      threadId: "interrupted-wave-thread",
      runId: "replacement-wave-run",
      request: "continue",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
      startMode: { type: "resume_query", reason: "crash_recovery" },
    });

    const recoveredResults = gateway.requests[0]!.messages!.flatMap(
      (message) => message.content,
    ).filter((block) => block.type === "tool_result");
    expect(recoveredResults.map((result) => result.toolUseId)).toEqual([
      "uncertain-a",
      "uncertain-b",
    ]);
    expect(recoveredResults.every((result) => result.isError)).toBe(true);
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("replays a model_streaming attempt instead of committing an empty turn", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-model-stream-recovery-"));
    const failingGateway: AgentModelGateway = {
      async queryModel() {
        throw new Error("provider disconnected during streaming");
      },
      async *queryModelStream() {
        throw new Error("provider disconnected during streaming");
      },
    };
    await expect(
      createPptRuntime(new ToolRegistry(), failingGateway).run({
        threadId: "stream-recovery-thread",
        runId: "failed-stream-run",
        request: "original request",
        presentationSnapshot: createStarterPresentation(),
        selectedElementIds: [],
        workspaceRoot,
        maxSteps: 1,
      }),
    ).rejects.toThrow("provider disconnected during streaming");

    const failedCheckpoint = await new DurableRunStore(workspaceRoot).load(
      "stream-recovery-thread",
    );
    expect(failedCheckpoint?.version === 2 ? failedCheckpoint.inflight?.phase : undefined).toBe(
      "model_streaming",
    );

    const recoveredGateway = gatewayFor([[{ type: "text", text: "replayed safely" }]]);
    const result = await createPptRuntime(new ToolRegistry(), recoveredGateway).run({
      threadId: "stream-recovery-thread",
      runId: "recovered-stream-run",
      request: "continue after crash",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
      maxSteps: 1,
      startMode: { type: "resume_query", reason: "crash_recovery" },
    });

    expect(result).toEqual({ type: "message", content: "replayed safely" });
    expect(recoveredGateway.requests).toHaveLength(1);
    expect(
      recoveredGateway.requests[0]!.messages!.flatMap((message) => message.content),
    ).toContainEqual({ type: "text", text: "continue after crash" });
  });

  it("restores canonical ContentBlock history after AskUser", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-run-recovery-"));
    const registry = new ToolRegistry();
    registry.register(askUserTool);
    const firstGateway = gatewayFor([
      [
        {
          type: "tool_use",
          id: "ask-1",
          name: "AskUser",
          input: { message: "需要确认受众" },
        },
      ],
    ]);
    const first = await createPptRuntime(registry, firstGateway).run({
      threadId: "thread-recovery",
      runId: "thread-recovery",
      request: "制作演示文稿",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
    });
    expect(first.type).toBe("ask_user");

    const checkpoint = await new DurableRunStore(workspaceRoot).load("thread-recovery");
    expect(checkpoint).toBeDefined();
    if (!checkpoint) throw new Error("expected a durable checkpoint");
    expect(checkpoint.status).toBe("waiting_user");
    expect(checkpoint.version).toBe(2);
    if (checkpoint.version !== 2) throw new Error("expected a version 2 checkpoint");
    expect(checkpoint).not.toHaveProperty("modelMessages");
    expect(checkpoint).not.toHaveProperty("pendingToolResults");
    expect(checkpoint).not.toHaveProperty("renderFeedbackUsed");
    expect(checkpoint.inflight?.phase).toBe("waiting_user");
    expect(checkpoint.inflight?.workspace.toolResults[0]).toMatchObject({ toolUseId: "ask-1" });

    const secondGateway = gatewayFor([[{ type: "text", text: "已按管理层受众继续。" }]]);
    const second = await createPptRuntime(registry, secondGateway).run({
      threadId: "thread-recovery",
      runId: "run-2",
      request: "受众是管理层",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
      startMode: { type: "resume_query", reason: "waiting_user" },
    });
    expect(second).toEqual({ type: "message", content: "已按管理层受众继续。" });
    const blocks = secondGateway.requests[0].messages!.flatMap((message) => message.content);
    expect(blocks).toContainEqual(expect.objectContaining({ type: "tool_use", id: "ask-1" }));
    expect(blocks).toContainEqual(
      expect.objectContaining({ type: "tool_result", toolUseId: "ask-1" }),
    );
    const resumedCheckpoint = await new DurableRunStore(workspaceRoot).load("thread-recovery");
    expect(resumedCheckpoint?.version).toBe(2);
    if (resumedCheckpoint?.version !== 2) {
      throw new Error("expected a resumed version 2 checkpoint");
    }
    expect(resumedCheckpoint.queryId).toBe(checkpoint.queryId);
    expect(resumedCheckpoint.lastRunId).toBe("run-2");
    expect(resumedCheckpoint.queryId).not.toBe(resumedCheckpoint.lastRunId);
    expect(resumedCheckpoint.queryId).not.toBe(resumedCheckpoint.threadId);

    await createPptRuntime(
      registry,
      gatewayFor([[{ type: "text", text: "新的请求已完成。" }]]),
    ).run({
      threadId: "thread-recovery",
      runId: "run-3",
      request: "开始一个独立的新请求",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
      startMode: { type: "new_query" },
    });
    const newQueryCheckpoint = await new DurableRunStore(workspaceRoot).load("thread-recovery");
    expect(newQueryCheckpoint?.version).toBe(2);
    if (newQueryCheckpoint?.version !== 2) {
      throw new Error("expected a new-query version 2 checkpoint");
    }
    expect(newQueryCheckpoint.queryId).not.toBe(resumedCheckpoint.queryId);
    expect(newQueryCheckpoint.lastRunId).toBe("run-3");
  });

  it("restores and applies a command approval after service reconstruction", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-approval-recovery-"));
    const lifecyclePath = join(workspaceRoot, "lifecycle.sqlite");
    const blobStore = new ContentAddressedBlobStore(join(workspaceRoot, "blobs"));
    const sessionStore = new FileSessionStore(lifecyclePath, join(workspaceRoot, "projects"));
    await sessionStore.initialize();
    const bootstrap = await sessionStore.createSession({
      title: "Approval recovery",
    });
    const sessionId = bootstrap.activeSession!.session.id;
    const presentation = bootstrap.activeSession!.presentation;
    const projectId = asProjectId("recovery-project");
    const presentationId = asPresentationId(presentation.id);
    const registry = new ToolRegistry();
    registry.register(createFakeCommandProposalTool());
    const gateway = gatewayFor([
      [
        {
          type: "tool_use",
          id: "submit-1",
          name: "FakeSubmitCommands",
          input: {
            summary: "更新标题",
            risk: "low",
            commands: [{ id: "cmd-1", type: "set-presentation-title", title: "持久化标题" }],
          },
        },
      ],
    ]);
    const firstRepository = new PresentationLifecycleRepository({
      filePath: lifecyclePath,
      connection: sessionStore.conversationDatabase.sqliteConnection,
    });
    const firstLifecycle = new PresentationLifecycleOrchestrator(firstRepository);
    firstLifecycle.beginCapability({
      projectId,
      presentationId,
      queryId: asQueryId("recovery-query"),
      capability: "edit",
      instruction: "更新标题",
    });
    const firstBus = new CommandBus(presentation);
    const firstCommitService = new PresentationCommitService(
      sessionId,
      projectId,
      presentationId,
      firstBus,
      sessionStore,
      firstLifecycle,
      blobStore,
    );
    const firstService = new AgentService(
      firstBus,
      createPptRuntime(registry, gateway),
      new CommitGate(new RiskPolicy()),
      workspaceRoot,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      firstLifecycle,
      firstCommitService,
      blobStore,
    );
    const proposed = await firstService.start(
      "更新标题",
      undefined,
      "REQUEST_APPROVAL",
      undefined,
      undefined,
      undefined,
      undefined,
      "approval-thread",
    );
    expect(proposed.status).toBe("approval-required");
    if (proposed.status !== "approval-required") throw new Error("Expected approval");
    const foreignPresentation = createStarterPresentation();
    const foreignService = new AgentService(
      new CommandBus(foreignPresentation),
      createPptRuntime(registry, gatewayFor([])),
      new CommitGate(new RiskPolicy()),
      workspaceRoot,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      firstLifecycle,
      undefined,
      blobStore,
    );
    await expect(
      foreignService.resumeProposal(proposed.approval.proposalId, false),
    ).rejects.toThrow(/belongs to Presentation/);
    await expect(foreignService.resumeProposal(proposed.approval.proposalId, true)).rejects.toThrow(
      /belongs to Presentation/,
    );
    expect(firstRepository.getProposal(asProposalId(proposed.approval.proposalId))?.status).toBe(
      "waiting_approval",
    );
    firstRepository.close();

    const restoredBus = new CommandBus(sessionStore.getSession(sessionId).presentation);
    const restoredRepository = new PresentationLifecycleRepository({
      filePath: lifecyclePath,
      connection: sessionStore.conversationDatabase.sqliteConnection,
    });
    const restoredLifecycle = new PresentationLifecycleOrchestrator(restoredRepository);
    const restoredCommitService = new PresentationCommitService(
      sessionId,
      projectId,
      presentationId,
      restoredBus,
      sessionStore,
      restoredLifecycle,
      blobStore,
    );
    const restoredService = new AgentService(
      restoredBus,
      createPptRuntime(registry, gatewayFor([])),
      new CommitGate(new RiskPolicy()),
      workspaceRoot,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      restoredLifecycle,
      restoredCommitService,
      blobStore,
    );
    const applied = await restoredService.resumeProposal(proposed.approval.proposalId, true);
    expect(applied.status).toBe("completed");
    expect(restoredBus.getSnapshot().title).toBe("持久化标题");
    expect(restoredRepository.getProposal(asProposalId(proposed.approval.proposalId))?.status).toBe(
      "applied",
    );
    const appliedRevision = restoredBus.getSnapshot().revision;
    await expect(
      restoredService.resumeProposal(proposed.approval.proposalId, true),
    ).resolves.toMatchObject({ status: "completed" });
    expect(restoredBus.getSnapshot().revision).toBe(appliedRevision);
    restoredRepository.close();
    sessionStore.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("keeps SVG proposal markup in blobs and rejects a tampered command blob", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-blob-proposal-"));
    const lifecyclePath = join(workspaceRoot, "lifecycle.sqlite");
    const blobStore = new ContentAddressedBlobStore(join(workspaceRoot, "blobs"));
    const sessionStore = new FileSessionStore(lifecyclePath, join(workspaceRoot, "projects"));
    await sessionStore.initialize();
    const bootstrap = await sessionStore.createSession({
      title: "SVG proposal recovery",
    });
    const sessionId = bootstrap.activeSession!.session.id;
    const presentation = bootstrap.activeSession!.presentation;
    const presentationId = asPresentationId(presentation.id);
    const projectId = asProjectId("blob-proposal-project");
    const marker = "LIFECYCLE_BLOB_ONLY_MARKUP";
    const markup = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"',
      ' viewBox="0 0 1280 720">',
      '<rect width="1280" height="720" fill="#ffffff"/>',
      `<text x="80" y="140" font-size="48">${marker}</text>`,
      "</svg>",
    ].join("");
    const sha256 = createHash("sha256").update(markup, "utf8").digest("hex");
    const commands = [
      {
        id: "add-svg-slide",
        type: "add-slide" as const,
        index: presentation.slides.length,
        slide: {
          id: "svg-blob-slide",
          title: "Blob-backed SVG",
          narrative: {
            role: "opening",
            coreMessage: "Lifecycle command blobs preserve complete SVG pages.",
            audienceMove: "Understand that approval can recover the exact page.",
            rhythm: "anchor" as const,
            layoutIntent: "Full-page SVG opening statement.",
          },
          visualSource: {
            kind: "svg" as const,
            markup,
            width: 1280 as const,
            height: 720 as const,
            sha256,
            sourcePath: "slides/svg/P01.svg",
            resources: [],
          },
        },
      },
    ];
    let repository = new PresentationLifecycleRepository({
      filePath: lifecyclePath,
      connection: sessionStore.conversationDatabase.sqliteConnection,
    });
    let lifecycle = new PresentationLifecycleOrchestrator(repository);
    lifecycle.beginCapability({
      projectId,
      presentationId,
      queryId: asQueryId("blob-proposal-query"),
      capability: "create",
      instruction: "Create an SVG-native slide",
    });
    const registry = new ToolRegistry();
    const firstBus = new CommandBus(presentation);
    const firstCommitService = new PresentationCommitService(
      sessionId,
      projectId,
      presentationId,
      firstBus,
      sessionStore,
      lifecycle,
      blobStore,
    );
    const firstService = new AgentService(
      firstBus,
      createPptRuntime(registry, gatewayFor([])),
      new CommitGate(new RiskPolicy()),
      workspaceRoot,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lifecycle,
      firstCommitService,
      blobStore,
    );

    try {
      const proposed = await firstService.submitDirectProposal({
        threadId: "blob-proposal-thread",
        request: "Create an SVG-native slide",
        commands,
        summary: "Add the SVG-native slide",
        risk: "low",
      });
      expect(proposed.status).toBe("approval-required");
      if (proposed.status !== "approval-required") {
        throw new Error("Expected approval");
      }

      const job = lifecycle.getState(presentationId)!;
      const lifecycleJson = repository
        .listArtifactRevisions(job.jobId)
        .map((revision) => JSON.stringify(revision))
        .join("\n");
      expect(lifecycleJson).not.toContain(marker);
      const proposalArtifact = lifecycle.getCommandProposalArtifact(
        asProposalId(proposed.approval.proposalId),
      );
      expect(proposalArtifact.value).toMatchObject({
        commandCount: 1,
        commandsBlob: {
          mediaType: "application/vnd.agent-ppt.presentation-commands+json",
          byteLength: expect.any(Number),
        },
      });
      expect((await blobStore.get(proposalArtifact.value.commandsBlob)).toString("utf8")).toContain(
        marker,
      );

      repository.close();
      repository = new PresentationLifecycleRepository({
        filePath: lifecyclePath,
        connection: sessionStore.conversationDatabase.sqliteConnection,
      });
      lifecycle = new PresentationLifecycleOrchestrator(repository);
      const restoredBus = new CommandBus(sessionStore.getSession(sessionId).presentation);
      const restoredCommitService = new PresentationCommitService(
        sessionId,
        projectId,
        presentationId,
        restoredBus,
        sessionStore,
        lifecycle,
        blobStore,
      );
      const restoredService = new AgentService(
        restoredBus,
        createPptRuntime(registry, gatewayFor([])),
        new CommitGate(new RiskPolicy()),
        workspaceRoot,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        lifecycle,
        restoredCommitService,
        blobStore,
      );
      await expect(
        restoredService.resumeProposal(proposed.approval.proposalId, true),
      ).resolves.toMatchObject({ status: "completed" });
      expect(
        restoredBus.getSnapshot().slides.find((slide) => slide.id === "svg-blob-slide")
          ?.visualSource?.markup,
      ).toBe(markup);

      const applied = lifecycle.getState(presentationId)!;
      lifecycle.beginCapability({
        projectId,
        presentationId,
        queryId: asQueryId("tampered-blob-query"),
        capability: "edit",
        instruction: "Rename after SVG creation",
        basePresentationRevisionId: applied.presentationRevisionId,
      });
      const tamperedProposal = await restoredService.submitDirectProposal({
        threadId: "tampered-blob-thread",
        request: "Rename the deck",
        commands: [
          {
            id: "tampered-title",
            type: "set-presentation-title",
            title: "Must not apply",
          },
        ],
        summary: "Rename the deck",
        risk: "low",
      });
      expect(tamperedProposal.status).toBe("approval-required");
      if (tamperedProposal.status !== "approval-required") {
        throw new Error("Expected approval");
      }
      const tamperedArtifact = lifecycle.getCommandProposalArtifact(
        asProposalId(tamperedProposal.approval.proposalId),
      );
      await writeFile(
        blobStore.pathFor(tamperedArtifact.value.commandsBlob.contentHash),
        Buffer.alloc(tamperedArtifact.value.commandsBlob.byteLength, 0x78),
      );
      const beforeRejectedApply = restoredBus.getSnapshot();

      await expect(
        restoredService.resumeProposal(tamperedProposal.approval.proposalId, true),
      ).rejects.toThrow("failed integrity validation");
      expect(restoredBus.getSnapshot()).toEqual(beforeRejectedApply);
      expect(
        repository.getProposal(asProposalId(tamperedProposal.approval.proposalId))?.status,
      ).toBe("waiting_approval");
    } finally {
      repository.close();
      sessionStore.close();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
