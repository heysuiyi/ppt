import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createPptRuntime } from "@main/plugins/ppt/plugin";
import { createPptToolRegistry } from "@main/plugins/ppt/tools";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentModelContentBlock,
  AgentModelGateway,
  AgentModelRequest,
} from "../src/main/agent/gateway/types";
import { resetDefaultHooksForTests } from "../src/main/agent/runtime/hooks/default-hooks";
import type { PostToolUseBlock, StopBlock } from "../src/main/agent/runtime/hooks/hook-blocks";
import { clearHooks, registerHook } from "../src/main/agent/runtime/hooks/hook-registry";
import {
  LEAD_TASK_PERMISSIONS,
  type TaskCommand,
  type TaskCommandPrincipal,
  type TaskMutationResult,
  TaskStore,
} from "../src/main/agent/task/task-store";
import {
  formatMailboxMessagesForHistory,
  MessageBus,
} from "../src/main/agent/teammate/message-bus";
import { ProtocolStateStore } from "../src/main/agent/teammate/protocol-state";
import { TeammateManager } from "../src/main/agent/teammate/spawn-teammate";
import type { ToolContext } from "../src/main/agent/tools/tool-definition";
import { createStarterPresentation } from "../src/shared/presentation-fixtures";
import type { TeammateProgressEvent } from "../src/shared/teammate-progress";

describe("mailbox history formatting", () => {
  it("keeps full teammate content for model context and truncates only explicit previews", () => {
    const content = `result:${"x".repeat(1_500)}:tail`;
    const messages = [
      {
        id: "message-1",
        from: "researcher",
        to: "lead",
        content,
        type: "result" as const,
        ts: 1,
      },
    ];

    expect(formatMailboxMessagesForHistory(messages)).toContain(":tail");
    expect(formatMailboxMessagesForHistory(messages, 1_000)).not.toContain(":tail");
  });
});

function createSequenceGateway(responses: AgentModelContentBlock[]): AgentModelGateway {
  let index = 0;
  return {
    async queryModel() {
      const value = responses[index++];
      if (value === undefined) throw new Error("Unexpected gateway call");
      return {
        provider: "anthropic",
        model: "test-model",
        content: [value],
      };
    },
    async *queryModelStream() {
      const value = responses[index++];
      if (value === undefined) throw new Error("Unexpected gateway call");
      if (value.type === "text") yield { type: "text_delta" as const, text: value.text };
      yield { type: "complete" as const, content: [value] };
    },
  };
}

function createThinkingSequenceGateway(responses: AgentModelContentBlock[]): AgentModelGateway {
  let index = 0;
  return {
    async queryModel() {
      const value = responses[index++];
      if (value === undefined) throw new Error("Unexpected gateway call");
      return { provider: "anthropic", model: "test-model", content: [value] };
    },
    async *queryModelStream() {
      const value = responses[index++];
      if (value === undefined) throw new Error("Unexpected gateway call");
      yield { type: "thinking_delta" as const, thinking: `reasoning-${index}` };
      if (value.type === "text") yield { type: "text_delta" as const, text: value.text };
      yield { type: "complete" as const, content: [value] };
    },
  };
}

function createFailingGateway(error: Error): AgentModelGateway {
  return {
    async queryModel() {
      throw error;
    },
    async *queryModelStream() {
      throw error;
    },
  };
}

function createBoardWorkerGateway(): AgentModelGateway {
  let step = 0;
  const next = (request: AgentModelRequest): AgentModelContentBlock => {
    step += 1;
    if (step === 1) return modelMessage("Ready for shared board work.");
    if (step === 2 || step === 3) {
      const text = (request.messages ?? [])
        .flatMap((message) => message.content)
        .filter(
          (block): block is Extract<AgentModelContentBlock, { type: "text" }> =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("\n");
      const taskId = text.match(/<task_assignment[\s\S]*?"id":\s*"([^"]+)"/)?.[1];
      if (!taskId) throw new Error("Auto-claimed task assignment was not injected.");
      return step === 2
        ? modelToolCall("TaskUpdate", {
            taskId,
            expectedRevision: 1,
            status: "in_progress",
          })
        : modelToolCall("TaskReviewRequest", {
            taskId,
            requestId: `review-${taskId}`,
            expectedRevision: 2,
          });
    }
    return modelMessage("Shared board task complete.");
  };

  return {
    async queryModel(request) {
      return { provider: "anthropic", model: "test-model", content: [next(request)] };
    },
    async *queryModelStream(request) {
      const value = next(request);
      if (value.type === "text") yield { type: "text_delta" as const, text: value.text };
      yield { type: "complete" as const, content: [value] };
    },
  };
}

function createActiveContinuationGateway() {
  let releaseFirstTurn!: () => void;
  let markFirstTurnStarted!: () => void;
  const firstTurnStarted = new Promise<void>((resolve) => {
    markFirstTurnStarted = resolve;
  });
  const firstTurnRelease = new Promise<void>((resolve) => {
    releaseFirstTurn = resolve;
  });
  const requests: AgentModelRequest[] = [];
  let step = 0;
  const gateway: AgentModelGateway = {
    async queryModel() {
      throw new Error("Streaming path expected.");
    },
    async *queryModelStream(request) {
      requests.push(request);
      step += 1;
      if (step === 1) {
        markFirstTurnStarted();
        await firstTurnRelease;
        yield {
          type: "complete" as const,
          content: [modelToolCall("TaskList")],
        };
        return;
      }
      const value = modelMessage("Peer continuation handled.");
      yield { type: "text_delta" as const, text: value.text };
      yield { type: "complete" as const, content: [value] };
    },
  };
  return { gateway, firstTurnStarted, releaseFirstTurn, requests };
}

