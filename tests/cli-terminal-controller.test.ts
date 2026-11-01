import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AgentRunHandle, AgentRunResult } from "@agent-harness/core/agent-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import type { RunIdentity } from "@agent-harness/core/protocol-values";
import type { RuntimeEvent } from "@agent-harness/core/session/session-events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTerminalArguments } from "../cli/commands/terminal-command.js";
import type { TerminalHost } from "../cli/host/host-contract.js";
import { runTerminalController } from "../cli/terminal/terminal-controller.js";

const identity: RunIdentity = {
  agentId: "agent",
  threadId: "thread",
  queryId: "query",
  runId: "run",
};
const finishedResult: AgentRunResult = {
  status: "completed",
  identity,
  output: [{ role: "assistant", content: [{ type: "text", text: "authoritative answer" }] }],
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0)) close();
});

function handle(
  result: Promise<AgentRunResult>,
  events: readonly RuntimeEvent[] = [],
  cancel: () => void = () => {},
): AgentRunHandle {
  return {
    identity,
    completed: result,
    cancel,
    events: {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    },
  };
}
function host(overrides: Partial<TerminalHost>): TerminalHost {
  const unsupported = async (): Promise<never> => {
    throw new Error("Unexpected test operation");
  };
  return {
    context: {
      dataRoot: "test-data",
      workspaceRoot: "workspace",
      threadId: "thread",
      model: { id: "model", label: "Controlled model" },
      toolsMode: "none",
    },
    open: async () => {},
    close: async () => {},
    models: unsupported,
    sessions: unsupported,
    newSession: unsupported,
    selectSession: unsupported,
    run: unsupported,
    resume: unsupported,
    describeInteraction: () => ({
      support: "supported",
      summary: "Controlled permission",
      confirmation: "explicit-choice",
      choices: [{ id: "allow", label: "Allow", responseType: "answer" }],
    }),
    answerInteraction: (request, choice) => {
      if (choice !== "allow") throw new AgentError("BAD_CHOICE", "Invalid choice");
      return { interactionId: request.id, type: "answer", value: true };
    },
    ...overrides,
  };
}
function surface(interactive = false) {
  vi.stubEnv("TERM", "dumb");
  class Input extends PassThrough {
    isTTY = interactive;
    isRaw = false;
    setRawMode(raw: boolean) {
      this.isRaw = raw;
    }
  }
  const input = new Input();
  const output = new PassThrough();
  const error = Object.assign(new PassThrough(), { isTTY: interactive, columns: 80, rows: 24 });
  cleanup.push(() => {
    input.destroy();
    output.destroy();
    error.destroy();
  });
  let stdout = "";
  let stderr = "";
  const pending: Array<{ text: string; resolve: () => void }> = [];
  const changed = () => {
    for (const item of [...pending])
      if ((stdout + stderr).includes(item.text)) {
        pending.splice(pending.indexOf(item), 1);
        item.resolve();
      }
  };
  const writeOutput = async (text: string) => {
    stdout += text;
    changed();
  };
  const writeError = async (text: string) => {
    stderr += text;
    changed();
  };
  return {
    input,
    output,
    error,
    writeOutput,
    writeError,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    until(text: string) {
      const gate = Promise.withResolvers<void>();
      pending.push({ text, resolve: gate.resolve });
      changed();
      return gate.promise;
    },
  };
}

