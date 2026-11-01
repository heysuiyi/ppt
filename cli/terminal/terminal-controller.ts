import type { Readable, Writable } from "node:stream";
import type { AgentRunHandle, AgentRunResult } from "@agent-harness/core/agent-contract";
import type {
  InteractionRequest,
  InteractionResponse,
  RunIdentity,
} from "@agent-harness/core/protocol-values";
import {
  LOCAL_COMMANDS,
  parseSubmittedText,
  TERMINAL_HELP,
  type TerminalCommand,
} from "../commands/terminal-command.js";
import type { TerminalHost, TerminalSetupIO, TerminalToolsMode } from "../host/host-contract.js";
import { createComposer } from "./composer.js";
import type { Composer, NodeTerminal, Selector, TerminalKeyEvent } from "./input-contract.js";
import { createTerminalRenderer } from "./interactive-renderer.js";
import { createNodeTerminal } from "./node-terminal.js";
import { createPreviewBuffer } from "./preview-buffer.js";
import type { TerminalRenderer, TerminalSelectorView, TerminalView } from "./renderer-contract.js";
import { createSelector } from "./selector.js";
import type {
  TerminalExitDecision,
  TerminalFailureStage,
  TerminalPhase,
  TerminalSelectionItem,
} from "./terminal-contract.js";
import {
  interactionReference,
  projectTerminalEvent,
  projectTerminalResult,
  terminalError,
} from "./terminal-projection.js";

export interface TerminalControllerOptions {
  readonly command: TerminalCommand;
  readonly host: TerminalHost;
  readonly input: Readable;
  readonly output: Writable;
  readonly error: Writable;
  readonly writeOutput: (text: string) => Promise<void>;
  readonly writeError: (text: string) => Promise<void>;
}

type Focus =
  | { readonly type: "composer" }
  | {
      readonly type: "text";
      readonly prompt: string;
      readonly secret: boolean;
      readonly editor: Composer;
      readonly resolve: (value: string | undefined) => void;
    }
  | {
      readonly type: "selector";
      readonly title: string;
      readonly selector: Selector;
      readonly sourceItems: readonly TerminalSelectionItem[];
      typed: string;
      readonly resolve: (value: string | undefined) => void;
    };

const failureOrder: readonly TerminalFailureStage[] = [
  "persistence",
  "close",
  "output",
  "completion",
  "observation",
  "protocol",
  "input",
  "activation",
  "configuration",
];