function createAbortableGateway(onStarted: () => void): AgentModelGateway {
  return {
    async queryModel() {
      throw new Error("Streaming path expected.");
    },
    async *queryModelStream(request) {
      onStarted();
      await new Promise<void>((_resolve, reject) => {
        const signal = request.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
}

class ControlledCleanupTaskStore extends TaskStore {
  private releaseCleanup!: () => void;
  readonly cleanupStarted: Promise<void>;
  private readonly cleanupRelease: Promise<void>;

  constructor(root: string) {
    super(root);
    let markStarted!: () => void;
    this.cleanupStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    this.cleanupRelease = new Promise<void>((resolve) => {
      this.releaseCleanup = resolve;
    });
    this.markCleanupStarted = markStarted;
  }

  private readonly markCleanupStarted: () => void;

  override async mutate(
    command: TaskCommand,
    principal: TaskCommandPrincipal,
  ): Promise<TaskMutationResult> {
    if (command.type === "release") {
      this.markCleanupStarted();
      await this.cleanupRelease;
    }
    return super.mutate(command, principal);
  }

  continueCleanup(): void {
    this.releaseCleanup();
  }
}

class FailingCleanupTaskStore extends TaskStore {
  override async mutate(
    command: TaskCommand,
    principal: TaskCommandPrincipal,
  ): Promise<TaskMutationResult> {
    if (command.type === "release") throw new Error("cleanup exploded");
    return super.mutate(command, principal);
  }
}

async function createBoardTask(store: TaskStore, subject: string) {
  return store.mutate(
    {
      type: "create",
      subject,
      description: "",
      executionTarget: "teammate",
      completionPolicy: "review_required",
    },
    store.principal("lead", "lead", LEAD_TASK_PERMISSIONS),
  );
}

function finishClaimedTask(taskId: string, requestId = `review-${taskId}`) {
  return [
    modelToolCall("TaskUpdate", {
      taskId,
      expectedRevision: 1,
      status: "in_progress",
    }),
    modelToolCall("TaskReviewRequest", {
      taskId,
      requestId,
      expectedRevision: 2,
    }),
  ];
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

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition.");
}

async function stopTeammate(manager: TeammateManager, name: string): Promise<void> {
  const status = manager.get(name)?.status;
  if (status !== "stopped" && status !== "failed") {
    try {
      await manager.requestShutdown(name);
    } catch {
      manager.abortTeammate(name, "Test cleanup.");
    }
  }
  await manager.waitFor(name);
}

function createToolContext(input: {
  bus: MessageBus;
  manager: TeammateManager;
  gateway?: AgentModelGateway;
  workspaceRoot?: string;
}): ToolContext {
  return {
    presentation: createStarterPresentation(),
    selectedElementIds: [],
    discoverySession: { discoveredToolNames: new Set<string>() },
    registry: createPptToolRegistry(),
    messageHistory: [],
    workspaceRoot: input.workspaceRoot,
    gateway: input.gateway,
    messageBus: input.bus,
    teammateManager: input.manager,
  };
}

describe("MessageBus", () => {
  it("appends, peeks, and consumes mailbox messages", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-bus-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));

    await bus.send({
      from: "lead",
      to: "researcher",
      content: "Please inspect the outline.",
    });

    expect((await bus.peekInbox("researcher")).map((message) => message.content)).toEqual([
      "Please inspect the outline.",
    ]);
    expect((await bus.readInbox("researcher")).map((message) => message.from)).toEqual(["lead"]);
    expect(await bus.readInbox("researcher")).toEqual([]);
    await expect(stat(bus.getInboxPath("researcher"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps concurrent appends as complete jsonl records", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-bus-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        bus.send({
          from: `agent-${index}`,
          to: "lead",
          content: `message-${index}`,
        }),
      ),
    );

    const messages = await bus.readInbox("lead");
    expect(messages).toHaveLength(12);
    expect(new Set(messages.map((message) => message.content)).size).toBe(12);
  });

  it("replays a durable claim until it is explicitly acknowledged", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-bus-claim-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    await bus.send({ id: "claim-message", from: "worker", to: "lead", content: "durable result" });

    const first = await bus.claimInbox("lead");
    expect(first?.messages).toMatchObject([{ id: "claim-message" }]);
    expect(await bus.peekInbox("lead")).toEqual([]);
    expect((await bus.claimInbox("lead"))?.claimId).toBe(first?.claimId);

    await bus.ackInboxClaim(first!.claimId);
    expect(await bus.claimInbox("lead")).toBeUndefined();
  });

  it("deduplicates replayed protocol messages by their stable id", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-bus-idempotent-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const response = {
      id: "permission-response-request-1",
      from: "lead",
      to: "worker",
      type: "permission_response" as const,
      content: "approved",
      payload: { requestId: "request-1", approved: true },
    };
    await bus.send(response);
    await bus.send(response);

    expect(await bus.readInbox("worker")).toHaveLength(1);
  });

  it("normalizes Windows-unsafe agent names in mailbox filenames", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-bus-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));

    const inboxName = basename(bus.getInboxPath("design:agent/one"));

    expect(inboxName).not.toMatch(/[:/\\]/);
    expect(inboxName).toBe("design_agent_one.jsonl");
  });
});

