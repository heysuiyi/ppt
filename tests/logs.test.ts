import { describe, expect, it } from "vitest";
import { createLogs, type LogExporter, type LogRecord } from "../src/logs/logs";

function capture(records: LogRecord[]): LogExporter {
  return {
    export(record) {
      records.push(record);
    },
    async close() {},
  };
}

function deferred() {
  return Promise.withResolvers<void>();
}

describe("independent logs", () => {
  it("filters per output before inspecting input and preserves accepted record order", async () => {
    const details: LogRecord[] = [];
    const warnings: LogRecord[] = [];
    const logs = createLogs({
      outputs: [
        { id: "details", minimumLevel: "info", exporter: capture(details) },
        { id: "warnings", minimumLevel: "warn", exporter: capture(warnings) },
      ],
    });
    const logger = logs.getLogger("runtime");
    let inspections = 0;
    const ignored = new Proxy(
      {},
      {
        ownKeys() {
          inspections++;
          throw new Error("Filtered input must not be inspected");
        },
      },
    );
    logger.debug("run.detail", ignored);
    logger.info("run.started");
    logger.warn("run.interrupted");

    expect(logger.isEnabled("debug")).toBe(false);
    expect(logger.isEnabled("info")).toBe(true);
    expect(inspections).toBe(0);
    expect(details.map(({ event, sequence }) => [event, sequence])).toEqual([
      ["run.started", 1],
      ["run.interrupted", 2],
    ]);
    expect(warnings.map(({ event, sequence }) => [event, sequence])).toEqual([
      ["run.interrupted", 2],
    ]);
    expect(details[1].instanceId).toBe(warnings[0].instanceId);
    await logs.close();
  });

  it("isolates concurrent child contexts and binds a resumed activation to its new run", async () => {
    const records: LogRecord[] = [];
    const logs = createLogs({
      outputs: [{ id: "memory", minimumLevel: "info", exporter: capture(records) }],
    });
    const thread = logs
      .getLogger("agent.runtime")
      .child({ agentId: "a", threadId: "t", queryId: "q" });
    const first = thread.child({ runId: "r1" });
    const resumed = thread.child({ runId: "r2", queryId: undefined });
    await Promise.all([
      Promise.resolve().then(() => first.info("run.waiting", { runId: "untrusted" })),
      Promise.resolve().then(() => resumed.info("tool.completed", { status: "applied" })),
    ]);
    thread.info("thread.observed");
    expect(records.map(({ context }) => context)).toEqual([
      { agentId: "a", threadId: "t", queryId: "q", runId: "r1" },
      { agentId: "a", threadId: "t", queryId: "q", runId: "r2" },
      { agentId: "a", threadId: "t", queryId: "q" },
    ]);
    expect(records[0].data).toEqual({ runId: "untrusted" });
    await logs.close();
  });

  it("keeps exporter failure separate from other outputs and retains its failure history", async () => {
    const records: LogRecord[] = [];
    let failing = true;
    const logs = createLogs({
      outputs: [
        {
          id: "disk",
          minimumLevel: "info",
          exporter: {
            export() {
              if (failing) throw new Error("private SDK details");
            },
            async close() {},
          },
        },
        { id: "recent", minimumLevel: "info", exporter: capture(records) },
      ],
    });
    const logger = logs.getLogger("runtime");
    logger.error("request.failed", { code: "MODEL_FAILED" });
    failing = false;
    logger.info("request.completed");
    expect(records.map(({ event }) => event)).toEqual(["request.failed", "request.completed"]);
    const status = logs.getStatus();
    expect(status.outputs).toEqual([
      {
        id: "disk",
        failureCount: 1,
        lastFailure: { timestamp: expect.any(String), operation: "export" },
      },
      { id: "recent", failureCount: 0 },
    ]);
    expect(JSON.stringify(status)).not.toContain("private SDK details");
    await logs.close();
  });

  it("stops acceptance before close settles and attempts all outputs despite close failures", async () => {
    const records: LogRecord[] = [];
    const release = deferred();
    const closed: string[] = [];
    const logs = createLogs({
      outputs: [
        {
          id: "first",
          minimumLevel: "info",
          exporter: {
            export(record) {
              records.push(record);
            },
            async close() {
              closed.push("first");
              await release.promise;
              throw new Error("cannot close first");
            },
          },
        },
        {
          id: "second",
          minimumLevel: "info",
          exporter: {
            export() {},
            async close() {
              closed.push("second");
            },
          },
        },
      ],
    });
    const logger = logs.getLogger("runtime");
    logger.info("run.completed");
    const closing = logs.close();
    const rejected = expect(closing).rejects.toBeInstanceOf(AggregateError);
    expect(logs.close()).toBe(closing);
    expect(logs.getStatus().state).toBe("closing");
    logger.info("late.during-close");
    expect(logger.isEnabled("error")).toBe(false);
    release.resolve();
    await rejected;
    logger.error("late.after-close");
    expect(closed).toEqual(["first", "second"]);
    expect(records.map(({ event }) => event)).toEqual(["run.completed"]);
    expect(logs.getStatus()).toMatchObject({
      state: "closed",
      lateWriteCount: 2,
      outputs: [
        { id: "first", failureCount: 1, lastFailure: { operation: "close" } },
        { id: "second", failureCount: 0 },
      ],
    });
    expect(logs.close()).toBe(closing);
  });

  it("rejects ambiguous ownership without closing resources supplied by the caller", () => {
    let closed = 0;
    const exporter: LogExporter = {
      export() {},
      async close() {
        closed++;
      },
    };
    expect(() => createLogs({ outputs: [] })).toThrow(TypeError);
    expect(() =>
      createLogs({
        outputs: [
          { id: "same", minimumLevel: "info", exporter },
          { id: "same", minimumLevel: "info", exporter: capture([]) },
        ],
      }),
    ).toThrow(TypeError);
    expect(() =>
      createLogs({
        outputs: [
          { id: "one", minimumLevel: "info", exporter },
          { id: "two", minimumLevel: "info", exporter },
        ],
      }),
    ).toThrow(TypeError);
    expect(closed).toBe(0);
  });

  it("rejects asynchronous exporters instead of treating them as synchronous delivery", () => {
    expect(() =>
      createLogs({
        outputs: [
          {
            id: "async",
            minimumLevel: "info",
            exporter: {
              async export() {
                throw new Error("must not start");
              },
              async close() {},
            },
          },
        ],
      }),
    ).toThrow(TypeError);
  });
});