/** 一个控制器拥有输入、观察消费、当前句柄及退出；等待不保留 Core Run 调用栈。 */
export async function runTerminalController(options: TerminalControllerOptions): Promise<number> {
  const { command, host } = options;
  let phase: TerminalPhase = "starting";
  let generation = 0;
  let focus: Focus = { type: "composer" };
  const composer = createComposer();
  let notification: string | undefined;
  let pendingInteraction: InteractionRequest | undefined;
  let active: AgentRunHandle | undefined;
  let lastResult: AgentRunResult | undefined;
  let lastIdentity: RunIdentity | undefined;
  let runTask: Promise<void> | undefined;
  let uiTask: Promise<void> | undefined;
  let completion: Selector | undefined;
  let finalCode = 1;
  let ready = false;
  let stopping = false;
  let eof = false;
  let terminated = false;
  let cancelRequested = false;
  let userCancelledQuery = false;
  let settlingCancellation = false;
  let brokenPipe = false;
  let outputFailed = false;
  let failure: TerminalFailureStage | undefined;
  let pasteLines: string[] | undefined;
  let renderer: TerminalRenderer;
  let terminal: NodeTerminal;
  let events = Promise.resolve();
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
  const inputIsTTY = "isTTY" in options.input && options.input.isTTY === true;
  let oneShot =
    command.prompt !== undefined ||
    command.queryId !== undefined ||
    command.print ||
    command.output === "jsonl" ||
    !inputIsTTY;

  function switchFocus(next: Focus): void {
    generation++;
    terminal.setGeneration(generation);
    focus = next;
  }

  function resolveFocus(value: string | undefined): void {
    const current = focus;
    switchFocus({ type: "composer" });
    if (current.type !== "composer") current.resolve(value);
  }

  function noteFailure(stage: TerminalFailureStage): void {
    if (failure === undefined || failureOrder.indexOf(stage) < failureOrder.indexOf(failure))
      failure = stage;
  }

  function isPipeError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPIPE";
  }

  async function output(action: () => Promise<void>): Promise<void> {
    if (outputFailed) return;
    try {
      await action();
    } catch (error) {
      outputFailed = true;
      if (isPipeError(error)) brokenPipe = true;
      else noteFailure("output");
      requestStop(true);
    }
  }

  async function report(error: unknown, stage: TerminalFailureStage): Promise<void> {
    noteFailure(stage);
    await output(() =>
      renderer.record({
        version: 1,
        type: "error",
        stage,
        error: terminalError(error),
        outcomeUncertain: stage === "completion" || stage === "persistence" || stage === "close",
        ...(lastIdentity ? { identity: lastIdentity } : {}),
      }),
    );
  }

  function requestStop(interruptHost = false): void {
    stopping = true;
    resolveFocus(undefined);
    if (interruptHost) void host.close().catch((error: unknown) => report(error, "close"));
    if (!runTask) finish();
  }

  async function refresh(): Promise<void> {
    if (outputFailed || stopping || phase === "closing") return;
    const draft = focus.type === "text" && !focus.secret ? focus.editor.draft : composer.draft;
    const selector: TerminalSelectorView | undefined =
      focus.type === "selector"
        ? {
            title: focus.title,
            query: focus.typed,
            items:
              terminal.mode === "plain" && /^\d+$/.test(focus.typed)
                ? focus.sourceItems
                : focus.selector.items,
            selectedId: focus.selector.selectedId,
          }
        : completion
          ? {
              title: "命令补全 · 接受后仍需再次 Enter",
              query: "",
              items: completion.items,
              selectedId: completion.selectedId,
            }
          : undefined;
    const view: TerminalView = {
      phase,
      composer: {
        draft: focus.type === "text" && focus.secret ? { text: "", cursor: 0 } : draft,
        editable: true,
        submission:
          phase === "idle" && ready && focus.type === "composer" && !uiTask
            ? { enabled: true }
            : {
                enabled: false,
                reason:
                  phase === "starting" ? "not-ready" : phase === "waiting" ? "interaction" : "busy",
              },
      },
      ...(ready
        ? {
            context: {
              workspace: host.context.workspaceRoot,
              threadId: host.context.threadId,
              model: host.context.model.label,
              capabilities: host.context.toolsMode,
            },
          }
        : {}),
      ...(selector ? { selector } : {}),
      ...(pendingInteraction
        ? {
            interaction: {
              reference: interactionReference(pendingInteraction),
              display: host.describeInteraction(pendingInteraction),
            },
          }
        : {}),
      ...(focus.type === "text" ? { prompt: { text: focus.prompt, secret: focus.secret } } : {}),
      ...(notification ? { notification } : {}),
    };
    await output(() => renderer.view(view));
  }

  async function askText(prompt: string, secret = false): Promise<string | undefined> {
    if (stopping || eof) return undefined;
    if (secret && !terminal.secretAvailable) throw new Error("Secure terminal input unavailable");
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    switchFocus({ type: "text", prompt, secret, editor: createComposer(), resolve });
    await refresh();
    return promise;
  }

  async function askSelection(
    title: string,
    items: readonly TerminalSelectionItem[],
  ): Promise<string | undefined> {
    if (stopping || eof) return undefined;
    if (!items.length) {
      await output(() => renderer.message("没有可用选项。"));
      return undefined;
    }
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    switchFocus({
      type: "selector",
      title,
      selector: createSelector(items, null),
      sourceItems: items,
      typed: "",
      resolve,
    });
    await refresh();
    return promise;
  }

  const setup: TerminalSetupIO = {
    text: (prompt) => askText(prompt),
    secret: (prompt) => askText(prompt, true),
    select: askSelection,
    notify: (text) => output(() => renderer.message(text)),
  };

  async function sessionRecord(): Promise<void> {
    const context = host.context;
    await output(() =>
      renderer.record({
        version: 1,
        type: "session",
        threadId: context.threadId,
        model: context.model,
        capabilities:
          context.toolsMode === "none" ? [] : [{ id: context.toolsMode, label: context.toolsMode }],
      }),
    );
  }

  async function answerWaiting(
    request: InteractionRequest,
  ): Promise<InteractionResponse | undefined> {
    pendingInteraction = request;
    while (!stopping && !eof) {
      if (cancelRequested) return { type: "cancel", interactionId: request.id };
      const display = host.describeInteraction(request);
      if (terminal.mode === "plain") {
        const labels =
          display.support === "supported"
            ? display.choices.map((item) => item.id).join(" / ")
            : "不支持回答";
        const text = await askText(
          `等待 ${request.id}：${labels}；输入 choiceId interactionId，cancel interactionId 取消，exit 保留退出。`,
        );
        if (cancelRequested) return { type: "cancel", interactionId: request.id };
        if (text === undefined) {
          if (stopping || eof) return undefined;
          continue;
        }
        if (text.trim() === "exit") {
          requestStop();
          return undefined;
        }
        const split = text.trim().split(/\s+/);
        if (split.length !== 2 || split[1] !== request.id) {
          notification = "必须输入当前完整 interactionId。";
          await refresh();
          continue;
        }
        if (split[0] === "cancel") return { type: "cancel", interactionId: request.id };
        if (display.support !== "supported") {
          notification = "不支持此交互格式；只能取消或保留等待。";
          continue;
        }
        try {
          return host.answerInteraction(request, split[0]!, split[1]);
        } catch {
          notification = "交互选项或确认身份无效；等待保持。";
          continue;
        }
      }
      const items: TerminalSelectionItem[] =
        display.support === "supported"
          ? display.choices.map((choice) => ({ id: choice.id, label: choice.label }))
          : [];
      items.push({ id: "__cancel", label: "取消请求" }, { id: "__keep", label: "保留等待并退出" });
      const selected = await askSelection(`等待回答 · ${request.id}`, items);
      if (cancelRequested) return { type: "cancel", interactionId: request.id };
      if (selected === "__keep") {
        requestStop();
        return undefined;
      }
      if (selected === "__cancel") return { type: "cancel", interactionId: request.id };
      if (selected === undefined) {
        if (eof || stopping) return undefined;
        notification = "等待保持，未批准或拒绝。";
        continue;
      }
      if (display.support !== "supported") continue;
      const confirmation =
        display.confirmation === "interaction-id"
          ? await askText(`请输入完整交互 ID：${request.id}`)
          : undefined;
      if (cancelRequested) return { type: "cancel", interactionId: request.id };
      if (stopping || eof) return undefined;
      try {
        return host.answerInteraction(request, selected, confirmation);
      } catch {
        notification = "交互选项或确认身份无效；等待保持。";
      }
    }
    return undefined;
  }

  async function executeQuery(initial: Promise<AgentRunHandle>): Promise<void> {
    phase = "running";
    cancelRequested = false;
    userCancelledQuery = false;
    await refresh();
    let handle = await initial;
    for (;;) {
      active = handle;
      lastIdentity = handle.identity;
      lastResult = undefined;
      if (cancelRequested && !settlingCancellation) handle.cancel("用户取消");
      const preview = createPreviewBuffer(handle.identity);
      const observing = (async () => {
        try {
          for await (const event of handle.events) {
            const expected = handle.identity;
            const actual = event.identity;
            if (
              actual.agentId !== expected.agentId ||
              actual.threadId !== expected.threadId ||
              actual.queryId !== expected.queryId ||
              actual.runId !== expected.runId
            )
              continue;
            const record = projectTerminalEvent(event, (request) =>
              host.describeInteraction(request),
            );
            if (record) await output(() => renderer.record(record));
            if (event.type === "model.delta")
              await output(() => renderer.preview(preview.update(event)));
          }
        } catch (error) {
          await report(error, "observation");
        }
      })();
      let result: AgentRunResult;
      try {
        result = await handle.completed;
      } finally {
        await observing;
        active = undefined;
        preview.clear();
        await output(() => renderer.preview([]));
      }
      settlingCancellation = false;
      phase = "settling";
      lastResult = result;
      for (const record of projectTerminalResult(result, (request) =>
        host.describeInteraction(request),
      ))
        await output(() => renderer.record(record));
      if (result.status === "failed") {
        noteFailure("completion");
        requestStop();
        break;
      }
      if (result.status !== "waiting") break;
      phase = "waiting";
      pendingInteraction = result.interaction;
      await refresh();
      // A cancelled old Run may still settle waiting. Consume this durable interaction
      // with a fresh activation; never reuse the old aborted signal.
      const response = cancelRequested
        ? { type: "cancel" as const, interactionId: result.interaction.id }
        : terminal.mode === "headless" ||
            command.print ||
            command.output === "jsonl" ||
            command.prompt !== undefined ||
            stopping ||
            eof
          ? undefined
          : await answerWaiting(result.interaction);
      if (!response) break;
      if (response.type === "cancel") userCancelledQuery = true;
      settlingCancellation = response.type === "cancel";
      phase = "submitting";
      pendingInteraction = undefined;
      switchFocus({ type: "composer" });
      await refresh();
      if (settlingCancellation) cancelRequested = false;
      handle = await host.resume(result.identity.queryId, response);
      phase = "running";
    }
    pendingInteraction = lastResult?.status === "waiting" ? lastResult.interaction : undefined;
    if (stopping || oneShot || eof || lastResult?.status === "waiting") {
      stopping = true;
      finish();
    }
  }

  function launchQuery(start: () => Promise<AgentRunHandle>): void {
    if (runTask || stopping) return;
    const task = executeQuery(start())
      .catch(async (error: unknown) => {
        await report(error, "completion");
        requestStop();
      })
      .finally(() => {
        runTask = undefined;
        if (stopping || eof) finish();
        else {
          phase = "idle";
          cancelRequested = false;
          switchFocus({ type: "composer" });
          void refresh();
        }
      });
    runTask = task;
  }

  function launchUI(action: () => Promise<void>): void {
    if (uiTask || stopping) return;
    uiTask = action()
      .catch(async (error: unknown) => {
        await report(error, "activation");
        requestStop();
      })
      .finally(() => {
        uiTask = undefined;
        void refresh();
      });
  }

  async function confirmSwitch(): Promise<boolean> {
    const answer = await askText("将新建绑定会话；当前草稿会保留，不迁移旧 Query。输入 yes 确认：");
    return answer?.trim() === "yes";
  }

  async function localCommand(name: string): Promise<void> {
    switch (name) {
      case "help":
      case "hotkeys":
        await output(() => renderer.message(TERMINAL_HELP));
        break;
      case "status":
        await output(() =>
          renderer.message(
            `工作区 ${host.context.workspaceRoot}\n会话 ${host.context.threadId}\n模型 ${host.context.model.label}\n能力 ${host.context.toolsMode}\n数据 ${host.context.dataRoot}\n状态 ${phase}`,
          ),
        );
        break;
      case "exit":
        requestStop();
        break;
      case "paste":
        pasteLines = [];
        notification = "多行输入：独立行 /end 发送，//end 插入 /end；EOF 不发送。";
        break;
      case "new":
        if (await confirmSwitch()) {
          await host.newSession();
          await sessionRecord();
        }
        break;
      case "model": {
        const selected = await askSelection("选择已配置模型", await host.models());
        if (selected && (await confirmSwitch())) {
          await host.newSession({ modelId: selected });
          await sessionRecord();
        }
        break;
      }
      case "tools": {
        const modes: readonly TerminalSelectionItem[] = [
          { id: "none", label: "无业务插件" },
          { id: "read-only", label: "只读文件" },
          { id: "read-write", label: "读写文件（写入需审批）" },
        ];
        const selected = await askSelection("选择能力模式", modes);
        if (selected && (await confirmSwitch())) {
          await host.newSession({ toolsMode: selected as TerminalToolsMode });
          await sessionRecord();
        }
        break;
      }
      case "resume": {
        const sessions = await host.sessions();
        const selected = await askSelection("当前工作区会话", sessions);
        if (selected && (await confirmSwitch())) {
          const session = await host.selectSession(selected);
          await output(() => renderer.history(session.history));
          await sessionRecord();
          if (session.unfinished) launchQuery(() => host.resume(session.unfinished!.queryId));
        }
        break;
      }
      case "tools-output": {
        const selected = await askSelection("安全工具输出", renderer.tools());
        if (selected) await output(() => renderer.selectTool(selected));
        break;
      }
    }
    await refresh();
  }

  async function dispatch(event: TerminalKeyEvent): Promise<void> {
    if (event.generation !== generation || stopping) return;
    const key = event.key;
    if (key.action === "insert") notification = undefined;
    if (
      key.action === "interrupt" &&
      (phase === "running" ||
        phase === "waiting" ||
        phase === "submitting" ||
        phase === "cancelling")
    ) {
      if (settlingCancellation) return;
      cancelRequested = true;
      if (pendingInteraction) resolveFocus(undefined);
      else {
        phase = "cancelling";
        active?.cancel("用户取消");
      }
      await refresh();
      return;
    }
    if (focus.type === "text") {
      if (key.action === "submit") {
        const value = focus.editor.draft.text;
        focus.editor.clear();
        resolveFocus(value);
      } else if (key.action === "escape" || key.action === "interrupt" || key.action === "eof") {
        focus.editor.clear();
        if (key.action === "eof") {
          eof = true;
          requestStop();
        } else resolveFocus(undefined);
      } else focus.editor.edit(key);
      await refresh();
      return;
    }
    if (focus.type === "selector") {
      if (key.action === "eof" && phase === "waiting") {
        eof = true;
        requestStop();
      } else if (key.action === "escape" || key.action === "interrupt" || key.action === "eof")
        resolveFocus(undefined);
      else if (key.action === "up") focus.selector.move(-1);
      else if (key.action === "down") focus.selector.move(1);
      else if (key.action === "insert" && !key.text.includes("\n")) {
        focus.typed += key.text;
        focus.selector.search(focus.typed);
      } else if (key.action === "backspace") {
        focus.typed = Array.from(focus.typed).slice(0, -1).join("");
        focus.selector.search(focus.typed);
      } else if (key.action === "submit" || key.action === "tab") {
        const query = focus.typed.trim();
        const index = /^\d+$/.test(query) ? Number(query) - 1 : -1;
        const selected =
          index >= 0
            ? focus.sourceItems[index]?.id
            : (focus.selector.accept() ?? focus.sourceItems.find((item) => item.id === query)?.id);
        if (selected) resolveFocus(selected);
      }
      await refresh();
      return;
    }
    if (key.action === "toggle-tool") {
      await output(() => renderer.toggleTool());
      return;
    }
    if (key.action === "select-model") {
      if (phase === "idle" && !uiTask) launchUI(() => localCommand("model"));
      else notification = "执行或会话切换中不能切换模型。";
      await refresh();
      return;
    }
    if (key.action === "escape") {
      if (completion) {
        completion = undefined;
        await refresh();
        return;
      }
      if (phase === "running") {
        cancelRequested = true;
        phase = "cancelling";
        active?.cancel("用户取消");
      }
      await refresh();
      return;
    }
    if (key.action === "interrupt") {
      composer.clear(true);
      completion = undefined;
      pasteLines = undefined;
      notification = "草稿已清除，可用输入历史召回。";
      await refresh();
      return;
    }
    if (key.action === "eof") {
      if (!composer.draft.text) requestStop();
      else notification = "草稿非空；Ctrl+D 不会提交或丢弃。";
      await refresh();
      return;
    }
    if (completion && phase === "idle") {
      if (key.action === "up" || key.action === "down") {
        completion.move(key.action === "up" ? -1 : 1);
        await refresh();
        return;
      }
      if (key.action === "tab" || key.action === "submit") {
        const selected = completion.accept() ?? completion.items[0]?.id;
        if (selected) composer.setDraft({ text: `/${selected}`, cursor: selected.length + 1 });
        completion = undefined;
        await refresh();
        return;
      }
    }
    if (key.action === "submit") {
      if (phase !== "idle" || !ready || uiTask) {
        notification = "当前尚不能发送；草稿保留，不排队。";
        await refresh();
        return;
      }
      const text = composer.draft.text;
      if (pasteLines) {
        composer.clear();
        if (text === "/end") {
          const value = pasteLines.join("\n");
          pasteLines = undefined;
          if (value.trim()) {
            await output(() => renderer.user(value));
            launchQuery(() => host.run(value));
          }
        } else pasteLines.push(text === "//end" ? "/end" : text);
        await refresh();
        return;
      }
      if (!text.trim()) return;
      const submitted = parseSubmittedText(text);
      if (submitted.type === "unknown-command") {
        notification = "未知命令；正文以 / 开头请使用 //。";
        await refresh();
        return;
      }
      composer.remember();
      composer.clear();
      if (submitted.type === "command") launchUI(() => localCommand(submitted.name));
      else {
        await output(() => renderer.user(submitted.text));
        launchQuery(() => host.run(submitted.text));
      }
    } else {
      composer.edit(key);
      if (
        phase === "idle" &&
        !pasteLines &&
        key.action !== "newline" &&
        !(key.action === "insert" && key.source === "paste") &&
        /^\/[a-z-]*$/.test(composer.draft.text)
      ) {
        completion = createSelector(
          LOCAL_COMMANDS.filter((name) => name.startsWith(composer.draft.text.slice(1))).map(
            (name) => ({ id: name, label: `/${name}` }),
          ),
          null,
        );
      } else completion = undefined;
    }
    await refresh();
  }

  terminal = createNodeTerminal({
    input: options.input,
    output: options.output,
    error: options.error,
    enabled:
      inputIsTTY && !command.print && command.output !== "jsonl" && command.prompt === undefined,
    noColor: command.noColor,
    onKey(event) {
      events = events
        .then(() => dispatch(event))
        .catch(async (error: unknown) => {
          await report(error, "input");
          requestStop(true);
        });
    },
    onResize() {
      void refresh();
    },
    onEnd() {
      eof = true;
      if (pasteLines) {
        pasteLines = undefined;
        void output(() => renderer.message("未结束的多行草稿未提交。"));
      }
      requestStop();
    },
    onError(error) {
      void report(error, "input").finally(() => requestStop(true));
    },
  });
  if (terminal.mode === "headless") oneShot = true;
  renderer = createTerminalRenderer({
    mode:
      command.output === "jsonl"
        ? "jsonl"
        : command.print || command.prompt !== undefined || terminal.mode === "headless"
          ? "print"
          : terminal.mode,
    color: terminal.color,
    columns: () => terminal.columns,
    rows: () => terminal.rows,
    writeOutput: options.writeOutput,
    writeError: options.writeError,
  });
  const onInterrupt = () => {
    if (settlingCancellation) return;
    if (phase === "starting") {
      cancelRequested = true;
      requestStop(true);
    } else if (
      active ||
      pendingInteraction ||
      phase === "running" ||
      phase === "submitting" ||
      phase === "cancelling"
    ) {
      cancelRequested = true;
      active?.cancel("用户取消");
      if (pendingInteraction) resolveFocus(undefined);
    } else if (oneShot) {
      cancelRequested = true;
      requestStop();
    } else {
      composer.clear(true);
      void refresh();
    }
  };
  const onTerminate = () => {
    terminated = true;
    requestStop(true);
  };
  const onOutputError = (error: unknown) => {
    if (isPipeError(error)) brokenPipe = true;
    else noteFailure("output");
    outputFailed = true;
    requestStop(true);
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  options.output.on("error", onOutputError);
  options.error.on("error", onOutputError);
  terminal.setGeneration(generation);
  try {
    terminal.start();
    await refresh();
    await host.open({
      ...(command.modelId ? { modelId: command.modelId } : {}),
      ...(command.threadId ? { threadId: command.threadId } : {}),
      ...(command.toolsMode ? { toolsMode: command.toolsMode } : {}),
      ...(!oneShot && terminal.mode !== "headless" ? { setup } : {}),
    });
    if (!stopping) {
      ready = true;
      phase = "idle";
      switchFocus({ type: "composer" });
      await sessionRecord();
      await refresh();
      if (command.queryId) launchQuery(() => host.resume(command.queryId!));
      else if (command.prompt !== undefined) launchQuery(() => host.run(command.prompt!));
      else if (oneShot) requestStop();
      await finished;
    }
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "CLI_SETUP_CANCELLED" || (stopping && code === "HOST_CLOSED")) stopping = true;
    else {
      await report(error, ready ? "activation" : "configuration");
      stopping = true;
    }
  } finally {
    stopping = true;
    resolveFocus(undefined);
    if (runTask) await runTask;
    if (uiTask) await uiTask;
    phase = "closing";
    try {
      await host.close();
    } catch (error) {
      await report(error, "close");
    }
    try {
      await terminal.close();
    } catch (error) {
      await report(error, "input");
    }
    await events;
    await output(() => renderer.close());
    let decision: TerminalExitDecision;
    if (failure) decision = { exitCode: 1, reason: "failure", stage: failure };
    else if (brokenPipe) decision = { exitCode: 141, reason: "broken-pipe" };
    else if (terminated || lastResult?.status === "interrupted")
      decision = { exitCode: 143, reason: "host-terminated" };
    else if (lastResult?.status === "waiting") decision = { exitCode: 3, reason: "waiting" };
    else if (
      (cancelRequested && !lastResult) ||
      (oneShot && (cancelRequested || userCancelledQuery) && lastResult?.status === "cancelled")
    )
      decision = { exitCode: 130, reason: "user-cancelled" };
    else
      decision = { exitCode: 0, reason: lastResult?.status === "completed" ? "completed" : "idle" };
    await output(() =>
      renderer.record({
        version: 1,
        type: "process.finished",
        ...decision,
        ...(lastIdentity
          ? {
              lastRun: {
                identity: lastIdentity,
                ...(lastResult ? { status: lastResult.status } : {}),
              },
            }
          : {}),
      }),
    );
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    options.output.removeListener("error", onOutputError);
    options.error.removeListener("error", onOutputError);
    finalCode = failure ? 1 : brokenPipe ? 141 : decision.exitCode;
  }
  return finalCode;
}