describe("ProtocolStateStore", () => {
  it("restores pending protocol requests from disk", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-protocol-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const first = new ProtocolStateStore(bus.getProtocolStatePath());
    await first.hydrate();
    const request = first.createRequest({
      type: "plan_approval",
      sender: "designer",
      target: "lead",
      payload: "Apply broad layout changes.",
    });
    await first.flush();

    const restored = new ProtocolStateStore(bus.getProtocolStatePath());
    await restored.hydrate();
    expect(restored.get(request.requestId)).toMatchObject({
      status: "pending",
      sender: "designer",
      target: "lead",
    });
  });

  it("matches only the expected response type, direction, and first response", () => {
    const states = new ProtocolStateStore();
    const request = states.createRequest({
      type: "plan_approval",
      sender: "bob",
      target: "lead",
      payload: "Refactor authentication.",
    });

    expect(
      states.matchResponse({
        responseType: "shutdown_response",
        requestId: request.requestId,
        approve: true,
        sender: "lead",
        target: "bob",
      }),
    ).toBeUndefined();
    expect(
      states.matchResponse({
        responseType: "plan_approval_response",
        requestId: request.requestId,
        approve: true,
        sender: "alice",
        target: "bob",
      }),
    ).toBeUndefined();
    expect(states.get(request.requestId)?.status).toBe("pending");

    expect(
      states.matchResponse({
        responseType: "plan_approval_response",
        requestId: request.requestId,
        approve: false,
        sender: "lead",
        target: "bob",
      })?.status,
    ).toBe("rejected");
    expect(
      states.matchResponse({
        responseType: "plan_approval_response",
        requestId: request.requestId,
        approve: true,
        sender: "lead",
        target: "bob",
      }),
    ).toBeUndefined();
    expect(states.get(request.requestId)?.status).toBe("rejected");
  });
});