describe("terminal controller result and lifecycle", () => {
  it("does not publish success when resource close fails after an authoritative result", async () => {
    const io = surface();
    const code = await runTerminalController({
      ...io,
      command: parseTerminalArguments(["--prompt", "task", "--output", "jsonl"]),
      host: host({
        run: async () => handle(Promise.resolve(finishedResult)),
        close: async () => {
          throw new AgentError("HOST_CLOSE_FAILED", "Resource close failed");
        },
      }),
    });
    expect(code).toBe(1);
    const records = io.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(records.find((record) => record.type === "query.result")).toMatchObject({
      status: "completed",
    });
    expect(records.at(-1)).toMatchObject({
      type: "process.finished",
      exitCode: 1,
      reason: "failure",
      stage: "close",
      lastRun: { identity, status: "completed" },
    });
    expect(records.filter((record) => record.type === "process.finished")).toHaveLength(1);
  });

  it("a completed fact cannot replace a rejected completion promise or leak a plain SDK error", async () => {
    const io = surface();
    const completion = Promise.withResolvers<AgentRunResult>();
    const run = handle(completion.promise, [{ kind: "fact", type: "run.completed", identity }]);
    const running = runTerminalController({
      ...io,
      command: parseTerminalArguments(["--prompt", "task", "--output", "jsonl"]),
      host: host({ run: async () => run }),
    });
    await io.until('"phase":"run.completed"');
    completion.reject({ code: "SDK_RAW", message: "PRIVATE_KEY_SENTINEL" });
    expect(await running).toBe(1);
    const records = io.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(
      records.some(
        (record) => record.type === "assistant.message" || record.type === "query.result",
      ),
    ).toBe(false);
    expect(records.at(-1)).toMatchObject({
      type: "process.finished",
      exitCode: 1,
      lastRun: { identity },
    });
    expect(records.at(-1).lastRun).not.toHaveProperty("status");
    expect(io.stdout + io.stderr).not.toContain("PRIVATE_KEY_SENTINEL");
  });

  it("keeps draft submission disabled during an asynchronous session transition", async () => {
    const io = surface(true);
    const switching = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let queries = 0;
    const running = runTerminalController({
      ...io,
      command: parseTerminalArguments([]),
      host: host({
        newSession: async () => {
          entered.resolve();
          await switching.promise;
        },
        run: async () => {
          queries++;
          return handle(Promise.resolve(finishedResult));
        },
      }),
    });
    await io.until("Session: thread");
    await nextTurn();
    io.input.write("/new\r\r");
    await io.until("yes");
    io.input.write("yes\r");
    await entered.promise;
    io.input.write("draft-survives-switch\r");
    await nextTurn();
    expect(queries).toBe(0);
    switching.resolve();
    await nextTurn();
    io.input.write("\r");
    await io.until("authoritative answer");
    await nextTurn();
    io.input.write("\x04");
    expect(await running).toBe(0);
    expect(queries).toBe(1);
    expect(io.input.isRaw).toBe(false);
  });

  it("preserves SIGTERM exit status while a confirmation prompt closes", async () => {
    const io = surface(true);
    const previousListeners = new Set(process.listeners("SIGTERM"));
    let closed = false;
    const closingHost = host({
      close: async () => {
        closed = true;
      },
    });
    const context = closingHost.context;
    Object.defineProperty(closingHost, "context", {
      get: () => {
        if (closed) throw new AgentError("HOST_CLOSED", "Host is closed");
        return context;
      },
    });
    const running = runTerminalController({
      ...io,
      command: parseTerminalArguments([]),
      host: closingHost,
    });
    await io.until("Session: thread");
    await nextTurn();
    io.input.write("/new\r\r");
    await io.until("yes");
    for (const listener of process.listeners("SIGTERM")) {
      if (!previousListeners.has(listener)) listener("SIGTERM");
    }
    expect(await running).toBe(143);
    expect(io.stderr).not.toContain("HOST_CLOSED");
    expect(io.input.isRaw).toBe(false);
  });

  it.each(["answer", "cancel"] as const)(
    "preserves cancellation while a new Run is submitting %s",
    async (responseType) => {
      const io = surface(true);
      const interaction = {
        id: "permission-id",
        owner: "host",
        payload: { type: "approval", version: 1, data: null },
      };
      const waiting: AgentRunResult = { status: "waiting", identity, interaction };
      const entered = Promise.withResolvers<void>();
      const activation = Promise.withResolvers<AgentRunHandle>();
      const completed = Promise.withResolvers<AgentRunResult>();
      const currentIdentity = { ...identity, runId: "new-run" };
      const pending: AgentRunHandle = {
        identity: currentIdentity,
        completed: completed.promise,
        events: { async *[Symbol.asyncIterator]() {} },
        cancel() {
          completed.resolve(
            responseType === "cancel"
              ? {
                  status: "failed",
                  identity: currentIdentity,
                  error: {
                    code: "DOUBLE_CANCEL",
                    message: "Cancellation activation was interrupted",
                  },
                }
              : { status: "cancelled", identity: currentIdentity },
          );
        },
      };
      const running = runTerminalController({
        ...io,
        command: parseTerminalArguments(["--thread", "thread", "--resume", "query"]),
        host: host({
          resume: async (_query, response) => {
            if (!response) return handle(Promise.resolve(waiting));
            entered.resolve();
            return activation.promise;
          },
        }),
      });
      await io.until("choiceId interactionId");
      io.input.write(`${responseType === "cancel" ? "cancel" : "allow"} permission-id\r`);
      await entered.promise;
      process.emit("SIGINT");
      activation.resolve(pending);
      if (responseType === "cancel")
        completed.resolve({ status: "cancelled", identity: currentIdentity });
      expect(await running).toBe(130);
      expect(io.stderr).not.toContain("DOUBLE_CANCEL");
      expect(io.input.isRaw).toBe(false);
    },
  );
});
