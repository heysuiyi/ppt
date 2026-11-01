import { createLogs, type LogRecord } from "@agent-harness/logs/logs";
import { describe, expect, it } from "vitest";
import { contextualLogger, getLogContext, withLogContext } from "../app/main/logging/log-context";

function createCapture() {
  const records: LogRecord[] = [];
  const logs = createLogs({
    outputs: [
      {
        id: "capture",
        minimumLevel: "debug",
        exporter: {
          export: (record) => {
            records.push(record);
          },
          async close() {},
        },
      },
    ],
  });
  return { records, logs, logger: contextualLogger(logs.getLogger("desktop")) };
}

describe("desktop diagnostic context", () => {
  it("isolates overlapping activations and shares the authoritative nested context with archives", async () => {
    const { records, logs, logger } = createCapture();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    try {
      const a = withLogContext({ sessionId: "s-a", runId: "r-a" }, async () => {
        first.resolve();
        await second.promise;
        withLogContext({ queryId: "q-a" }, () => {
          logger.warn("run.a", { runId: "untrusted" });
          expect(getLogContext()).toEqual({ sessionId: "s-a", runId: "r-a", queryId: "q-a" });
        });
        expect(getLogContext()).toEqual({ sessionId: "s-a", runId: "r-a" });
      });
      const b = withLogContext({ sessionId: "s-b", runId: "r-b" }, async () => {
        await first.promise;
        logger.warn("run.b");
        second.resolve();
      });
      await Promise.all([a, b]);
      expect(records.map(({ event, context }) => ({ event, context }))).toEqual([
        { event: "run.b", context: { sessionId: "s-b", runId: "r-b" } },
        { event: "run.a", context: { sessionId: "s-a", runId: "r-a", queryId: "q-a" } },
      ]);
      expect(records[1].data).toEqual({ runId: "untrusted" });
      expect(getLogContext()).toEqual({});
    } finally {
      await logs.close();
    }
  });

  it("snapshots explicit child identity and gives it precedence over ambient context", async () => {
    const { records, logs, logger } = createCapture();
    const context = { runId: "bound-run" };
    const bound = logger.child(context).child({ runId: undefined, queryId: "bound-query" });
    context.runId = "mutated-run";
    try {
      withLogContext({ sessionId: "ambient-session", runId: "ambient-run" }, () => {
        bound.info("child.observed");
      });
      expect(records[0].context).toEqual({
        sessionId: "ambient-session",
        runId: "bound-run",
        queryId: "bound-query",
      });
    } finally {
      await logs.close();
    }
  });
});