describe("TeammateManager", () => {
  it("classifies canonical workspace file errors with no side effects", async () => {
    clearHooks();
    resetDefaultHooksForTests();
    const postToolBlocks: PostToolUseBlock[] = [];
    registerHook("PostToolUse", (block) => {
      postToolBlocks.push(block as PostToolUseBlock);
      return null;
    });

    try {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-teammate-file-error-"));
      await writeFile(join(workspaceRoot, "notes.md"), "before", "utf8");
      const requests: AgentModelRequest[] = [];
      const responses = [
        modelToolCall("EditFile", {
          path: "notes.md",
          old_string: "before",
          new_string: "after",
        }),
        modelMessage("The edit was rejected safely."),
      ];
      let responseIndex = 0;
      const gateway: AgentModelGateway = {
        async queryModel(request) {
          requests.push(request);
          const value = responses[responseIndex++];
          if (!value) throw new Error("Unexpected gateway call");
          return { provider: "anthropic", model: "test-model", content: [value] };
        },
        async *queryModelStream(request) {
          const response = await this.queryModel(request);
          yield { type: "complete" as const, content: response.content };
        },
      };
      const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
      const manager = new TeammateManager(bus);
      manager.spawn({
        name: "editor",
        role: "editor",
        prompt: "Edit notes.md without reading it.",
        workspaceRoot,
        gateway,
        maxSteps: 2,
        idlePollMs: 5,
        idleTimeoutMs: 1_000,
      });

      await waitFor(async () => (manager.get("editor")?.status === "idle" ? true : undefined));

      expect(postToolBlocks).toContainEqual(
        expect.objectContaining({
          toolName: "EditFile",
          scope: "subagent",
          executionStatus: "threw",
          sideEffects: "none",
          errorCode: "READ_REQUIRED",
        }),
      );
      expect(JSON.stringify(requests[1]?.messages)).toContain("[READ_REQUIRED]");
      expect(await readFile(join(workspaceRoot, "notes.md"), "utf8")).toBe("before");

      await manager.requestShutdown("editor");
      await manager.waitFor("editor");
    } finally {
      clearHooks();
      resetDefaultHooksForTests();
    }
  });

  it("passes the runtime Tavily configuration to teammate web_search", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-teammate-search-"));
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(
          JSON.stringify({
            results: [{ title: "Source", url: "https://example.com/source", content: "Context" }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const gateway = createSequenceGateway([
      modelToolCall("web_search", {
        query: "factory evidence",
        max_results: 3,
        search_depth: "basic",
        topic: "general",
        include_images: true,
      }),
      modelMessage("Search complete."),
    ]);
    gateway.getGatewayConfig = () => ({
      timeoutMs: 180_000,
      maxOutputTokens: 16_384,
    });
    gateway.getSearchConfig = () => ({
      webSearchApiKey: "tvly-from-settings",
    });
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    manager.spawn({
      name: "image_researcher",
      role: "layout designer",
      prompt: "Search one image source.",
      workspaceRoot,
      gateway,
      maxSteps: 2,
      idlePollMs: 5,
      idleTimeoutMs: 1_000,
    });

    try {
      await waitFor(async () => (fetchImpl.mock.calls.length > 0 ? true : undefined));
      expect(
        (fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined)
          ?.Authorization,
      ).toBe("Bearer tvly-from-settings");
    } finally {
      await stopTeammate(manager, "image_researcher");
      vi.unstubAllGlobals();
    }
  });

  it("starts idle and claims board work without an initial lead assignment", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-idle-worker-"));
    const taskRoot = await mkdtemp(join(tmpdir(), "ppt-idle-worker-tasks-"));
    const store = new TaskStore(taskRoot);
    const created = await createBoardTask(store, "Create outline");

    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    manager.spawn({
      name: "task_worker",
      role: "autonomous task worker",
      prompt: "Poll the shared board.",
      startIdle: true,
      workspaceRoot,
      taskStore: store,
      gateway: createSequenceGateway([
        ...finishClaimedTask(created.task!.id),
        modelMessage("Outline ready for review."),
      ]),
      maxSteps: 3,
      idlePollMs: 5,
      idleTimeoutMs: 1_000,
    });

    try {
      await waitFor(async () =>
        (await store.getTask(created.task!.id)).review.state === "requested" ? true : undefined,
      );
      const leadMessages = await waitFor(async () => {
        const messages = await bus.peekInbox("lead");
        return messages.some((message) => message.content === "Outline ready for review.")
          ? messages
          : undefined;
      });
      expect(leadMessages).toContainEqual(
        expect.objectContaining({
          from: "task_worker",
          type: "result",
          content: "Outline ready for review.",
        }),
      );
    } finally {
      await stopTeammate(manager, "task_worker");
    }
  });

  it("streams task-linked reasoning and tool activity for the autonomous worker", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-worker-progress-"));
    const taskRoot = await mkdtemp(join(tmpdir(), "ppt-worker-progress-tasks-"));
    const store = new TaskStore(taskRoot);
    const created = await createBoardTask(store, "Draft storyboard");

    const events: TeammateProgressEvent[] = [];
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    manager.spawn({
      name: "task_worker",
      role: "autonomous task worker",
      prompt: "Poll the shared board.",
      startIdle: true,
      workspaceRoot,
      taskStore: store,
      gateway: createThinkingSequenceGateway([
        ...finishClaimedTask(created.task!.id),
        modelMessage("Storyboard ready for review."),
      ]),
      onProgress: (event) => events.push(event),
      maxSteps: 3,
      idlePollMs: 5,
      idleTimeoutMs: 1_000,
    });

    try {
      await waitFor(async () =>
        events.some((event) => event.type === "teammate-assignment-finished") ? true : undefined,
      );

      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "teammate-assignment-started",
          "teammate-thinking-chunk",
          "teammate-tool-started",
          "teammate-tool-finished",
          "teammate-assignment-finished",
        ]),
      );
      expect(events.every((event) => event.activityId === created.task!.id)).toBe(true);
      expect(events.find((event) => event.type === "teammate-tool-started")).toEqual(
        expect.objectContaining({ toolName: "TaskUpdate", taskId: created.task!.id }),
      );
      expect(
        events.find(
          (event) =>
            event.type === "teammate-tool-finished" && event.toolName === "TaskReviewRequest",
        ),
      ).toEqual(
        expect.objectContaining({
          toolName: "TaskReviewRequest",
          taskId: created.task!.id,
          status: "completed",
        }),
      );
    } finally {
      await stopTeammate(manager, "task_worker");
    }
  });

  it("runs a teammate asynchronously and delivers result messages to lead", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-teammate-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    const gateway = createSequenceGateway([
      modelToolCall("send_message", {
        to_agent: "lead",
        content: "Found three outline risks.",
      }),
      modelMessage("Finished outline review."),
    ]);

    const handle = manager.spawn({
      name: "reviewer",
      role: "outline reviewer",
      prompt: "Review the outline.",
      workspaceRoot,
      gateway,
      maxSteps: 2,
      idlePollMs: 10,
    });

    expect(handle.status).toBe("running");
    const messages = await waitFor(async () => {
      const inbox = await bus.peekInbox("lead");
      return inbox.some((message) => message.type === "idle_notification") ? inbox : undefined;
    });

    expect(messages.map((message) => message.type)).toEqual([
      "message",
      "result",
      "idle_notification",
    ]);
    expect(messages.map((message) => message.from)).toEqual(["reviewer", "reviewer", "reviewer"]);

    const shutdown = await manager.requestShutdown("reviewer");
    await manager.waitFor("reviewer");
    expect(manager.getProtocolState(shutdown.requestId)?.status).toBe("pending");
    const finalInbox = await manager.consumeLeadInbox();
    expect(finalInbox).toContainEqual(
      expect.objectContaining({
        from: "reviewer",
        type: "shutdown_response",
        payload: expect.objectContaining({
          requestId: shutdown.requestId,
          approve: true,
        }),
      }),
    );
    expect(manager.getProtocolState(shutdown.requestId)?.status).toBe("approved");
    expect(manager.list().find((item) => item.name === "reviewer")?.status).toBe("stopped");
  });

  it("pauses a broad change for plan approval and resumes after the matching response", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-plan-approval-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    const gateway = createSequenceGateway([
      modelToolCall("request_plan_approval", {
        plan: "Create auth.ts with the approved authentication refactor scaffold.",
      }),
      modelMessage("Plan ready; waiting for lead approval."),
      modelToolCall("WriteFile", {
        path: "auth.ts",
        content: "export const authVersion = 2;\n",
      }),
      modelMessage("Approved authentication scaffold completed."),
    ]);

    manager.spawn({
      name: "bob",
      role: "authentication engineer",
      prompt: "Refactor authentication, but request plan approval first.",
      workspaceRoot,
      gateway,
      maxSteps: 4,
      idlePollMs: 10,
    });

    const requestMessage = await waitFor(async () => {
      const messages = await bus.peekInbox("lead");
      return messages.find((message) => message.type === "plan_approval_request");
    });
    const requestId = requestMessage.payload?.requestId;
    expect(typeof requestId).toBe("string");

    await waitFor(async () => (manager.get("bob")?.status === "idle" ? true : undefined));
    await manager.consumeLeadInbox();
    expect(manager.getProtocolState(requestId as string)?.status).toBe("pending");

    const respondTool = createPptToolRegistry().get("respond_plan_approval");
    expect(respondTool).toBeDefined();
    await respondTool!.execute(
      {
        request_id: requestId,
        approve: true,
        reason: "The plan is scoped and reversible.",
      },
      createToolContext({ bus, manager, gateway, workspaceRoot }),
    );

    await waitFor(async () => {
      try {
        return (await readFile(join(workspaceRoot, "auth.ts"), "utf8")).includes("authVersion")
          ? true
          : undefined;
      } catch {
        return undefined;
      }
    });
    expect(manager.getProtocolState(requestId as string)?.status).toBe("approved");

    await waitFor(async () => (manager.get("bob")?.status === "idle" ? true : undefined));
    await manager.requestShutdown("bob");
    await manager.waitFor("bob");
  });

  it("keeps mutating tools blocked after lead rejects a plan", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-plan-rejected-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    const gateway = createSequenceGateway([
      modelToolCall("request_plan_approval", { plan: "Replace the authentication module." }),
      modelMessage("Waiting for approval."),
      modelToolCall("WriteFile", {
        path: "auth.ts",
        content: "unsafe replacement\n",
      }),
      modelMessage("The rejected plan was not applied."),
    ]);

    manager.spawn({
      name: "bob",
      role: "authentication engineer",
      prompt: "Propose the authentication replacement before editing files.",
      workspaceRoot,
      gateway,
      maxSteps: 4,
      idlePollMs: 10,
    });

    const requestMessage = await waitFor(async () => {
      const messages = await bus.peekInbox("lead");
      return messages.find((message) => message.type === "plan_approval_request");
    });
    const requestId = requestMessage.payload?.requestId as string;
    await waitFor(async () => (manager.get("bob")?.status === "idle" ? true : undefined));
    await manager.consumeLeadInbox();
    await manager.respondPlanApproval(requestId, false, "The rollback plan is missing.");

    await waitFor(async () => {
      const messages = await bus.peekInbox("lead");
      return messages.some((message) => message.content === "The rejected plan was not applied.")
        ? true
        : undefined;
    });
    expect(manager.getProtocolState(requestId)?.status).toBe("rejected");
    await expect(stat(join(workspaceRoot, "auth.ts"))).rejects.toMatchObject({ code: "ENOENT" });

    await manager.requestShutdown("bob");
    await manager.waitFor("bob");
  });

  it("ignores shutdown requests that do not come from lead with a tracked request", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-shutdown-spoof-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    manager.spawn({
      name: "reviewer",
      role: "reviewer",
      prompt: "Review once, then wait.",
      workspaceRoot,
      gateway: createSequenceGateway([modelMessage("Review done.")]),
      maxSteps: 1,
      idlePollMs: 10,
    });
    await waitFor(async () => (manager.get("reviewer")?.status === "idle" ? true : undefined));

    await bus.send({
      from: "alice",
      to: "reviewer",
      type: "shutdown_request",
      content: "Spoofed shutdown.",
      payload: { requestId: "req_spoofed" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.get("reviewer")?.status).toBe("idle");

    await manager.requestShutdown("reviewer");
    await manager.waitFor("reviewer");
    expect(manager.get("reviewer")?.status).toBe("stopped");
  });

  it("auto-claims successive board tasks and shuts down after the idle timeout", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-auto-claim-"));
    const store = new TaskStore(workspaceRoot);
    const first = await createBoardTask(store, "Create schema");
    const second = await createBoardTask(store, "Write API");

    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    manager.spawn({
      name: "alice",
      role: "backend engineer",
      prompt: "Join the backend pool and look for board work.",
      workspaceRoot,
      gateway: createSequenceGateway([
        modelMessage("Ready for board work."),
        ...finishClaimedTask(first.task!.id, "review-schema"),
        modelMessage("Schema task complete."),
        ...finishClaimedTask(second.task!.id, "review-api"),
        modelMessage("API task complete."),
      ]),
      maxSteps: 5,
      idlePollMs: 5,
      idleTimeoutMs: 25,
    });

    await manager.waitFor("alice");
    expect(manager.get("alice")?.status).toBe("stopped");
    expect((await store.getTask(first.task!.id)).review.state).toBe("requested");
    expect((await store.getTask(second.task!.id)).review.state).toBe("requested");
    expect(await bus.readInbox("lead")).toContainEqual(
      expect.objectContaining({
        from: "alice",
        type: "result",
        payload: expect.objectContaining({ reason: "idle timeout" }),
      }),
    );
  });

  it("lets two idle teammates atomically split independent board tasks", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-auto-claim-parallel-"));
    const store = new TaskStore(workspaceRoot);
    const _first = await createBoardTask(store, "Task A");
    const _second = await createBoardTask(store, "Task B");

    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    for (const name of ["alice", "bob"]) {
      manager.spawn({
        name,
        role: "backend engineer",
        prompt: "Join the shared worker pool.",
        workspaceRoot,
        gateway: createBoardWorkerGateway(),
        maxSteps: 4,
        idlePollMs: 5,
        idleTimeoutMs: 30,
      });
    }

    await Promise.all([manager.waitFor("alice"), manager.waitFor("bob")]);
    const tasks = await store.listTasks();
    expect(tasks.map((task) => task.review.state)).toEqual(["requested", "requested"]);
    const results = (await bus.readInbox("lead")).filter(
      (message) => message.content === "Shared board task complete.",
    );
    expect(new Set(results.map((message) => message.from))).toEqual(new Set(["alice", "bob"]));
  });

  it("handles an idle inbox assignment before scanning the task board", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-idle-priority-"));
    const store = new TaskStore(workspaceRoot);
    const created = await createBoardTask(store, "Board task");

    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    manager.spawn({
      name: "alice",
      role: "backend engineer",
      prompt: "Enter the worker pool.",
      workspaceRoot,
      gateway: createSequenceGateway([
        modelMessage("Ready."),
        modelMessage("Handled urgent lead assignment."),
      ]),
      maxSteps: 2,
      idlePollMs: 200,
      idleTimeoutMs: 1_000,
    });
    await waitFor(async () => (manager.get("alice")?.status === "idle" ? true : undefined));

    await bus.send({
      from: "lead",
      to: "alice",
      type: "message",
      content: "Handle this inbox instruction first.",
    });
    await waitFor(async () => {
      const messages = await bus.peekInbox("lead");
      return messages.some((message) => message.content === "Handled urgent lead assignment.")
        ? true
        : undefined;
    });
    expect((await store.getTask(created.task!.id)).status).toBe("pending");

    await manager.requestShutdown("alice");
    await manager.waitFor("alice");
  });

  it("lets lead send a second assignment to an idle teammate", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-teammate-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    const gateway = createSequenceGateway([
      modelMessage("First review done."),
      modelMessage("Second review done."),
    ]);
    const registry = createPptToolRegistry();

    manager.spawn({
      name: "reviewer",
      role: "outline reviewer",
      prompt: "Review the outline.",
      workspaceRoot,
      gateway,
      maxSteps: 2,
      idlePollMs: 10,
    });

    await waitFor(async () =>
      manager.list().find((item) => item.name === "reviewer" && item.status === "idle"),
    );

    const listTool = registry.get("list_teammates");
    expect(listTool).toBeDefined();
    const listResult = await listTool!.execute(
      {},
      createToolContext({
        bus,
        manager,
        gateway,
        workspaceRoot,
      }),
    );
    expect(listResult.teammates).toEqual([
      expect.objectContaining({ name: "reviewer", status: "idle" }),
    ]);

    const sendTool = registry.get("send_teammate_message");
    expect(sendTool).toBeDefined();
    await sendTool!.execute(
      {
        name: "reviewer",
        content: "Now review the citations.",
      },
      createToolContext({ bus, manager, gateway, workspaceRoot }),
    );

    const messages = await waitFor(async () => {
      const inbox = await bus.peekInbox("lead");
      return inbox.some((message) => message.content === "Second review done.") ? inbox : undefined;
    });

    expect(
      messages.filter((message) => message.type === "result").map((message) => message.content),
    ).toEqual(["First review done.", "Second review done."]);

    const shutdownTool = registry.get("shutdown_teammate");
    expect(shutdownTool).toBeDefined();
    await shutdownTool!.execute(
      { name: "reviewer" },
      createToolContext({
        bus,
        manager,
        gateway,
        workspaceRoot,
      }),
    );
    await manager.waitFor("reviewer");
    expect(manager.get("reviewer")?.status).toBe("stopped");
  });

  it("keeps an idle teammate alive after an assignment uses the max step budget", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-teammate-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    const gateway = createSequenceGateway([modelMessage("Finished in one step.")]);

    manager.spawn({
      name: "reviewer",
      role: "outline reviewer",
      prompt: "Review the outline.",
      workspaceRoot,
      gateway,
      maxSteps: 1,
      idlePollMs: 10,
    });

    await waitFor(async () =>
      manager.list().find((item) => item.name === "reviewer" && item.status === "idle"),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(manager.get("reviewer")?.status).toBe("idle");
    await manager.requestShutdown("reviewer");
    await manager.waitFor("reviewer");
    expect(manager.get("reviewer")?.status).toBe("stopped");
  });

  it("drains peer continuation messages between complete model-tool turns", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-active-continuation-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    const controlled = createActiveContinuationGateway();
    const events: TeammateProgressEvent[] = [];
    manager.spawn({
      name: "reviewer",
      role: "outline reviewer",
      prompt: "Begin the review.",
      workspaceRoot,
      gateway: controlled.gateway,
      onProgress: (event) => events.push(event),
      maxSteps: 1,
      idlePollMs: 5,
      idleTimeoutMs: 1_000,
    });

    await controlled.firstTurnStarted;
    await bus.send({
      from: "researcher",
      to: "reviewer",
      type: "message",
      content: "Include the source audit in this assignment.",
    });
    controlled.releaseFirstTurn();

    await waitFor(async () => {
      const messages = await bus.peekInbox("lead");
      return messages.some((message) => message.content === "Peer continuation handled.")
        ? true
        : undefined;
    });
    const secondTurnText = (controlled.requests[1]?.messages ?? [])
      .flatMap((message) => message.content)
      .filter(
        (block): block is Extract<AgentModelContentBlock, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n");
    expect(secondTurnText).toContain("Include the source audit in this assignment.");
    expect(events.filter((event) => event.type === "teammate-assignment-started")).toHaveLength(1);

    await manager.requestShutdown("reviewer");
    await manager.waitFor("reviewer");
  });

  it("does not complete while manually claimed tasks remain in progress", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-owned-task-completion-"));
    const taskRoot = await mkdtemp(join(tmpdir(), "ppt-owned-task-completion-tasks-"));
    const store = new TaskStore(taskRoot);
    const created = await createBoardTask(store, "Inspect the narrative");

    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    manager.spawn({
      name: "reviewer",
      role: "outline reviewer",
      prompt: "Claim the review task and complete it.",
      workspaceRoot,
      taskStore: store,
      gateway: createSequenceGateway([
        modelToolCall("TaskClaim", { taskId: created.task!.id, expectedRevision: 0 }),
        modelToolCall("TaskUpdate", {
          taskId: created.task!.id,
          expectedRevision: 1,
          status: "in_progress",
        }),
        modelMessage("I am done, but have not requested review."),
        modelToolCall("TaskReviewRequest", {
          taskId: created.task!.id,
          requestId: "manual-review",
          expectedRevision: 2,
        }),
        modelMessage("The claimed task is now ready for review."),
      ]),
      maxSteps: 5,
      idlePollMs: 5,
      idleTimeoutMs: 1_000,
    });

    await waitFor(async () =>
      (await store.getTask(created.task!.id)).review.state === "requested" ? true : undefined,
    );
    await waitFor(async () => {
      const messages = await bus.peekInbox("lead");
      return messages.some(
        (message) =>
          message.from === "reviewer" &&
          message.type === "result" &&
          message.content === "The claimed task is now ready for review.",
      )
        ? true
        : undefined;
    });

    await manager.requestShutdown("reviewer");
    await manager.waitFor("reviewer");
  });

  it("captures background teammate failures without rejecting waiters", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-teammate-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      manager.spawn({
        name: "reviewer",
        role: "outline reviewer",
        prompt: "Review the outline.",
        workspaceRoot,
        gateway: createFailingGateway(new Error("gateway exploded")),
        maxSteps: 1,
        idlePollMs: 10,
      });

      await waitFor(async () =>
        manager.list().find((item) => item.name === "reviewer" && item.status === "failed"),
      );
      await expect(manager.waitFor("reviewer")).resolves.toBeUndefined();

      expect(unhandled).toEqual([]);
      expect(manager.get("reviewer")?.lastError).toBe("gateway exploded");
      expect(await bus.readInbox("lead")).toEqual([
        expect.objectContaining({
          from: "reviewer",
          type: "error",
          content: "gateway exploded",
        }),
      ]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("Lead teammate tools", () => {
  it("rejects messages to unknown teammates without creating orphan mailboxes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-teammate-tools-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    const tool = createPptToolRegistry().get("send_teammate_message");

    expect(tool).toBeDefined();
    await expect(
      tool!.execute(
        {
          name: "missing",
          content: "hello?",
        },
        createToolContext({ bus, manager, workspaceRoot }),
      ),
    ).rejects.toThrow("Unknown teammate: missing");
    await expect(stat(bus.getInboxPath("missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Lead inbox injection", () => {
  it("routes teammate permission requests through lead approval and responds by inbox", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-lead-inbox-"));
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    await bus.send({
      from: "worker",
      to: "lead",
      type: "permission_request",
      content: "Tool bash needs approval: 删除命令：rm notes.md",
      payload: {
        requestId: "perm-1",
        toolName: "bash",
        args: { command: "rm notes.md" },
        reason: "删除命令：rm notes.md",
      },
    });

    const approvalRequests: unknown[] = [];
    const runtime = createPptRuntime(
      createPptToolRegistry(),
      createSequenceGateway([modelMessage("Handled teammate permission request.")]),
    );

    const result = await runtime.run({
      threadId: "lead-thread",
      request: "Process teammate inbox.",
      presentationSnapshot: createStarterPresentation(),
      selectedElementIds: [],
      workspaceRoot,
      messageBus: bus,
      requestToolApproval: async (request) => {
        approvalRequests.push(request);
        return true;
      },
    });

    expect(result.type).toBe("message");
    expect(approvalRequests).toEqual([
      {
        toolName: "bash",
        args: { command: "rm notes.md" },
        reason: "删除命令：rm notes.md",
      },
    ]);
    expect(await bus.readInbox("lead")).toEqual([]);
    expect(await bus.readInbox("worker")).toEqual([
      expect.objectContaining({
        from: "lead",
        to: "worker",
        type: "permission_response",
        payload: expect.objectContaining({
          requestId: "perm-1",
          approved: true,
          toolName: "bash",
        }),
      }),
    ]);
  });
});

describe("Teammate terminal lifecycle", () => {
  it("does not expose stopped before terminal cleanup completes", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-teammate-stopping-"));
    const taskRoot = await mkdtemp(join(tmpdir(), "ppt-teammate-stopping-tasks-"));
    const store = new ControlledCleanupTaskStore(taskRoot);
    const cleanupTask = await createBoardTask(store, "Cleanup-owned task");
    await store.mutate(
      {
        type: "claim",
        taskId: cleanupTask.task!.id,
        expectedRevision: cleanupTask.task!.revision,
      },
      store.principal("reviewer", "teammate", new Set(["task:update_own"])),
    );
    const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
    const manager = new TeammateManager(bus);
    manager.spawn({
      name: "reviewer",
      role: "outline reviewer",
      prompt: "Finish and wait.",
      workspaceRoot,
      taskStore: store,
      gateway: createSequenceGateway([modelMessage("Ready to stop.")]),
      idlePollMs: 5,
      idleTimeoutMs: 1_000,
    });
    await waitFor(async () => (manager.get("reviewer")?.status === "idle" ? true : undefined));

    await manager.requestShutdown("reviewer");
    await store.cleanupStarted;
    expect(manager.get("reviewer")?.status).toBe("idle");

    store.continueCleanup();
    await manager.waitFor("reviewer");
    expect(manager.get("reviewer")?.status).toBe("stopped");
  });

  it("reports an explicit abort without converting it to failure", async () => {
    clearHooks();
    resetDefaultHooksForTests();
    const stopBlocks: StopBlock[] = [];
    registerHook("Stop", (block) => {
      stopBlocks.push(block as StopBlock);
      return null;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    try {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-teammate-abort-"));
      const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
      const manager = new TeammateManager(bus);
      manager.spawn({
        name: "reviewer",
        role: "outline reviewer",
        prompt: "Wait for cancellation.",
        workspaceRoot,
        gateway: createAbortableGateway(markStarted),
        maxSteps: 1,
      });

      await started;
      expect(manager.abortTeammate("reviewer", "User cancelled the teammate.")).toBe(true);
      await manager.waitFor("reviewer");

      expect(manager.get("reviewer")).toMatchObject({ status: "stopped" });
      expect(manager.get("reviewer")?.lastError).toBeUndefined();
      expect(stopBlocks).toEqual([
        expect.objectContaining({
          scope: "subagent",
          result: "stopped",
          reason: "aborted",
        }),
      ]);
      expect(await bus.peekInbox("lead")).not.toContainEqual(
        expect.objectContaining({
          type: "error",
        }),
      );
      expect(manager.abortTeammate("reviewer")).toBe(false);
    } finally {
      clearHooks();
      resetDefaultHooksForTests();
    }
  });

  it("keeps hook-stop completion messaging and activity semantics", async () => {
    clearHooks();
    resetDefaultHooksForTests();
    const stopBlocks: StopBlock[] = [];
    registerHook("PreToolUse", () => ({ type: "stop", reason: "Policy ended the teammate." }));
    registerHook("Stop", (block) => {
      stopBlocks.push(block as StopBlock);
      return null;
    });

    try {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-teammate-hook-stop-"));
      const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
      const manager = new TeammateManager(bus);
      const events: TeammateProgressEvent[] = [];
      manager.spawn({
        name: "reviewer",
        role: "outline reviewer",
        prompt: "Inspect the board.",
        workspaceRoot,
        gateway: createSequenceGateway([modelToolCall("TaskList")]),
        onProgress: (event) => events.push(event),
        maxSteps: 1,
      });

      await manager.waitFor("reviewer");

      expect(manager.get("reviewer")?.status).toBe("stopped");
      expect(await bus.peekInbox("lead")).toContainEqual(
        expect.objectContaining({
          from: "reviewer",
          type: "result",
          content: "Policy ended the teammate.",
        }),
      );
      expect(events.filter((event) => event.type === "teammate-assignment-finished")).toEqual([
        expect.objectContaining({
          status: "completed",
          message: "Policy ended the teammate.",
        }),
      ]);
      expect(stopBlocks).toEqual([
        expect.objectContaining({ result: "stopped", reason: "completed" }),
      ]);
    } finally {
      clearHooks();
      resetDefaultHooksForTests();
    }
  });

  it("promotes pre-hook cleanup failures to the effective failed exit", async () => {
    clearHooks();
    resetDefaultHooksForTests();
    const stopBlocks: StopBlock[] = [];
    registerHook("Stop", (block) => {
      stopBlocks.push(block as StopBlock);
      return null;
    });

    try {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "ppt-teammate-cleanup-failure-"));
      const taskRoot = await mkdtemp(join(tmpdir(), "ppt-teammate-cleanup-failure-tasks-"));
      const bus = new MessageBus(MessageBus.defaultMailboxDir(workspaceRoot));
      const manager = new TeammateManager(bus);
      const cleanupStore = new FailingCleanupTaskStore(taskRoot);
      const cleanupTask = await createBoardTask(cleanupStore, "Cleanup failure task");
      await cleanupStore.mutate(
        {
          type: "claim",
          taskId: cleanupTask.task!.id,
          expectedRevision: cleanupTask.task!.revision,
        },
        cleanupStore.principal("reviewer", "teammate", new Set(["task:update_own"])),
      );
      manager.spawn({
        name: "reviewer",
        role: "outline reviewer",
        prompt: "Finish and wait.",
        workspaceRoot,
        taskStore: cleanupStore,
        gateway: createSequenceGateway([modelMessage("Ready to stop.")]),
        idlePollMs: 5,
        idleTimeoutMs: 1_000,
      });
      await waitFor(async () => (manager.get("reviewer")?.status === "idle" ? true : undefined));

      await manager.requestShutdown("reviewer");
      await manager.waitFor("reviewer");

      expect(manager.get("reviewer")?.status).toBe("failed");
      expect(stopBlocks).toEqual([
        expect.objectContaining({ result: "failed", reason: "aborted" }),
      ]);
      const leadMessages = await bus.peekInbox("lead");
      expect(leadMessages).toContainEqual(
        expect.objectContaining({
          type: "shutdown_response",
        }),
      );
      expect(leadMessages).toContainEqual(
        expect.objectContaining({
          type: "error",
          content: "Teammate finalization failed.",
        }),
      );
    } finally {
      clearHooks();
      resetDefaultHooksForTests();
    }
  });
});
