import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { AgentRunHandle, AgentRunResult } from "@agent-harness/core/agent-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import type { RunIdentity } from "@agent-harness/core/protocol-values";
import type { RuntimeEvent } from "@agent-harness/core/session/session-events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTerminalArguments } from "../cli/commands/terminal-command.js";
import type { TerminalHost } from "../cli/host/host-contract.js";
import { runCli } from "../cli/main.js";
import * as rendererModule from "../cli/terminal/interactive-renderer.js";
import type { TerminalView } from "../cli/terminal/renderer-contract.js";
import type { TerminalModelItem } from "../cli/terminal/terminal-contract.js";
import { runTerminalController } from "../cli/terminal/terminal-controller.js";
import {
  type CliChild,
  cliChild,
  cliSdkServer,
  jsonlRecords,
  queryRecord,
  runCliChild,
} from "./fixtures/node-cli-process.js";

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
  vi.restoreAllMocks();
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
    configureModel: unsupported,
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
  output.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    changed();
  });
  error.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    changed();
  });
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

function observeViews() {
  const create = rendererModule.createTerminalRenderer;
  const views: TerminalView[] = [];
  const pending: Array<{
    predicate: (view: TerminalView) => boolean;
    resolve: (view: TerminalView) => void;
  }> = [];
  vi.spyOn(rendererModule, "createTerminalRenderer").mockImplementation((options) => {
    const renderer = create(options);
    return {
      ...renderer,
      async view(view) {
        views.push(view);
        for (const waiter of [...pending]) {
          if (!waiter.predicate(view)) continue;
          pending.splice(pending.indexOf(waiter), 1);
          waiter.resolve(view);
        }
        await renderer.view(view);
      },
    };
  });
  return {
    views,
    until(predicate: (view: TerminalView) => boolean) {
      const latest = views.at(-1);
      if (latest && predicate(latest)) return Promise.resolve(latest);
      const gate = Promise.withResolvers<TerminalView>();
      pending.push({ predicate, resolve: gate.resolve });
      return gate.promise;
    },
  };
}

