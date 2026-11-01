import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTerminalAgentRunContent } from "@app/shared/agent-result-copy";
import { FileSessionStore } from "@main/session-store";
import { getResponseBlockContent } from "@shared/agent-activity";
import { sessionChatMessageSchema } from "@shared/session";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const stores: FileSessionStore[] = [];

async function createStore(rootPath?: string) {
  const directory = await mkdtemp(join(tmpdir(), "agent-ppt-sqlite-session-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "conversations.sqlite");
  const store = new FileSessionStore(databasePath, join(directory, "projects"));
  stores.push(store);
  await store.initialize();
  if (rootPath) await store.createSession({ rootPath, title: "Workspace session" });
  return { store, databasePath, directory };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite session store", () => {
  it("starts empty and restores sessions and messages from SQLite", async () => {
    const { store, databasePath, directory } = await createStore();
    expect(store.getBootstrap().sessions).toEqual([]);

    const created = await store.createSession({ title: "SQLite project" });
    const sessionId = created.activeSession!.session.id;
    await store.saveMessages(sessionId, [
      { id: "u1", role: "user", content: "创建演示文稿" },
      {
        id: "a1",
        role: "assistant",
        content: "演示文稿已完成",
        activityTrace: [
          {
            id: "response-complete",
            kind: "response",
            start: 0,
            end: 7,
            streaming: false,
          },
        ],
        runId: "run-complete",
        runStatus: "completed",
      },
    ]);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const restored = new FileSessionStore(databasePath, join(directory, "projects"));
    stores.push(restored);
    await restored.initialize();
    expect(restored.getSession(sessionId).messages.map((message) => message.content)).toEqual([
      "创建演示文稿",
      "演示文稿已完成",
    ]);
  });

  it("converts a crash-left running turn into an interrupted terminal state", async () => {
    const { store, databasePath, directory } = await createStore();
    const created = await store.createSession({ title: "Interrupted project" });
    const sessionId = created.activeSession!.session.id;
    const runStartedAt = Date.now() - 2_500;
    await store.saveMessages(sessionId, [
      {
        id: "a-running",
        role: "assistant",
        content: "已生成部分内容",
        runId: "run-stale",
        runStatus: "running",
        runStartedAt,
        activityTrace: [
          {
            id: "response-partial",
            kind: "response",
            start: 0,
            end: 7,
            streaming: false,
          },
          {
            id: "tool-running",
            kind: "tool",
            toolCallId: "call-running",
            toolName: "ExportPptx",
            status: "running",
          },
        ],
      },
    ]);
    store.conversationDatabase.beginRun({
      runId: "run-stale",
      sessionId,
      request: "build",
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const restored = new FileSessionStore(databasePath, join(directory, "projects"));
    stores.push(restored);
    await restored.initialize();

    const interrupted = restored.getSession(sessionId).messages[0]!;
    expect(interrupted).toMatchObject({
      content: "已生成部分内容",
      runStatus: "interrupted",
      runStartedAt,
      activityTrace: [{ kind: "response" }, { kind: "tool", status: "denied" }],
    });
    expect(interrupted.runDurationMs).toBeGreaterThanOrEqual(2_500);
    expect(restored.conversationDatabase.listRunEvents("run-stale").at(-1)?.kind).toBe(
      "run_interrupted",
    );
  });

  it("recovers a terminal run result when the assistant message write was lost", async () => {
    const { store, databasePath, directory } = await createStore();
    const created = await store.createSession({ title: "Terminal recovery" });
    const sessionId = created.activeSession!.session.id;
    await store.saveMessages(sessionId, [
      {
        id: "a-terminal-window",
        role: "assistant",
        content: "最终答案",
        runId: "run-terminal-window",
        runStatus: "running",
        activityTrace: [
          {
            id: "response-terminal-window",
            kind: "response",
            start: 0,
            end: 4,
            attemptId: "terminal-attempt",
            streaming: false,
          },
        ],
      },
    ]);
    store.conversationDatabase.beginRun({
      runId: "run-terminal-window",
      sessionId,
      request: "build",
    });
    store.conversationDatabase.appendRuntimeEvent("run-terminal-window", "text_chunk", {
      type: "text-chunk",
      attemptId: "terminal-attempt",
      chunk: "最终答案",
    });
    store.conversationDatabase.finishRun({
      runId: "run-terminal-window",
      status: "completed",
      result: {
        status: "chat",
        message: "最终答案",
        threadId: "thread-terminal",
      },
      threadId: "thread-terminal",
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const restored = new FileSessionStore(databasePath, join(directory, "projects"));
    stores.push(restored);
    await restored.initialize();

    expect(restored.getSession(sessionId).messages[0]).toMatchObject({
      content: "最终答案",
      runId: "run-terminal-window",
      runStatus: "completed",
      threadId: "thread-terminal",
      activityTrace: [{ kind: "response", start: 0, end: 4, streaming: false }],
    });
    expect(restored.conversationDatabase.listRunEvents("run-terminal-window").at(-1)?.kind).toBe(
      "run_completed",
    );
  });

  it("persists presentation state while keeping the deck snapshot in the sandbox", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Deck" });
    const snapshot = created.activeSession!;
    const presentation = {
      ...snapshot.presentation,
      title: "Stable deck",
      revision: 2,
    };
    await store.savePresentation(snapshot.session.id, presentation);

    const deck = JSON.parse(
      await readFile(
        join(store.getSession(snapshot.session.id).project!.rootPath, "deck", "snapshot.json"),
        "utf8",
      ),
    );
    expect(deck.title).toBe("Stable deck");
    expect(store.getSession(snapshot.session.id).presentation.revision).toBe(2);
  });

  it("keeps only stable artifacts and a project identity file in a user workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-ppt-workspace-"));
    temporaryDirectories.push(workspace);
    const { store } = await createStore(workspace);
    const active = store.getBootstrap().activeSession!;

    expect(active.project?.rootPath.toLowerCase()).toBe(
      join(workspace, "sandboxes", active.session.id).replace(/\\/g, "/").toLowerCase(),
    );
    const manifest = JSON.parse(await readFile(join(workspace, ".agent-ppt-project.json"), "utf8"));
    expect(manifest.projectId).toEqual(expect.any(String));
    await expect(access(join(workspace, ".agent-ppt", "sessions.index.json"))).rejects.toThrow();
    await expect(access(join(active.project!.rootPath, "transcripts"))).rejects.toThrow();
    await expect(access(join(active.project!.rootPath, ".agent"))).rejects.toThrow();
  });

  it("lists and reopens sessions from the central database instead of a workspace index", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-ppt-workspace-list-"));
    temporaryDirectories.push(workspace);
    const { store } = await createStore();
    const first = await store.createSession({ rootPath: workspace, title: "First" });
    const second = await store.createSession({ rootPath: workspace, title: "Second" });

    const listed = await store.listWorkspaceSessions(workspace);
    expect(listed.map((item) => item.id).sort()).toEqual(
      [first.activeSession!.session.id, second.activeSession!.session.id].sort(),
    );
    const opened = await store.openWorkspace(workspace);
    expect(opened.activeSession?.session.id).toBe(second.activeSession!.session.id);
  });

  it("reads, writes and protects stable workspace artifacts", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Artifacts" });
    const sessionId = created.activeSession!.session.id;
    const opened = await store.openProjectFile(sessionId, "brief.md");
    const result = await store.saveProjectFile(
      sessionId,
      "brief.md",
      "# Facts\n",
      opened.editToken,
      opened.version,
    );
    expect(result.changed).toBe(true);
    expect((await store.readProjectArtifact(sessionId, "brief.md")).content).toBe("# Facts\n");
    await expect(store.openProjectFile(sessionId, "../escape.md")).rejects.toThrow(
      "outside the sandbox",
    );
  });

  it("durably finalizes the assistant message from main-process run events", async () => {
    const { store, databasePath, directory } = await createStore();
    const created = await store.createSession({ title: "Run" });
    const sessionId = created.activeSession!.session.id;
    await store.saveMessages(sessionId, [{ id: "u1", role: "user", content: "inspect" }]);
    store.conversationDatabase.beginRun({ runId: "run-1", sessionId, request: "inspect" });
    store.conversationDatabase.appendRuntimeEvent("run-1", "reasoning_chunk", {
      chunk: "I should inspect the deck",
      modelStep: 0,
    });
    store.conversationDatabase.appendRuntimeEvent("run-1", "text_chunk", {
      type: "text-chunk",
      attemptId: "attempt-1",
      chunk: "我先检查。",
    });
    store.conversationDatabase.appendRuntimeEvent("run-1", "tool_started", {
      toolCallId: "call-read",
      toolName: "ReadPresentationSnapshot",
      message: "reading",
    });
    store.conversationDatabase.appendRuntimeEvent("run-1", "tool_finished", {
      toolCallId: "call-read",
      toolName: "ReadPresentationSnapshot",
      message: "read",
      status: "completed",
    });
    store.conversationDatabase.appendRuntimeEvent("run-1", "text_chunk", {
      type: "text-chunk",
      attemptId: "attempt-2",
      chunk: "演示文稿已检查完成。",
    });
    store.conversationDatabase.appendRuntimeEvent(
      "run-1",
      "workflow_progress",
      {
        message: "L2 micro_compact: older tool results replaced with placeholders.",
      },
      "internal",
    );
    await store.finalizeAgentRunMessage(sessionId, "run-1", {
      status: "chat",
      message: "演示文稿已检查完成。",
    });

    const assistant = store.getSession(sessionId).messages.at(-1)!;
    expect(assistant).toMatchObject({
      content: "我先检查。演示文稿已检查完成。",
      runId: "run-1",
      runStatus: "completed",
    });
    expect(assistant.activityTrace?.map((item) => item.kind)).toEqual([
      "reasoning",
      "response",
      "tool",
      "response",
    ]);
    expect(assistant.activityTrace?.find((item) => item.kind === "tool")).toMatchObject({
      toolCallId: "call-read",
      status: "completed",
    });
    expect(
      assistant.activityTrace
        ?.filter((item) => item.kind === "response")
        .map((item) => getResponseBlockContent(item, assistant.content)),
    ).toEqual(["我先检查。", "演示文稿已检查完成。"]);

    const durableTrace = structuredClone(assistant.activityTrace);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new FileSessionStore(databasePath, join(directory, "projects"));
    stores.push(reopened);
    await reopened.initialize();
    expect(reopened.getSession(sessionId).messages.at(-1)?.activityTrace).toEqual(durableTrace);
  });

  it("persists AskUser as a waiting run until the response is submitted", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Question" });
    const sessionId = created.activeSession!.session.id;
    store.conversationDatabase.beginRun({
      runId: "run-question",
      sessionId,
      request: "继续",
    });
    store.conversationDatabase.appendRuntimeEvent("run-question", "text_chunk", {
      type: "text-chunk",
      attemptId: "question-preamble",
      chunk: "我需要先确认一点。",
    });

    await store.finalizeAgentRunMessage(sessionId, "run-question", {
      status: "waiting-user",
      message: "请直接输入目标受众",
      threadId: "thread-question",
    });

    const waiting = store.getSession(sessionId).messages.at(-1)!;
    expect(waiting).toMatchObject({
      content: "我需要先确认一点。\n\n请直接输入目标受众",
      runId: "run-question",
      runStatus: "waiting",
      threadId: "thread-question",
    });
    expect(store.findWaitingAgentRunId(sessionId, "thread-question")).toBe("run-question");

    await store.saveMessages(sessionId, [
      {
        ...waiting,
        runStatus: "completed",
      },
    ]);
    expect(store.getSession(sessionId).messages.at(-1)?.runStatus).toBe("completed");
  });

  it("keeps the Query completed while Proposal approval records a later Presentation fact", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Approval" });
    const sessionId = created.activeSession!.session.id;

    await store.finalizeAgentRunMessage(sessionId, "run-approval", {
      status: "approval-required",
      approval: {
        jobId: "job-approval",
        queryId: "query-approval",
        proposalId: "proposal-approval",
        threadId: "thread-approval",
        summary: "应用排版",
        commands: [],
      },
    });
    const proposalReadyMessages = store.getSession(sessionId).messages;
    expect(proposalReadyMessages.at(-1)?.runStatus).toBe("completed");
    expect(store.findWaitingAgentRunId(sessionId, "thread-approval")).toBeUndefined();

    const terminalResult = {
      status: "completed" as const,
      presentation: created.activeSession!.presentation,
    };
    await store.finalizeAgentRunMessage(sessionId, "run-approval", terminalResult);
    await store.saveMessages(sessionId, proposalReadyMessages);

    const messages = store.getSession(sessionId).messages;
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({
      runId: "run-approval",
      runStatus: "completed",
      content: [
        "已提出排版更新方案，请在下方审核后应用。",
        formatTerminalAgentRunContent(terminalResult),
      ].join("\n\n"),
    });
    expect(messages.at(-1)?.activityTrace?.map((item) => item.kind)).toEqual([
      "response",
      "response",
    ]);
    expect(store.findWaitingAgentRunId(sessionId, "thread-approval")).toBeUndefined();
  });

  it("reconciles synthetic approval responses with replayed run events before reload", async () => {
    const { store, databasePath, directory } = await createStore();
    const created = await store.createSession({ title: "Approval transcript" });
    const sessionId = created.activeSession!.session.id;
    const runId = "run-approval-transcript";
    store.conversationDatabase.beginRun({
      runId,
      sessionId,
      request: "apply layout",
    });
    store.conversationDatabase.appendRuntimeEvent(runId, "workflow_progress", {
      type: "workflow-progress",
      message: "正在准备排版更新",
    });
    store.conversationDatabase.appendRuntimeEvent(runId, "tool_started", {
      toolCallId: "call-layout",
      toolName: "SubmitCommands",
      message: "正在提交命令",
    });
    store.conversationDatabase.appendRuntimeEvent(runId, "tool_finished", {
      toolCallId: "call-layout",
      toolName: "SubmitCommands",
      message: "命令已提交",
      status: "completed",
    });

    await store.finalizeAgentRunMessage(sessionId, runId, {
      status: "approval-required",
      approval: {
        jobId: "job-approval-transcript",
        queryId: "query-approval-transcript",
        proposalId: "proposal-approval-transcript",
        threadId: "thread-approval-transcript",
        summary: "应用排版",
        commands: [],
      },
    });
    expect(
      store
        .getSession(sessionId)
        .messages.at(-1)
        ?.activityTrace?.map((item) => item.kind),
    ).toEqual(["step", "tool", "response"]);

    store.conversationDatabase.appendRuntimeEvent(runId, "workflow_progress", {
      type: "workflow-progress",
      message: "审批结果已处理",
    });
    await store.refreshAgentRunTrace(sessionId, runId);
    expect(
      store
        .getSession(sessionId)
        .messages.at(-1)
        ?.activityTrace?.map((item) => item.kind),
    ).toEqual(["step", "tool", "response", "step"]);

    const terminalResult = { status: "rejected" as const };
    await store.finalizeAgentRunMessage(sessionId, runId, terminalResult);
    store.conversationDatabase.finishRun({
      runId,
      status: "completed",
      result: terminalResult,
      threadId: "thread-approval-transcript",
    });

    const terminal = store.getSession(sessionId).messages.at(-1)!;
    const responseBlocks = terminal.activityTrace?.filter((item) => item.kind === "response") ?? [];
    let cursor = 0;
    for (const response of responseBlocks) {
      expect(response.start).toBe(cursor);
      expect(response.end).toBeGreaterThan(response.start);
      cursor = response.end;
    }
    expect(cursor).toBe(terminal.content.length);
    expect(responseBlocks.map((item) => getResponseBlockContent(item, terminal.content))).toEqual([
      "已提出排版更新方案，请在下方审核后应用。",
      `\n\n${formatTerminalAgentRunContent(terminalResult)}`,
    ]);
    expect(() => sessionChatMessageSchema.parse(terminal)).not.toThrow();

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new FileSessionStore(databasePath, join(directory, "projects"));
    stores.push(reopened);
    await reopened.initialize();

    const durable = reopened.getSession(sessionId).messages.at(-1)!;
    expect(durable).toEqual(terminal);
    expect(() => sessionChatMessageSchema.parse(durable)).not.toThrow();
  });

  it("persists SVG terminal copy without asking for a layout choice", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "SVG deck" });
    const sessionId = created.activeSession!.session.id;
    const terminalResult = {
      status: "completed" as const,
      presentation: created.activeSession!.presentation,
    };

    await store.finalizeAgentRunMessage(sessionId, "run-svg", terminalResult);

    expect(store.getSession(sessionId).messages.at(-1)?.content).toBe(
      formatTerminalAgentRunContent(terminalResult),
    );
    expect(store.getSession(sessionId).messages.at(-1)?.content).toContain(
      "已成功应用演示文稿更新",
    );
    expect(store.getSession(sessionId).messages.at(-1)?.content).not.toContain("请选择设计方向");
  });

  it("persists teammate reasoning and tools under the linked task activity", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Teammate trace" });
    const sessionId = created.activeSession!.session.id;
    store.conversationDatabase.beginRun({
      runId: "run-teammate",
      sessionId,
      request: "build outline",
    });
    const common = {
      teammateName: "task_worker",
      activityId: "task-outline",
      taskId: "task-outline",
    };
    store.conversationDatabase.appendRuntimeEvent("run-teammate", "workflow_progress", {
      ...common,
      type: "teammate-assignment-started",
      description: "Create outline",
    });
    store.conversationDatabase.appendRuntimeEvent("run-teammate", "reasoning_chunk", {
      ...common,
      type: "teammate-thinking-chunk",
      chunk: "Checking the brief.",
    });
    store.conversationDatabase.appendRuntimeEvent("run-teammate", "tool_started", {
      ...common,
      type: "teammate-tool-started",
      toolName: "WriteFile",
      message: "正在调用 WriteFile",
    });
    store.conversationDatabase.appendRuntimeEvent("run-teammate", "tool_finished", {
      ...common,
      type: "teammate-tool-finished",
      toolName: "WriteFile",
      message: "WriteFile 已完成",
      status: "completed",
    });
    store.conversationDatabase.appendRuntimeEvent("run-teammate", "workflow_progress", {
      ...common,
      type: "teammate-assignment-finished",
      status: "completed",
    });

    await store.finalizeAgentRunMessage(sessionId, "run-teammate", {
      status: "chat",
      message: "Worker finished.",
    });

    const task = store
      .getSession(sessionId)
      .messages.at(-1)
      ?.activityTrace?.find((item) => item.kind === "task");
    expect(task).toMatchObject({
      kind: "task",
      taskId: "task-outline",
      status: "completed",
      steps: [
        expect.objectContaining({ type: "reasoning", text: "Checking the brief." }),
        expect.objectContaining({ type: "tool", toolName: "WriteFile", status: "completed" }),
      ],
    });
  });

  it("replays the latest task graph snapshot into one durable trace item", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Task graph run" });
    const sessionId = created.activeSession!.session.id;
    const baseTask = {
      id: "task_1",
      revision: 0,
      subject: "Build slides",
      description: "",
      routing: { executionTarget: "lead" as const },
      completionPolicy: "direct" as const,
      owner: "agent",
      blocks: [],
      blockedBy: [],
      review: { state: "none" as const },
      reviewReceipts: [],
    };
    store.conversationDatabase.beginRun({
      runId: "run-task-graph",
      sessionId,
      request: "build",
    });
    store.conversationDatabase.appendRuntimeEvent("run-task-graph", "task_list_updated", {
      tasks: [{ ...baseTask, status: "in_progress" }],
      goal: "Build deck",
    });
    store.conversationDatabase.appendRuntimeEvent("run-task-graph", "task_list_updated", {
      tasks: [
        {
          ...baseTask,
          status: "completed",
          owner: undefined,
        },
      ],
      goal: "Build deck",
    });

    await store.finalizeAgentRunMessage(sessionId, "run-task-graph", {
      status: "chat",
      message: "Done.",
    });

    const assistant = store.getSession(sessionId).messages.at(-1)!;
    const taskLists = assistant.activityTrace?.filter((item) => item.kind === "tasklist") ?? [];
    expect(taskLists).toHaveLength(1);
    expect(taskLists[0]).toMatchObject({
      goal: "Build deck",
      tasks: [{ id: "task_1", status: "completed" }],
    });
  });

  it("persists task graph progress that arrives after the lead run completes", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Background task graph" });
    const sessionId = created.activeSession!.session.id;
    const task = {
      id: "task_background",
      revision: 0,
      subject: "Draft outline",
      description: "",
      status: "pending" as const,
      routing: { executionTarget: "teammate" as const },
      completionPolicy: "review_required" as const,
      blocks: [],
      blockedBy: [],
      review: { state: "none" as const },
      reviewReceipts: [],
    };
    store.conversationDatabase.beginRun({
      runId: "run-background",
      sessionId,
      request: "build",
    });
    store.conversationDatabase.appendRuntimeEvent("run-background", "task_list_updated", {
      tasks: [task],
      goal: "Build deck",
    });
    await store.finalizeAgentRunMessage(sessionId, "run-background", {
      status: "chat",
      message: "Teammate is working.",
    });
    const staleRendererMessages = store.getSession(sessionId).messages;

    store.conversationDatabase.appendRuntimeEvent("run-background", "task_list_updated", {
      tasks: [
        {
          ...task,
          status: "in_progress",
          owner: "task_worker",
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
      ],
      goal: "Build deck",
    });
    await store.refreshAgentRunTrace(sessionId, "run-background");
    await store.saveMessages(sessionId, staleRendererMessages);

    const assistant = store.getSession(sessionId).messages.at(-1)!;
    expect(assistant.activityTrace?.find((item) => item.kind === "tasklist")).toMatchObject({
      tasks: [{ id: "task_background", status: "in_progress", owner: "task_worker" }],
    });
    expect(assistant).toMatchObject({
      runId: "run-background",
      runStatus: "completed",
    });
  });

  it("persists every late teammate progress phase across close and reopen", async () => {
    const { store, databasePath, directory } = await createStore();
    const created = await store.createSession({ title: "Late teammate progress" });
    const sessionId = created.activeSession!.session.id;
    const runId = "run-late-teammate";
    const common = {
      teammateName: "layout_worker",
      activityId: "task-layout",
      taskId: "task-layout",
    };
    const leadResult = {
      status: "chat" as const,
      message: "Lead finished.",
      threadId: "thread-late-teammate",
    };
    store.conversationDatabase.beginRun({
      runId,
      sessionId,
      request: "build layout",
    });
    store.conversationDatabase.finishRun({
      runId,
      status: "completed",
      result: leadResult,
      threadId: leadResult.threadId,
    });
    await store.finalizeAgentRunMessage(sessionId, runId, leadResult);

    store.conversationDatabase.appendRuntimeEvent(runId, "workflow_progress", {
      ...common,
      type: "teammate-assignment-started",
      description: "Build layout",
    });
    await store.refreshAgentRunTrace(sessionId, runId);
    expect(store.getSession(sessionId).messages.at(-1)?.activityTrace).toContainEqual(
      expect.objectContaining({
        kind: "task",
        taskId: "task-layout",
        status: "running",
      }),
    );

    store.conversationDatabase.appendRuntimeEvent(runId, "reasoning_chunk", {
      ...common,
      type: "teammate-thinking-chunk",
      chunk: "Inspecting visual hierarchy.",
    });
    await store.refreshAgentRunTrace(sessionId, runId);
    expect(
      store
        .getSession(sessionId)
        .messages.at(-1)
        ?.activityTrace?.find((item) => item.kind === "task"),
    ).toMatchObject({
      steps: [
        expect.objectContaining({
          type: "reasoning",
          text: "Inspecting visual hierarchy.",
        }),
      ],
    });

    store.conversationDatabase.appendRuntimeEvent(runId, "tool_started", {
      ...common,
      type: "teammate-tool-started",
      toolName: "WriteFile",
      message: "正在调用 WriteFile",
    });
    await store.refreshAgentRunTrace(sessionId, runId);
    expect(
      store
        .getSession(sessionId)
        .messages.at(-1)
        ?.activityTrace?.find((item) => item.kind === "task"),
    ).toMatchObject({
      steps: [
        expect.objectContaining({ type: "reasoning" }),
        expect.objectContaining({ type: "tool", status: "running" }),
      ],
    });

    store.conversationDatabase.appendRuntimeEvent(runId, "tool_finished", {
      ...common,
      type: "teammate-tool-finished",
      toolName: "WriteFile",
      message: "WriteFile 已完成",
      status: "completed",
    });
    await store.refreshAgentRunTrace(sessionId, runId);
    expect(
      store
        .getSession(sessionId)
        .messages.at(-1)
        ?.activityTrace?.find((item) => item.kind === "task"),
    ).toMatchObject({
      steps: [
        expect.objectContaining({ type: "reasoning" }),
        expect.objectContaining({ type: "tool", status: "completed" }),
      ],
    });

    store.conversationDatabase.appendRuntimeEvent(runId, "workflow_progress", {
      ...common,
      type: "teammate-assignment-finished",
      status: "completed",
    });
    await store.refreshAgentRunTrace(sessionId, runId);

    const durableMessage = store.getSession(sessionId).messages.at(-1)!;
    expect(durableMessage).toMatchObject({
      runId,
      runStatus: "completed",
    });
    expect(durableMessage.activityTrace?.find((item) => item.kind === "task")).toMatchObject({
      taskId: "task-layout",
      status: "completed",
      steps: [
        expect.objectContaining({
          type: "reasoning",
          text: "Inspecting visual hierarchy.",
        }),
        expect.objectContaining({
          type: "tool",
          toolName: "WriteFile",
          status: "completed",
        }),
      ],
    });

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new FileSessionStore(databasePath, join(directory, "projects"));
    stores.push(reopened);
    await reopened.initialize();
    expect(reopened.getSession(sessionId).messages.at(-1)).toEqual(durableMessage);
  });

  it("marks an unfinished operation as failed instead of completed", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Failed run" });
    const sessionId = created.activeSession!.session.id;
    await store.saveMessages(sessionId, [{ id: "u1", role: "user", content: "inspect" }]);
    store.conversationDatabase.beginRun({
      runId: "run-failed",
      sessionId,
      request: "inspect",
    });
    store.conversationDatabase.appendRuntimeEvent("run-failed", "tool_started", {
      toolCallId: "call-read",
      toolName: "ReadPresentationSnapshot",
      message: "正在调用工具 ReadPresentationSnapshot...",
    });

    await store.finalizeAgentRunMessage(sessionId, "run-failed", {
      status: "failed",
      error: "unexpected tool error",
    });

    const assistant = store.getSession(sessionId).messages.at(-1)!;
    const tool = assistant.activityTrace?.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({
      kind: "tool",
      toolCallId: "call-read",
      status: "failed",
    });
    expect(assistant.content).not.toContain("unexpected tool error");
    expect(assistant).toMatchObject({
      runId: "run-failed",
      runStatus: "failed",
      runError: "处理请求时遇到问题，请稍后重试。",
    });
  });

  it("persists explicit interruption without reading display copy", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Interrupted run" });
    const sessionId = created.activeSession!.session.id;
    store.conversationDatabase.beginRun({
      runId: "run-interrupted",
      sessionId,
      request: "build",
    });
    store.conversationDatabase.appendRuntimeEvent("run-interrupted", "text_chunk", {
      type: "text-chunk",
      chunk: "已完成部分页面",
    });

    await store.finalizeAgentRunMessage(sessionId, "run-interrupted", {
      status: "interrupted",
    });

    expect(store.getSession(sessionId).messages.at(-1)).toMatchObject({
      content: "已完成部分页面",
      runStatus: "interrupted",
      runError: undefined,
    });
  });

  it("stamps runDurationMs from runStartedAt on finalize", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Timed run" });
    const sessionId = created.activeSession!.session.id;
    const runStartedAt = Date.now() - 4_200;
    await store.saveMessages(sessionId, [
      { id: "u1", role: "user", content: "go" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        runId: "run-timed",
        runStatus: "running",
        runStartedAt,
      },
    ]);
    store.conversationDatabase.beginRun({
      runId: "run-timed",
      sessionId,
      request: "go",
    });
    store.conversationDatabase.appendRuntimeEvent("run-timed", "text_chunk", {
      type: "text-chunk",
      chunk: "完成",
    });

    await store.finalizeAgentRunMessage(sessionId, "run-timed", {
      status: "chat",
      message: "完成",
    });

    const assistant = store.getSession(sessionId).messages.at(-1)!;
    expect(assistant.runStartedAt).toBe(runStartedAt);
    expect(assistant.runDurationMs).toBeGreaterThanOrEqual(4_200);
    expect(assistant.runDurationMs).toBeLessThan(60_000);
  });

  it("preserves authoritative runDurationMs when renderer saveMessages races finalize", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Duration merge" });
    const sessionId = created.activeSession!.session.id;
    const runStartedAt = Date.now() - 3_000;
    await store.saveMessages(sessionId, [
      { id: "u1", role: "user", content: "go" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        runId: "run-merge",
        runStatus: "running",
        runStartedAt,
      },
    ]);
    store.conversationDatabase.beginRun({
      runId: "run-merge",
      sessionId,
      request: "go",
    });
    store.conversationDatabase.appendRuntimeEvent("run-merge", "text_chunk", {
      type: "text-chunk",
      chunk: "好的",
    });
    await store.finalizeAgentRunMessage(sessionId, "run-merge", {
      status: "chat",
      message: "好的",
    });
    const finalized = store.getSession(sessionId).messages.at(-1)!;
    expect(finalized.runDurationMs).toBeDefined();

    await store.saveMessages(sessionId, [
      { id: "u1", role: "user", content: "go" },
      {
        id: "a1",
        role: "assistant",
        content: "好的",
        activityTrace: [
          {
            id: "response-1",
            kind: "response",
            start: 0,
            end: 2,
          },
        ],
        runId: "run-merge",
        runStatus: "completed",
        runStartedAt,
        // Renderer forgot duration after remount of local state
      },
    ]);

    expect(store.getSession(sessionId).messages.at(-1)).toMatchObject({
      runStartedAt,
      runDurationMs: finalized.runDurationMs,
      runStatus: "completed",
    });
  });

  it("replays tool approval request and resolution into the durable trace", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Tool approval" });
    const sessionId = created.activeSession!.session.id;
    store.conversationDatabase.beginRun({
      runId: "run-approval",
      sessionId,
      request: "export",
    });
    store.conversationDatabase.appendRuntimeEvent("run-approval", "approval_requested", {
      type: "tool-approval-waiting",
      approvalId: "approval-1",
      toolName: "ExportPptx",
      reason: "写入导出文件",
      detail: "输出到项目目录",
    });
    store.conversationDatabase.appendRuntimeEvent("run-approval", "approval_resolved", {
      type: "tool-approval-resolved",
      approvalId: "approval-1",
      toolName: "ExportPptx",
      status: "approved",
      message: "工具授权已确认",
    });

    await store.finalizeAgentRunMessage(sessionId, "run-approval", {
      status: "chat",
      message: "导出完成",
    });

    const message = store.getSession(sessionId).messages.at(-1)!;
    expect(message.activityTrace?.map((item) => item.kind)).toEqual(["tool-approval", "response"]);
    expect(message.activityTrace?.[0]).toEqual(
      expect.objectContaining({
        kind: "tool-approval",
        approvalId: "approval-1",
        status: "approved",
      }),
    );
    const response = message.activityTrace?.find((item) => item.kind === "response");
    expect(response && getResponseBlockContent(response, message.content)).toBe("导出完成");
  });

  it("keeps renderer tools when finalize projection is incomplete then session is reselected", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Interrupt tools" });
    const sessionId = created.activeSession!.session.id;
    const runId = "run-interrupt-tools";

    store.conversationDatabase.beginRun({
      runId,
      sessionId,
      request: "build",
    });
    store.conversationDatabase.appendRuntimeEvent(runId, "text_chunk", {
      type: "text-chunk",
      attemptId: "attempt-1",
      chunk: "正在处理",
    });
    // Only one tool landed in durable events; the renderer also saw a second tool.
    store.conversationDatabase.appendRuntimeEvent(runId, "tool_started", {
      type: "tool-state",
      toolCallId: "call-read",
      toolName: "ReadPresentationSnapshot",
      status: "running",
      message: "reading",
    });
    store.conversationDatabase.appendRuntimeEvent(runId, "tool_finished", {
      type: "tool-state",
      toolCallId: "call-read",
      toolName: "ReadPresentationSnapshot",
      status: "denied",
      message: "cancelled",
    });

    await store.saveMessages(sessionId, [
      {
        id: "a-interrupt-tools",
        role: "assistant",
        content: "正在处理",
        runId,
        runStatus: "running",
        activityTrace: [
          {
            id: "response-1",
            kind: "response",
            start: 0,
            end: 4,
            attemptId: "attempt-1",
            streaming: false,
          },
          {
            id: "tool-read",
            kind: "tool",
            toolCallId: "call-read",
            toolName: "ReadPresentationSnapshot",
            status: "running",
          },
          {
            id: "tool-write",
            kind: "tool",
            toolCallId: "call-write",
            toolName: "WriteFile",
            status: "running",
          },
        ],
      },
    ]);

    await store.finalizeAgentRunMessage(sessionId, runId, {
      status: "interrupted",
      threadId: "thread-interrupt-tools",
    });

    const afterFinalize = store.getSession(sessionId).messages.at(-1)!;
    expect(afterFinalize.runStatus).toBe("interrupted");
    expect(afterFinalize.activityTrace?.filter((item) => item.kind === "tool")).toEqual([
      expect.objectContaining({ toolCallId: "call-read", status: "denied" }),
      expect.objectContaining({ toolCallId: "call-write", status: "denied" }),
    ]);

    // Renderer saves an interrupted message whose process trace is thinner than
    // main's — equal status must not wipe tools that only main retained, and
    // must still fold renderer-only tools when main is the thin side.
    await store.saveMessages(sessionId, [
      {
        ...afterFinalize,
        activityTrace: [
          {
            id: "response-1",
            kind: "response",
            start: 0,
            end: 4,
            attemptId: "attempt-1",
            streaming: false,
          },
          {
            id: "tool-read",
            kind: "tool",
            toolCallId: "call-read",
            toolName: "ReadPresentationSnapshot",
            status: "denied",
          },
          {
            id: "tool-extra",
            kind: "tool",
            toolCallId: "call-extra",
            toolName: "AskUserQuestion",
            status: "denied",
          },
        ],
      },
    ]);

    const afterSave = store.getSession(sessionId).messages.at(-1)!;
    const toolIds = afterSave.activityTrace
      ?.filter((item) => item.kind === "tool")
      .map((item) => item.toolCallId)
      .sort();
    expect(toolIds).toEqual(["call-extra", "call-read", "call-write"]);

    const other = await store.createSession({ title: "Other" });
    await store.selectSession(other.activeSession!.session.id);
    const restored = await store.selectSession(sessionId);
    const selected = restored.activeSession!.messages.at(-1)!;
    expect(
      selected.activityTrace
        ?.filter((item) => item.kind === "tool")
        .map((item) => item.toolCallId)
        .sort(),
    ).toEqual(["call-extra", "call-read", "call-write"]);
  });

  it("repairs a thin interrupted trace from conversation events on selectSession", async () => {
    const { store } = await createStore();
    const created = await store.createSession({ title: "Thin repair" });
    const sessionId = created.activeSession!.session.id;
    const runId = "run-thin-repair";

    store.conversationDatabase.beginRun({
      runId,
      sessionId,
      request: "build",
    });
    store.conversationDatabase.appendRuntimeEvent(runId, "tool_started", {
      type: "tool-state",
      toolCallId: "call-export",
      toolName: "ExportPptx",
      status: "running",
      message: "exporting",
    });
    store.conversationDatabase.appendRuntimeEvent(runId, "tool_finished", {
      type: "tool-state",
      toolCallId: "call-export",
      toolName: "ExportPptx",
      status: "denied",
      message: "cancelled",
    });
    store.conversationDatabase.appendRuntimeEvent(runId, "text_chunk", {
      type: "text-chunk",
      chunk: "已中断",
    });

    // Simulate a historically broken persist: terminal status + response only.
    await store.saveMessages(sessionId, [
      {
        id: "a-thin",
        role: "assistant",
        content: "已中断",
        runId,
        runStatus: "interrupted",
        activityTrace: [
          {
            id: "response-thin",
            kind: "response",
            start: 0,
            end: 3,
            streaming: false,
          },
        ],
      },
    ]);

    expect(
      store
        .getSession(sessionId)
        .messages.at(-1)
        ?.activityTrace?.some((item) => item.kind === "tool"),
    ).toBe(false);

    const restored = await store.selectSession(sessionId);
    const message = restored.activeSession!.messages.at(-1)!;
    expect(message.activityTrace?.map((item) => item.kind)).toEqual(["tool", "response"]);
    expect(message.activityTrace?.[0]).toMatchObject({
      kind: "tool",
      toolCallId: "call-export",
      status: "denied",
    });
  });
});
