import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { AgentRunHandle, AgentRunResult } from "@agent-harness/core/agent-contract";
import { AgentError } from "@agent-harness/core/protocol-errors";
import type { RunIdentity } from "@agent-harness/core/protocol-values";
import type { RuntimeEvent } from "@agent-harness/core/session/session-events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSubmittedText, parseTerminalArguments } from "../cli/commands/terminal-command.js";
import type { TerminalHost, TerminalSetupIO } from "../cli/host/host-contract.js";
import { runCli } from "../cli/main.js";
import * as rendererModule from "../cli/terminal/interactive-renderer.js";
import type { TerminalView } from "../cli/terminal/renderer-contract.js";
import { statusLines } from "../cli/terminal/status-line.js";
import type { TerminalModelItem } from "../cli/terminal/terminal-contract.js";
import { runTerminalController } from "../cli/terminal/terminal-controller.js";
import { visibleWidth } from "../cli/terminal/terminal-text.js";
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
  const dismissals: boolean[] = [];
  const toolDismissed = Promise.withResolvers<boolean>();
  const pending: Array<{
    predicate: (view: TerminalView) => boolean;
    resolve: (view: TerminalView) => void;
  }> = [];
  vi.spyOn(rendererModule, "createTerminalRenderer").mockImplementation((options) => {
    const renderer = create(options);
    return {
      ...renderer,
      async dismissTool() {
        const dismissed = await renderer.dismissTool();
        dismissals.push(dismissed);
        toolDismissed.resolve(dismissed);
        return dismissed;
      },
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
    dismissals,
    toolDismissed: toolDismissed.promise,
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

  it("expires draft-clear notices when editing or recalling a draft for a new request", async () => {
    const io = surface(true);
    const observed = observeViews();
    const run = vi.fn(async () => handle(Promise.resolve(finishedResult)));
    const running = runTerminalController({
      ...io,
      command: parseTerminalArguments([]),
      host: host({ run }),
    });
    await observed.until((view) => view.composer.submission.enabled);
    io.input.write("task\r");
    await observed.until((view) => view.phase === "running");
    await observed.until((view) => view.composer.submission.enabled);
    io.input.write("\x03");
    await observed.until((view) => view.feedback?.kind === "notice");
    io.input.write("\x1b[A");
    const recalled = await observed.until((view) => view.composer.draft.text === "task");
    expect(recalled.feedback).toBeUndefined();
    io.input.write("\r");
    await observed.until((view) => view.phase === "running");
    const idle = await observed.until((view) => view.composer.submission.enabled);
    expect(idle.feedback).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
    io.input.write("\x03");
    await observed.until((view) => view.feedback?.kind === "notice");
    io.input.write("edited-draft");
    const edited = await observed.until((view) => view.composer.draft.text === "edited-draft");
    expect(edited.feedback).toBeUndefined();
    io.input.end();
    expect(await running).toBe(0);
  });

  it.each([40, 100])("keeps ready and running context compact at %i columns", async (columns) => {
    const io = surface(true);
    vi.stubEnv("TERM", "xterm-256color");
    Object.assign(io.output, { isTTY: true, columns, rows: 12 });
    const observed = observeViews();
    const completed = Promise.withResolvers<AgentRunResult>();
    const run = vi.fn(async () => handle(completed.promise));
    const currentHost = host({ run });
    Object.defineProperty(currentHost, "context", {
      value: {
        ...currentHost.context,
        workspaceRoot: "E:/project",
        toolsMode: "read-write",
        model: {
          id: "model",
          label: "gpt-real",
          availability: {
            state: "ready",
            reason: "本地配置就绪；网络未验证，不代表连接成功。",
          },
        },
      },
    });
    const running = runTerminalController({
      ...io,
      command: parseTerminalArguments([]),
      host: currentHost,
    });
    const ready = await observed.until((view) => view.composer.submission.enabled);
    expect(ready.context?.modelStatus).toBeUndefined();
    const readyLines = statusLines(ready, columns - 1);
    expect(readyLines).toHaveLength(2);
    expect(readyLines[0]).toContain("gpt-real");
    expect(readyLines[0]).toContain("读写");
    expect(readyLines[0]).toContain("project");
    expect(readyLines.join("\n")).not.toContain("网络未验证");
    io.input.write("task\r");
    const executing = await observed.until((view) => view.phase === "running");
    const executingLines = statusLines(executing, columns - 1);
    expect(executingLines).toHaveLength(2);
    expect(executingLines[0]).toContain("执行中");
    expect(executingLines[0]).toContain("gpt-real");
    expect(executingLines[0]).toContain("读写");
    expect(executingLines[1]).toMatch(/Esc.*取消/u);
    expect(executingLines.join("\n").match(/不排队/gu)).toHaveLength(1);
    expect(executing.composer.submission.enabled).toBe(false);
    io.input.write("next-draft\r");
    const blocked = await observed.until((view) => view.composer.draft.text === "next-draft");
    expect(blocked.composer.submission.enabled).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    completed.resolve(finishedResult);
    const settled = await observed.until((view) => view.composer.submission.enabled);
    expect(settled.composer.draft.text).toBe("next-draft");
    expect(run).toHaveBeenCalledTimes(1);
    io.input.end();
    expect(await running).toBe(0);
  });

  it("clears input correction feedback without clearing the current model problem", async () => {
    const io = surface(true);
    vi.stubEnv("TERM", "xterm-256color");
    Object.assign(io.output, { isTTY: true, columns: 40, rows: 12 });
    const observed = observeViews();
    const currentHost = host({});
    Object.defineProperty(currentHost, "context", {
      value: {
        ...currentHost.context,
        model: {
          ...currentHost.context.model,
          availability: { state: "unavailable", reason: "CREDENTIAL_REQUIRED" },
        },
      },
    });
    const running = runTerminalController({
      ...io,
      command: parseTerminalArguments([]),
      host: currentHost,
    });
    const ready = await observed.until((view) => view.composer.submission.enabled);
    expect(ready.context?.modelStatus).toBe("CREDENTIAL_REQUIRED");
    io.input.write("/invalid!\r");
    const correction = await observed.until((view) => view.feedback?.kind === "input");
    expect(correction.context?.modelStatus).toBe(ready.context?.modelStatus);
    const correctionLines = statusLines(correction, 39);
    expect(correctionLines).toHaveLength(3);
    expect(correctionLines.join("\n")).toContain("CREDENTIAL_REQUIRED");
    expect(correctionLines.join("\n")).toContain("未知命令");
    expect(correctionLines.at(-1)).toContain("Enter");
    io.input.write("x");
    const edited = await observed.until((view) => view.composer.draft.text === "/invalid!x");
    expect(edited.feedback).toBeUndefined();
    expect(edited.context?.modelStatus).toBe(ready.context?.modelStatus);
    io.input.end();
    expect(await running).toBe(0);
  });

  it("keeps completion on the composer and closes it without changing the draft or cursor", async () => {
    const io = surface(true);
    const observed = observeViews();
    const run = vi.fn(async () => handle(Promise.resolve(finishedResult)));
    const running = runTerminalController({
      ...io,
      command: parseTerminalArguments([]),
      host: host({ run }),
    });
    await observed.until((view) => view.composer.submission.enabled);
    io.input.write("/he");
    const completing = await observed.until(
      (view) => !!view.completion && view.composer.draft.text === "/he",
    );
    expect(completing.input.purpose).toBe("completion");
    expect(completing.selector).toBeUndefined();
    expect(completing.composer.draft).toEqual({ text: "/he", cursor: 3 });
    io.input.write("\x1b");
    const closed = await observed.until((view) => !view.completion);
    expect(closed.composer.draft).toEqual(completing.composer.draft);
    expect(run).not.toHaveBeenCalled();
    io.input.write("l");
    const reopened = await observed.until(
      (view) => !!view.completion && view.composer.draft.text === "/hel",
    );
    const accepted = reopened.completion!.items[0]!.id;
    io.input.write("\r");
    const completed = await observed.until(
      (view) => !view.completion && view.composer.draft.text === `/${accepted}`,
    );
    expect(completed.input.purpose).toBe("composer");
    expect(run).not.toHaveBeenCalled();
    io.input.end();
    expect(await running).toBe(0);
  });

  it("uses one Escape to dismiss tool details and a later Escape to cancel execution", async () => {
    const io = surface(true);
    const observed = observeViews();
    const completed = Promise.withResolvers<AgentRunResult>();
    const cancel = vi.fn(() => completed.resolve({ status: "cancelled", identity }));
    const running = runTerminalController({
      ...io,
      command: parseTerminalArguments([]),
      host: host({
        run: async () =>
          handle(
            completed.promise,
            [
              {
                kind: "fact",
                type: "tool.started",
                identity,
                step: 1,
                invocation: {
                  identity,
                  call: { type: "tool-call", callId: "call", name: "controlled-tool", input: {} },
                  toolVersion: null,
                  state: "dispatched",
                },
              },
            ],
            cancel,
          ),
      }),
    });
    await observed.until((view) => view.composer.submission.enabled);
    io.input.write("task\r");
    await io.until("controlled-tool");
    io.input.write("next-draft\x1b[D\x0f");
    await nextTurn();
    const draft = observed.views.at(-1)!.composer.draft;
    io.input.write("\x1b");
    await observed.toolDismissed;
    expect(observed.dismissals).toEqual([true]);
    expect(cancel).not.toHaveBeenCalled();
    expect(observed.views.at(-1)!.composer.draft).toEqual(draft);
    io.input.write("\x1b");
    await observed.until((view) => view.composer.submission.enabled);
    expect(observed.dismissals).toEqual([true, false]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(observed.views.at(-1)!.composer.draft).toEqual(draft);
    io.input.end();
    expect(await running).toBe(0);
  });

  it.each(["answer", "cancel"] as const)(
    "requires explicit approval, retains waiting after Escape, and clears waiting feedback on %s",
    async (response) => {
      const io = surface(true);
      vi.stubEnv("TERM", "xterm-256color");
      Object.assign(io.output, { isTTY: true, columns: 80, rows: 24 });
      const observed = observeViews();
      const interaction = {
        id: "permission-id",
        owner: "host",
        payload: { type: "approval", version: 1, data: null },
      };
      const resume = vi.fn(async () => handle(Promise.resolve(finishedResult)));
      const answerInteraction = vi.fn(() => ({
        interactionId: interaction.id,
        type: "answer" as const,
        value: true,
      }));
      const running = runTerminalController({
        ...io,
        command: parseTerminalArguments([]),
        host: host({
          run: async () => handle(Promise.resolve({ status: "waiting", identity, interaction })),
          resume,
          answerInteraction,
        }),
      });
      await observed.until((view) => view.composer.submission.enabled);
      io.input.write("task\r");
      const waiting = await observed.until((view) => !!view.interaction && !!view.selector);
      expect(waiting.input.purpose).toBe("interaction");
      expect(waiting.selector?.selectedId).toBeNull();
      io.input.write("\r\t");
      await nextTurn();
      expect(answerInteraction).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      io.input.write("\x1b[B");
      const selected = await observed.until((view) => view.selector?.selectedId === "allow");
      io.input.write("\t");
      await nextTurn();
      expect(answerInteraction).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      io.input.write("\x1b");
      const kept = await observed.until((view) => view.feedback?.kind === "input");
      expect(kept.phase).toBe("waiting");
      expect(kept.interaction).toEqual(waiting.interaction);
      expect(kept.composer.draft).toEqual(selected.composer.draft);
      expect(answerInteraction).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
      if (response === "cancel") {
        io.input.write("\x1b[B");
        await observed.until((view) => view.selector?.selectedId === "__cancel");
      }
      io.input.write("\r");
      const idle = await observed.until((view) => view.composer.submission.enabled);
      expect(idle.feedback?.kind).not.toBe("input");
      expect(idle.interaction).toBeUndefined();
      expect(
        observed.views
          .slice(observed.views.indexOf(kept) + 1)
          .filter((view) => view.phase !== "waiting")
          .some((view) => view.feedback?.message === kept.feedback?.message),
      ).toBe(false);
      expect(answerInteraction).toHaveBeenCalledTimes(response === "answer" ? 1 : 0);
      expect(resume).toHaveBeenCalledTimes(1);
      io.input.end();
      expect(await running).toBe(0);
    },
  );

  it("keeps draft submission disabled during an asynchronous session transition", async () => {
    const io = surface(true);
    const observed = observeViews();
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
    await observed.until((view) => view.composer.submission.enabled);
    io.input.write("/new\r\r");
    await io.until("yes");
    io.input.write("yes\r");
    await entered.promise;
    const transition = observed.views.at(-1)!;
    expect(transition.composer.submission.enabled).toBe(false);
    expect(transition.activity).toBeTruthy();
    expect(transition.input.status).toContain(transition.activity);
    const transitionLines = statusLines(transition, 39);
    expect(transitionLines).toHaveLength(2);
    expect(transitionLines[0]).toContain(transition.activity);
    expect(transitionLines[1]).toContain("等待当前操作");
    io.input.write("draft-survives-switch\r");
    await nextTurn();
    expect(queries).toBe(0);
    const blocked = observed.views.at(-1)!;
    expect(blocked.composer.draft.text).toBe("draft-survives-switch");
    expect(blocked.input.status).toBe(transition.input.status);
    expect(blocked.composer.submission.enabled).toBe(false);
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
    const observed = observeViews();
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
    await observed.until((view) => view.composer.submission.enabled);
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
      expect(picker.composer.submission.enabled).toBe(false);
      expect(picker.selector?.navigation?.groups.map((group) => group.id)).toEqual([
        "all",
        "legacy",
      ]);
      expect(picker.selector?.items.find((item) => item.id === "disabled")?.label).toContain(
        "不可用",
      );
      expect(picker.selector?.items.find((item) => item.id === "disabled")?.description).toContain(
        "MISSING_LOCAL_CREDENTIAL",
      );
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
      if (choice === "unavailable") {
        expect(idle.feedback?.kind).toBe("blocking");
        expect(idle.feedback?.message).toContain("MISSING_LOCAL_CREDENTIAL");
        const unavailableLines = statusLines(idle, 39);
        expect(unavailableLines).toHaveLength(3);
        expect(unavailableLines.join("\n")).toContain("MISSING_LOCAL_CREDENTIAL");
        expect(unavailableLines.at(-1)).toContain("Enter");
        io.input.write("-edited");
        const edited = await observed.until(
          (view) => view.composer.draft.text === "retained-draft-edited",
        );
        expect(edited.feedback).toEqual(idle.feedback);
      }
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
      if (outcome === "catalog-failure") {
        catalog.reject(new Error("PRIVATE_CATALOG_ERROR"));
        const recovery = await observed.until((view) => !!view.selector);
        expect(recovery.activity).toBeUndefined();
        expect(recovery.composer.draft.text).toBe("retained-draft");
        // 目录失败仍保留配置入口；退出选择再核对原绑定和草稿，而非等待自动关闭。
        io.input.write("\x03");
      } else {
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
        expect(changing.input.status).toContain(changing.activity);
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
        expect(idle.context?.modelStatus).toBeUndefined();
      } else {
        expect(currentHost.context).toBe(initialContext);
        expect(observed.views.some((view) => view.context?.threadId === "new-binding")).toBe(false);
      }
      if (outcome === "safe-failure") {
        expect(idle.feedback?.kind).toBe("blocking");
        io.input.write("-edited");
        const edited = await observed.until(
          (view) => view.composer.draft.text === "retained-draft-edited",
        );
        expect(edited.feedback).toEqual(idle.feedback);
        expect(edited.context).toEqual(idle.context);
      }
      expect(io.stdout + io.stderr).not.toContain("PRIVATE_CATALOG_ERROR");
      io.input.end();
      expect(await running).toBe(0);
    },
  );

  it("retains connection problems through editing and unrelated help until configuration succeeds", async () => {
    const io = surface(true);
    const observed = observeViews();
    const retry = Promise.withResolvers<string | undefined>();
    const retryEntered = Promise.withResolvers<void>();
    let attempts = 0;
    const configureModel = vi.fn(async () => {
      if (attempts++ === 0)
        throw new AgentError("HOST_CONFIGURATION_REJECTED", "Connection requires correction");
      retryEntered.resolve();
      return retry.promise;
    });
    const running = runTerminalController({
      ...io,
      command: parseTerminalArguments([]),
      host: host({
        models: async () => [{ id: "model", label: "Controlled model" }],
        configureModel,
      }),
    });
    await observed.until((view) => view.composer.submission.enabled);
    io.input.write("/connect\r\r");
    const failed = await observed.until(
      (view) => view.composer.submission.enabled && view.feedback?.kind === "blocking",
    );
    io.input.write("retained-draft");
    const edited = await observed.until((view) => view.composer.draft.text === "retained-draft");
    expect(edited.feedback).toEqual(failed.feedback);
    io.input.write("\x03");
    await observed.until((view) => view.composer.draft.text === "");
    const beforeHelp = observed.views.length;
    io.input.write("/help\r\r");
    const afterHelp = await observed.until(
      (view) =>
        observed.views.length > beforeHelp &&
        view.composer.submission.enabled &&
        view.composer.draft.text === "",
    );
    expect(afterHelp.feedback).toEqual(failed.feedback);
    const beforeRetry = observed.views.length;
    io.input.write("/connect\r\r");
    await retryEntered.promise;
    expect(observed.views.at(-1)!.feedback).toEqual(failed.feedback);
    retry.resolve("model");
    const recovered = await observed.until(
      (view) =>
        observed.views.length > beforeRetry &&
        view.composer.submission.enabled &&
        view.composer.draft.text === "",
    );
    expect(recovered.feedback?.kind).not.toBe("blocking");
    expect(configureModel).toHaveBeenCalledTimes(2);
    io.input.end();
    expect(await running).toBe(0);
  });

  it("parses /connect while retaining escaped command text as a message", () => {
    expect(parseSubmittedText("/connect")).toEqual({ type: "command", name: "connect" });
    expect(parseSubmittedText("//connect")).toEqual({ type: "message", text: "/connect" });
  });

  it.each(["model-selector", "completion", "selector", "prompt", "secret", "interaction"] as const)(
    "renders a reachable Escape action for %s at 40 × 12",
    async (purpose) => {
      const io = surface(true);
      vi.stubEnv("TERM", "xterm-256color");
      Object.assign(io.output, { isTTY: true, columns: 40, rows: 12 });
      const observed = observeViews();
      const writes: string[] = [];
      const interaction = {
        id: "approval-id",
        owner: "host",
        payload: { type: "approval", version: 1, data: null },
      };
      const resume = vi.fn(async () => handle(Promise.resolve(finishedResult)));
      const running = runTerminalController({
        ...io,
        writeOutput: async (text) => {
          writes.push(text);
          await io.writeOutput(text);
        },
        command: parseTerminalArguments([]),
        host: host({
          open: async ({ setup }) => {
            if (purpose === "selector")
              await setup!.select("Choose an option", [{ id: "one", label: "Option" }]);
            else if (purpose === "prompt") await setup!.text("Enter a value");
            else if (purpose === "secret") await setup!.secret("Enter a secret");
          },
          models: async () => [{ id: "model", label: "Controlled model" }],
          run: async () => handle(Promise.resolve({ status: "waiting", identity, interaction })),
          resume,
        }),
      });
      if (purpose === "model-selector" || purpose === "completion" || purpose === "interaction") {
        await observed.until((view) => view.composer.submission.enabled);
        io.input.write(
          purpose === "model-selector"
            ? "retained-draft\x1bm"
            : purpose === "completion"
              ? "/he"
              : "task\r",
        );
      }
      const focused = await observed.until(
        (view) =>
          view.input.purpose === purpose &&
          (purpose !== "interaction" || !!view.selector) &&
          (purpose !== "completion" || view.composer.draft.text === "/he"),
      );
      await nextTurn();
      const visibleAction = writes
        .flatMap((text) => stripVTControlCharacters(text).split(/[\r\n]/))
        .find((line) => line.includes("Esc") && line.includes("Enter"));
      expect(visibleAction).toBeDefined();
      expect(visibleAction).toMatch(/Esc\s*\p{Script=Han}/u);
      expect(visibleWidth(focused.input.hint)).toBeLessThanOrEqual(39);
      expect(visibleWidth(visibleAction!)).toBeLessThanOrEqual(39);
      const draft = focused.composer.draft;
      io.input.write("\x1b");
      if (purpose === "interaction") {
        const kept = await observed.until((view) => view.feedback?.kind === "input");
        expect(kept.phase).toBe("waiting");
        expect(kept.interaction).toEqual(focused.interaction);
        expect(resume).not.toHaveBeenCalled();
      } else if (purpose === "model-selector") {
        const groups = await observed.until((view) => view.selector?.navigation?.pane === "groups");
        expect(groups.composer.draft).toEqual(draft);
        io.input.write("\x1b");
        const closed = await observed.until((view) => view.composer.submission.enabled);
        expect(closed.composer.draft).toEqual(draft);
      } else {
        const closed = await observed.until(
          (view) => view.input.purpose === "composer" && view.composer.submission.enabled,
        );
        expect(closed.composer.draft).toEqual(draft);
      }
      io.input.end();
      expect(await running).toBe(purpose === "interaction" ? 3 : 0);
    },
  );

  it.each([
    { columns: 40, rows: 12 },
    { columns: 80, rows: 24 },
  ])(
    "navigates real vendor identities, panes and All search at $columns x $rows",
    async ({ columns, rows }) => {
      const io = surface(true);
      vi.stubEnv("TERM", "xterm-256color");
      Object.assign(io.output, { isTTY: true, columns, rows });
      const observed = observeViews();
      const newSession = vi.fn(async () => {});
      const currentHost = host({
        models: async () => [
          {
            id: "model",
            label: "Alias A",
            modelName: "alpha",
            vendor: { id: "a", label: "Connection A" },
          },
          {
            id: "other",
            label: "Alias B",
            modelName: "beta",
            vendor: { id: "b", label: "Connection B" },
          },
          {
            id: "locked",
            label: "Alias locked",
            modelName: "locked",
            vendor: { id: "b", label: "Connection B" },
            availability: { state: "unavailable", reason: "NO_KEY" },
          },
        ],
        newSession,
      });
      const running = runTerminalController({
        ...io,
        command: parseTerminalArguments(["--no-color"]),
        host: currentHost,
      });
      await observed.until((view) => view.composer.submission.enabled);
      io.input.write("retained-draft\x1bm");
      const picker = await observed.until((view) => !!view.selector?.navigation);
      expect(picker.selector?.navigation?.groups.map((group) => group.id)).toEqual([
        "all",
        "vendor:a",
        "vendor:b",
      ]);
      expect(picker.selector?.items.find((item) => item.id === "model")?.label).toBe(
        "alpha · 当前",
      );
      expect(picker.selector?.items.find((item) => item.id === "locked")?.label).toContain(
        "不可用",
      );
      io.input.write("\x1b[D");
      await observed.until((view) => view.selector?.navigation?.pane === "groups");
      io.input.write("\x1b[B\x1b[B");
      const groupB = await observed.until(
        (view) => view.selector?.navigation?.selectedGroupId === "vendor:b",
      );
      expect(groupB.selector?.items.map((item) => item.id)).toEqual([
        "other",
        "locked",
        groupB.selector?.navigation?.action.id,
      ]);
      io.input.write("\r");
      await observed.until((view) => view.selector?.navigation?.pane === "models");
      expect(newSession).not.toHaveBeenCalled();
      io.input.write("\x1b[B");
      await observed.until((view) => view.selector?.selectedId === "other");
      io.input.write("\t");
      await observed.until((view) => view.selector?.navigation?.pane === "groups");
      expect(newSession).not.toHaveBeenCalled();
      io.input.write("\x1b[C");
      await observed.until((view) => view.selector?.navigation?.pane === "models");
      io.input.write("alpha");
      const scoped = await observed.until((view) => view.selector?.query === "alpha");
      expect(scoped.selector?.items.map((item) => item.id)).toEqual([
        scoped.selector?.navigation?.action.id,
      ]);
      io.input.write("\x1b[D\x1b[A\x1b[A");
      await observed.until((view) => view.selector?.navigation?.selectedGroupId === "all");
      io.input.write("\x1b[C");
      await observed.until((view) => view.selector?.navigation?.pane === "models");
      io.input.write("alpha");
      const all = await observed.until((view) => view.selector?.query === "alpha");
      expect(all.selector?.items.map((item) => item.id)).toEqual([
        "model",
        all.selector?.navigation?.action.id,
      ]);
      io.input.write("\x1b[B\r");
      const idle = await observed.until((view) => view.composer.submission.enabled);
      expect(idle.feedback?.kind).toBe("notice");
      expect(idle.composer.draft.text).toBe("retained-draft");
      expect(newSession).not.toHaveBeenCalled();
      io.input.write("\x1bm");
      await observed.until((view) => !!view.selector);
      io.input.write("\x1b");
      await observed.until((view) => view.selector?.navigation?.pane === "groups");
      expect(newSession).not.toHaveBeenCalled();
      io.input.write("\x1b");
      const cancelled = await observed.until((view) => view.composer.submission.enabled);
      expect(cancelled.composer.draft.text).toBe("retained-draft");
      io.input.end();
      expect(await running).toBe(0);
    },
  );

  it.each(["confirm", "cancel-switch", "cancel-setup"] as const)(
    "configures from an empty picker and preserves saved connections on %s",
    async (outcome) => {
      const io = surface(true);
      const observed = observeViews();
      let saved = false;
      const configured: TerminalModelItem = {
        id: "added",
        label: "New connection / actual-model",
        modelName: "actual-model",
        vendor: { id: "new-vendor", label: "New connection" },
        availability: { state: "ready", reason: "LOCAL_READY" },
      };
      const configureModel = vi.fn(async (setup: TerminalSetupIO) => {
        const name = await setup.text("Connection name");
        if (name === undefined) return undefined;
        const provider = await setup.select("Select protocol", [
          { id: "openai", label: "OpenAI compatible" },
        ]);
        if (!provider) return undefined;
        const key = await setup.secret("API key");
        if (!key) return undefined;
        saved = true;
        return configured.id;
      });
      const newSession = vi.fn(async () => {
        Object.defineProperty(currentHost, "context", {
          value: { ...currentHost.context, threadId: "new-binding", model: configured },
        });
      });
      const currentHost = host({
        models: vi.fn(async () => (saved ? [configured] : [])),
        configureModel,
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
      const picker = await observed.until((view) => !!view.selector?.navigation);
      expect(picker.selector?.items).toEqual([picker.selector?.navigation?.action]);
      io.input.write("1\r");
      await observed.until((view) => view.prompt?.text === "Connection name");
      expect(currentHost.context).toBe(initialContext);
      expect(newSession).not.toHaveBeenCalled();
      if (outcome === "cancel-setup") io.input.write("\x03");
      else {
        io.input.write("New connection\r");
        const protocol = await observed.until((view) => view.selector?.title === "Select protocol");
        expect(protocol.selector?.navigation).toBeUndefined();
        io.input.write("1\r");
        await observed.until((view) => view.prompt?.secret === true);
        io.input.write("PRIVATE_API_KEY\r");
        const confirmation = await observed.until(
          (view) => view.prompt?.text.includes("actual-model") === true,
        );
        expect(confirmation.prompt?.text).toContain("yes");
        expect(io.stdout + io.stderr).toContain("CLI 默认模型已保存");
        expect(io.stdout + io.stderr).not.toContain("PRIVATE_API_KEY");
        expect(saved).toBe(true);
        expect(currentHost.context).toBe(initialContext);
        expect(newSession).not.toHaveBeenCalled();
        io.input.write(outcome === "confirm" ? "yes\r" : "\x03");
      }
      const idle = await observed.until((view) => view.composer.submission.enabled);
      expect(idle.composer.draft.text).toBe("retained-draft");
      expect(configureModel).toHaveBeenCalledTimes(1);
      if (outcome === "confirm") {
        expect(newSession).toHaveBeenCalledWith({ modelId: "added" });
        expect(currentHost.context.threadId).toBe("new-binding");
      } else {
        expect(newSession).not.toHaveBeenCalled();
        expect(currentHost.context).toBe(initialContext);
      }
      expect(saved).toBe(outcome !== "cancel-setup");
      io.input.end();
      expect(await running).toBe(0);
    },
  );

  it.each(["safe", "unknown", "close"] as const)(
    "runs /connect directly and preserves the existing failure policy for %s errors",
    async (failure) => {
      const io = surface(true);
      const observed = observeViews();
      const configureModel = vi.fn(async () => {
        if (failure === "safe")
          throw new AgentError("HOST_CONFIGURATION_REJECTED", "Original binding retained");
        if (failure === "close") throw new AgentError("HOST_CLOSE_FAILED", "Close failed");
        throw new Error("PRIVATE_CONFIGURATION_ERROR");
      });
      const currentHost = host({ models: async () => [], configureModel });
      const initialContext = currentHost.context;
      const running = runTerminalController({
        ...io,
        command: parseTerminalArguments([]),
        host: currentHost,
      });
      await observed.until((view) => view.composer.submission.enabled);
      io.input.write("/connect\r\r");
      if (failure === "safe") {
        const idle = await observed.until(
          (view) => view.feedback?.kind === "blocking" && view.composer.submission.enabled,
        );
        expect(idle.activity).toBeUndefined();
        expect(currentHost.context).toBe(initialContext);
        io.input.end();
      }
      expect(await running).toBe(failure === "safe" ? 0 : 1);
      expect(configureModel).toHaveBeenCalledTimes(1);
      expect(io.stdout + io.stderr).not.toContain("PRIVATE_CONFIGURATION_ERROR");
    },
  );

  it("offers actionable plain group selection and cancellation without activating a model", async () => {
    const io = surface(true);
    const observed = observeViews();
    const newSession = vi.fn(async () => {});
    const configureModel = vi.fn(async () => undefined);
    const running = runTerminalController({
      ...io,
      command: parseTerminalArguments([]),
      host: host({
        models: async () => [
          { id: "model", label: "Alpha", vendor: { id: "a", label: "Vendor A" } },
          { id: "other", label: "Beta", vendor: { id: "b", label: "Vendor B" } },
        ],
        configureModel,
        newSession,
      }),
    });
    await observed.until((view) => view.composer.submission.enabled);
    io.input.write("draft\x1bm");
    await observed.until((view) => !!view.selector);
    io.input.write("/groups\r");
    await observed.until(
      (view) => view.selector?.navigation?.pane === "groups" && view.selector.query === "",
    );
    await io.until("3. Vendor B");
    io.input.write("3\r");
    const models = await observed.until(
      (view) =>
        view.selector?.navigation?.selectedGroupId === "vendor:b" &&
        view.selector.navigation.pane === "models",
    );
    expect(models.selector?.items[0]?.label).toContain("Beta");
    expect(newSession).not.toHaveBeenCalled();
    io.input.write("/connect\r");
    const idle = await observed.until((view) => view.composer.submission.enabled);
    expect(idle.composer.draft.text).toBe("draft");
    expect(configureModel).toHaveBeenCalledTimes(1);
    expect(newSession).not.toHaveBeenCalled();
    io.input.end();
    expect(await running).toBe(0);
  });
});

describe.skipIf(process.platform !== "win32")(
  "real Node CLI asynchronous output observation",
  () => {
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
          "run.started",
          "step.committed",
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
  },
);