describe("terminal controller result and lifecycle", () => {
  it("retains truthful Query success but fails the process when Host.close later rejects", async () => {
    const io = surface();
    const code = await runCli(["--prompt", "task", "--output", "jsonl"], {
      ...io,
      createHost: () =>
        host({
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
    expect(records.filter((record) => record.type === "assistant.message")).toEqual([
      expect.objectContaining({
        identity,
        content: [{ contentIndex: 0, text: "authoritative answer" }],
      }),
    ]);
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
    const running = runCli(["--prompt", "task", "--output", "jsonl"], {
      ...io,
      createHost: () => host({ run: async () => run }),
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
      reason: "failure",
      stage: "completion",
      lastRun: { identity },
    });
    expect(records.at(-1).lastRun).not.toHaveProperty("status");
    expect(io.stdout + io.stderr).not.toContain("PRIVATE_KEY_SENTINEL");
  });

  it.each(["none", "completion", "close", "completion-and-close"] as const)(
    "gives execution/close failures priority over a real Writable EPIPE callback: %s",
    async (failure) => {
      const io = surface();
      const completion = Promise.withResolvers<AgentRunResult>();
      const closeObserved = Promise.withResolvers<void>();
      const closeFails = failure === "close" || failure === "completion-and-close";
      const completionFails = failure === "completion" || failure === "completion-and-close";
      const delivered: string[] = [];
      const output = new Writable({
        write(chunk, _encoding, callback) {
          const text = chunk.toString();
          const record = JSON.parse(text);
          if (record.type === "progress" && record.phase === "run.completed") {
            callback(Object.assign(new Error("Downstream closed"), { code: "EPIPE" }));
          } else {
            delivered.push(text);
            callback();
          }
        },
      });
      cleanup.push(() => output.destroy());
      const running = runCli(["--prompt", "task", "--output", "jsonl"], {
        input: io.input,
        output,
        error: io.error,
        createHost: () =>
          host({
            run: async () =>
              handle(completion.promise, [
                { kind: "fact", type: "run.started", identity },
                { kind: "fact", type: "run.completed", identity },
              ]),
            close: async () => {
              closeObserved.resolve();
              if (closeFails) throw new AgentError("HOST_CLOSE_FAILED", "Controlled close failure");
            },
          }),
      });
      await closeObserved.promise;
      if (completionFails)
        completion.reject(new AgentError("RUN_COMPLETION_FAILED", "Controlled completion failure"));
      else completion.resolve(finishedResult);
      expect(await running).toBe(failure === "none" ? 141 : 1);
      const records = delivered.flatMap((text) =>
        text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          type: "progress",
          phase: "run.started",
          identity,
        }),
      );
      expect(
        records.some(
          (record) =>
            record.type === "assistant.message" ||
            record.type === "query.result" ||
            record.type === "process.finished",
        ),
      ).toBe(false);
      // A broken sink cannot deliver process.finished; these injected failures
      // prove CLI settlement only, not a real SQLite release fault.
    },
  );

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

  it.each(["same", "cancel-picker", "cancel-confirmation", "unavailable"] as const)(
    "keeps the current binding and draft for model choice %s",
    async (choice) => {
      const io = surface(true);
      const observed = observeViews();
      const newSession = vi.fn(async () => {});
      const currentHost = host({
        models: async () => [
          {
            id: "other",
            label: "Other model",
            availability: { state: "ready", reason: "LOCAL_READY" },
          },
          {
            id: "model",
            label: "Controlled model",
            availability: { state: "ready", reason: "LOCAL_READY" },
          },
          {
            id: "disabled",
            label: "Disabled model",
            availability: { state: "unavailable", reason: "MISSING_LOCAL_CREDENTIAL" },
          },
        ],
        newSession,
      });
      const initialContext = currentHost.context;
      const running = runTerminalController({
        ...io,
        command: parseTerminalArguments([]),
        host: currentHost,
      });
      await observed.until((view) => view.composer.submission.enabled);
      io.input.write("retained-draft\x1bm");
      const picker = await observed.until((view) => !!view.selector);
      expect(picker.selector?.selectedId).toBe("model");
      expect(picker.selector?.items.find((item) => item.id === "disabled")?.description).toBe(
        "MISSING_LOCAL_CREDENTIAL",
      );
      expect(picker.composer.submission.enabled).toBe(false);
      if (choice === "same") io.input.write("\r");
      else if (choice === "cancel-picker") io.input.write("\x03");
      else {
        io.input.write(choice === "unavailable" ? "3\r" : "1\r");
        if (choice === "cancel-confirmation") {
          const confirmation = await observed.until((view) => !!view.prompt);
          expect(confirmation.prompt?.text).toContain("Other model");
          io.input.write("\x03");
        }
      }
      const idle = await observed.until((view) => view.composer.submission.enabled);
      expect(idle.composer.draft.text).toBe("retained-draft");
      expect(idle.activity).toBeUndefined();
      expect(currentHost.context).toBe(initialContext);
      expect(newSession).not.toHaveBeenCalled();
      if (choice === "same") expect(observed.views.some((view) => !!view.prompt)).toBe(false);
      if (choice === "unavailable")
        expect(io.stdout + io.stderr).toContain("MISSING_LOCAL_CREDENTIAL");
      io.input.end();
      expect(await running).toBe(0);
    },
  );

  it.each(["success", "safe-failure", "catalog-failure"] as const)(
    "exposes real model activity and clears it after %s without losing the draft",
    async (outcome) => {
      const io = surface(true);
      const observed = observeViews();
      const catalog = Promise.withResolvers<readonly TerminalModelItem[]>();
      const switching = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const currentHost = host({
        models: () => catalog.promise,
        newSession: vi.fn(async () => {
          entered.resolve();
          await switching.promise;
          Object.defineProperty(currentHost, "context", {
            value: {
              ...currentHost.context,
              threadId: "new-binding",
              model: { id: "other", label: "Other model" },
            },
          });
        }),
      });
      const initialContext = currentHost.context;
      const running = runTerminalController({
        ...io,
        command: parseTerminalArguments([]),
        host: currentHost,
      });
      await observed.until((view) => view.composer.submission.enabled);
      io.input.write("retained-draft\x1bm");
      const loading = await observed.until((view) => !!view.activity);
      expect(loading.composer.submission.enabled).toBe(false);
      if (outcome === "catalog-failure") catalog.reject(new Error("PRIVATE_CATALOG_ERROR"));
      else {
        catalog.resolve([
          {
            id: "other",
            label: "Other model",
            availability: { state: "ready", reason: "LOCAL_READY" },
          },
          { id: "model", label: "Controlled model" },
        ]);
        const picker = await observed.until((view) => !!view.selector);
        expect(picker.activity).toBeUndefined();
        io.input.write("1\r");
        await observed.until((view) => !!view.prompt);
        io.input.write("yes\r");
        await entered.promise;
        const changing = observed.views.at(-1)!;
        expect(changing.activity).toBeTruthy();
        expect(changing.composer.submission.enabled).toBe(false);
        if (outcome === "safe-failure")
          switching.reject(new AgentError("HOST_SWITCH_REJECTED", "Original binding retained"));
        else switching.resolve();
      }
      const idle = await observed.until((view) => view.composer.submission.enabled);
      expect(idle.activity).toBeUndefined();
      expect(idle.composer.draft.text).toBe("retained-draft");
      if (outcome === "success") {
        expect(currentHost.context).toMatchObject({
          threadId: "new-binding",
          model: { id: "other" },
        });
        expect(idle.context?.modelStatus).toBe("LOCAL_READY");
      } else {
        expect(currentHost.context).toBe(initialContext);
        expect(observed.views.some((view) => view.context?.threadId === "new-binding")).toBe(false);
      }
      expect(io.stdout + io.stderr).not.toContain("PRIVATE_CATALOG_ERROR");
      io.input.end();
      expect(await running).toBe(0);
    },
  );
});

describe.skipIf(process.platform !== "win32")("real Node CLI asynchronous output observation", () => {
  it("completes and releases SQLite while a run.started Writable callback remains paused", async () => {
    const root = await mkdtemp(join(tmpdir(), "node-cli-slow-output-"));
    const answer = `authoritative-slow-output-${crypto.randomUUID()}`;
    const server = await cliSdkServer(() => answer);
    let execution: CliChild | undefined;
    try {
      await mkdir(join(root, "workspace"));
      expect((await runCliChild(root, server.endpoint, [], "", "seed")).code).toBe(0);
      execution = cliChild(
        root,
        server.endpoint,
        ["--prompt", "finite slow output", "--tools", "none", "--output", "jsonl"],
        "slow-output",
      );
      const [line] = await execution.waitFor(
        "stderr",
        /^\{"type":"slow-output.observation".*\}\r?$/m,
      );
      const observation = JSON.parse(line);
      expect(observation).toMatchObject({
        type: "slow-output.observation",
        identity: {
          agentId: expect.any(String),
          threadId: expect.any(String),
          queryId: expect.any(String),
          runId: expect.any(String),
        },
        completedStatus: "completed",
        checkpointStatus: "completed",
        checkpointRunId: observation.identity.runId,
        leaseReleased: true,
        cliSettled: false,
        callbackPending: true,
      });
      expect(execution.child.exitCode).toBeNull();
      execution.child.stdin.end("flush\n");
      const result = await execution.finished;
      expect(result.code).toBe(0);
      const records = jsonlRecords(result);
      const query = queryRecord(result);
      expect(query).toMatchObject({ identity: observation.identity, status: "completed" });
      for (const record of records.filter((record) => record.identity))
        expect(record.identity).toEqual(observation.identity);
      expect(
        records.filter((record) => record.type === "progress").map((record) => record.phase),
      ).toEqual([
        "step.committed",
        "run.started",
        "step.started",
        "step.committed",
        "run.completed",
      ]);
      expect(records.filter((record) => record.type === "assistant.message")).toEqual([
        expect.objectContaining({
          identity: observation.identity,
          content: [{ contentIndex: 0, text: answer }],
        }),
      ]);
      expect(records.filter((record) => record.type === "query.result")).toHaveLength(1);
      expect(records.at(-1)).toMatchObject({
        type: "process.finished",
        exitCode: 0,
        reason: "completed",
        lastRun: { identity: observation.identity, status: "completed" },
      });
      expect(records.filter((record) => record.type === "process.finished")).toHaveLength(1);
      expect(server.requests).toHaveLength(1);
      expect(server.errors).toEqual([]);
    } finally {
      if (execution?.child.exitCode === null) {
        execution.child.kill();
        await execution.finished;
      }
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 40000);
});
