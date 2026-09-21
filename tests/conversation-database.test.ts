import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationDatabase } from "@main/conversation-database";
import { createMinimalSvgMarkup, createSvgVisualSource } from "@shared/presentation-fixtures";
import { createSessionPresentation, type SessionSnapshot } from "@shared/session";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

function createDatabase() {
  const directoryPromise = mkdtemp(join(tmpdir(), "agent-ppt-sqlite-"));
  return directoryPromise.then((directory) => {
    temporaryDirectories.push(directory);
    return new ConversationDatabase(join(directory, "conversations.sqlite"));
  });
}

function snapshot(id: string): SessionSnapshot {
  const now = new Date().toISOString();
  const presentation = createSessionPresentation("SQLite session");
  return {
    session: {
      id,
      title: presentation.title,
      createdAt: now,
      updatedAt: now,
      slideCount: 0,
      revision: 0,
    },
    presentation,
    messages: [
      { id: "u1", role: "user", content: "build a deck" },
      { id: "a1", role: "assistant", content: "working", threadId: "run-1" },
    ],
    displayCards: [],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ConversationDatabase", () => {
  it.each(["completed", "failed", "interrupted"] as const)(
    "recovers a lease whose owner is %s without losing the checkpoint",
    async (status) => {
      const database = await createDatabase();
      try {
        database.replaceState({ activeSessionId: "s1", sessions: [snapshot("s1")] });
        database.beginRun({ runId: "old", sessionId: "s1", threadId: "thread" });
        const lease = database.openRunCheckpointLease({
          threadId: "thread",
          runId: "old",
          resume: false,
        });
        if (lease.type !== "opened") throw new Error("Expected lease");
        expect(
          database.openRunCheckpointLease({ threadId: "thread", runId: "new", resume: false }),
        ).toMatchObject({ type: "lease_busy", activeRunId: "old" });
        const checkpoint = { durable: "preserved" };
        database.saveRunCheckpointCas({
          threadId: "thread",
          runId: "old",
          generation: lease.generation,
          expectedRevision: 0,
          nextRevision: 1,
          checkpoint,
        });
        database.finishRun({ runId: "old", status });
        const next = database.openRunCheckpointLease({
          threadId: "thread",
          runId: "new",
          resume: true,
        });
        expect(next).toMatchObject({
          type: "opened",
          generation: lease.generation + 1,
          checkpoint,
        });
        expect(
          database.saveRunCheckpointCas({
            threadId: "thread",
            runId: "old",
            generation: lease.generation,
            expectedRevision: 1,
            nextRevision: 2,
            checkpoint: {},
          }),
        ).toBe("stale_generation");
        expect(
          database.closeRunCheckpointLease({
            threadId: "thread",
            runId: "old",
            generation: lease.generation,
          }),
        ).toBe(false);
      } finally {
        database.close();
      }
    },
  );

  it("stores sessions and messages without workspace transcripts", async () => {
    const database = await createDatabase();
    const session = snapshot("s1");
    session.displayCards = [
      {
        event: {
          protocolVersion: 1,
          eventId: "question-1",
          emittedAt: "2026-07-15T00:00:00.000Z",
          kind: "interaction.question-requested",
          category: "interaction",
          source: { kind: "tool", toolName: "AskUser" },
          scope: { sessionId: "s1", threadId: "thread-1", anchorMessageId: "a1" },
          semantics: { blocking: true, requiresResponse: true, priority: "high" },
          payload: {
            message: "请选择",
            question: { variant: "markdown", selectionMode: "single" },
          },
        },
        status: "active",
        receivedAt: 1,
      },
    ];
    database.replaceState({ activeSessionId: "s1", sessions: [session] });

    const restored = database.loadState();
    expect(restored.activeSessionId).toBe("s1");
    expect(restored.sessions[0].messages.map((message) => message.content)).toEqual([
      "build a deck",
      "working",
    ]);
    expect(restored.sessions[0].displayCards[0]?.event.eventId).toBe("question-1");
    database.close();
  });

  it("repairs duplicate legacy slide ids and migrates element slides to SVG-only", async () => {
    const database = await createDatabase();
    const legacy = snapshot("legacy");
    const markup = createMinimalSvgMarkup("First slide");
    const visualSource = createSvgVisualSource({ markup, sourcePath: "slides/P01.svg" });
    legacy.session.slideCount = 2;
    legacy.presentation.slides = [
      {
        id: "slide-1",
        title: "First slide",
        visualSource,
        elements: [
          {
            id: "element-1",
            type: "text",
            x: 10,
            y: 10,
            width: 200,
            height: 40,
            text: "Legacy element",
            fontSize: 20,
          },
        ],
        layout: "concept",
      },
      {
        id: "slide-1",
        title: "Second slide",
        elements: [],
        layout: "cover",
      },
    ] as unknown as typeof legacy.presentation.slides;
    database.replaceState({ activeSessionId: "legacy", sessions: [legacy] });

    const restored = database.loadState().sessions[0].presentation;
    expect(restored.slides).toHaveLength(1);
    expect(restored.slides[0]).toMatchObject({
      id: "slide-1",
      title: "First slide",
    });
    expect(restored.slides[0].visualSource.kind).toBe("svg");
    expect(restored.slides[0]).not.toHaveProperty("elements");
    expect(restored.slides[0]).not.toHaveProperty("layout");
    database.close();
  });

  it("records the complete ordered run event chain", async () => {
    const database = await createDatabase();
    database.replaceState({ activeSessionId: "s1", sessions: [snapshot("s1")] });
    database.beginRun({
      runId: "run-1",
      sessionId: "s1",
      provider: "anthropic",
      model: "test-model",
      request: "build a deck",
    });
    database.appendRuntimeEvent("run-1", "reasoning_chunk", { chunk: "inspect" });
    database.appendRuntimeEvent("run-1", "tool_call", {
      toolUseId: "tool-1",
      toolName: "ReadPresentationSnapshot",
      input: {},
    });
    database.appendRuntimeEvent("run-1", "tool_result", {
      toolUseId: "tool-1",
      content: [{ type: "text", text: "empty deck" }],
    });
    expect(database.loadTerminalRunResult("run-1")).toBeUndefined();
    database.finishRun({
      runId: "run-1",
      status: "completed",
      result: { status: "chat", message: "done" },
    });

    const events = database.listRunEvents("run-1");
    expect(events.map((event) => event.kind)).toEqual([
      "run_started",
      "user_message",
      "assistant_started",
      "reasoning_chunk",
      "tool_call",
      "tool_result",
      "run_completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(database.loadTerminalRunResult("run-1")).toEqual({
      status: "chat",
      message: "done",
    });
    database.close();
  });

  it("binds one QueryId across resume attempts without reusing run or thread identity", async () => {
    const database = await createDatabase();
    database.replaceState({ activeSessionId: "s1", sessions: [snapshot("s1")] });
    database.beginRun({
      runId: "run-1",
      sessionId: "s1",
      threadId: "thread-1",
      request: "start",
    });
    database.bindRunQueryId("run-1", "query-1");
    database.beginRun({
      runId: "run-2",
      sessionId: "s1",
      threadId: "thread-1",
      request: "continue",
    });
    database.bindRunQueryId("run-2", "query-1");

    expect(database.getRunQueryId("run-1")).toBe("query-1");
    expect(database.getRunQueryId("run-2")).toBe("query-1");
    expect(database.listRunEvents("run-1").at(-1)).toMatchObject({
      kind: "query_started",
      payload: { queryId: "query-1" },
    });
    expect(() => database.bindRunQueryId("run-2", "run-2")).toThrow("QueryId must be distinct");
    expect(() => database.bindRunQueryId("run-2", "thread-1")).toThrow("QueryId must be distinct");
    database.close();
  });

  it("stores checkpoints and compacted model context separately", async () => {
    const database = await createDatabase();
    database.replaceState({ activeSessionId: "s1", sessions: [snapshot("s1")] });
    database.beginRun({ runId: "run-1", sessionId: "s1", request: "continue" });
    database.saveRunCheckpoint("thread-1", { phase: "tool_running" }, "run-1");
    database.saveServiceThread("thread-1", { status: "active" });
    const compacted = database.saveContextSnapshotForRun(
      "run-1",
      { messages: [{ role: "user", content: "summary" }] },
      ["L4 compact_history"],
    );

    expect(database.loadRunCheckpoint("thread-1")).toEqual({ phase: "tool_running" });
    expect(database.loadServiceThread("thread-1")).toEqual({ status: "active" });
    expect(compacted?.summary).toContain("compact_history");
    expect(database.latestContextSnapshot("s1")?.modelContext).toEqual({
      messages: [{ role: "user", content: "summary" }],
    });
    database.close();
  });
});
